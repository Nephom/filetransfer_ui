//! Disk-backed SSH terminal recording.
//!
//! Historically, "Start Recording" accumulated the raw/plain/command
//! transcripts as three ever-growing `String`s held in the frontend's React
//! state (see the removed `SshTerminalTab.rawLog`/`.plainLog`/`.commandLog`
//! fields) for the entire duration of the recording, only ever touching disk
//! once -- when the user pressed "Save Log" -- via a single `std::fs::write`
//! of the whole accumulated string. A long-running recording therefore held
//! its entire transcript in the WebView process's JS heap.
//!
//! This module replaces that with an append-as-you-go design: every chunk of
//! SSH output (and every detected command line) is written straight to a
//! small set of on-disk temp files the moment it arrives, so the frontend
//! never needs to hold more than the current chunk in memory. The temp files
//! live under `<install dir>/temp` (a portable-install-friendly location,
//! mirroring `ssh_storage_dir()`'s "next to the executable" preference for
//! SSH keys), falling back to `~/.nFterm/temp` when the install directory
//! itself is not writable (e.g. installed under `/usr/bin` or
//! `Program Files`).
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Client-disk write amplification guard: a high-output SSH session (a
// noisy build, `tail -f`, ...) can emit many `append_ssh_recording` IPC
// calls per second, and this module previously issued one real
// `write_all` + `flush` syscall pair *per call* -- i.e. one guaranteed
// physical disk write per incoming chunk. On the kind of always-on
// desktop/laptop SSDs this client typically runs on, that turns a single
// long recording session into thousands of small physical writes, which
// measurably shortens SSD/flash write-endurance over the device's
// lifetime for no durability benefit most users need (an unattended crash
// losing the last fraction of a second of terminal scrollback is an
// acceptable trade for not hammering the disk on every incoming TCP
// chunk). Chunks are now accumulated in a small in-process buffer and only
// actually written+flushed to disk once `RECORDING_FLUSH_BYTES` has
// accumulated or `RECORDING_FLUSH_INTERVAL` has elapsed since the last
// flush, whichever comes first -- collapsing many small physical writes
// into far fewer, larger ones. `stop_ssh_recording`/`discard_ssh_recording`/
// `finalize_ssh_recording` all force an unconditional flush first, so no
// data is ever lost on a normal stop/save/close; only an abrupt crash or
// force-quit can lose the still-buffered tail (bounded to at most
// `RECORDING_FLUSH_BYTES` bytes or `RECORDING_FLUSH_INTERVAL` of output),
// which is the deliberate trade-off this buffering makes. The frontend's
// `RecordingStats` byte/line counters are unaffected -- they still count
// every logical byte/command the moment it arrives, buffered or not, so
// the UI's "how much has been recorded" display stays accurate even
// between physical flushes.
const RECORDING_FLUSH_BYTES: usize = 64 * 1024;
const RECORDING_FLUSH_INTERVAL: Duration = Duration::from_secs(2);

/// Resolve `<install dir>/temp`: a `temp` directory next to the running
/// executable, used so portable installations keep their (transient)
/// recording state with the application instead of scattering it into the
/// OS's own temp directory or an app-data directory the user cannot easily
/// find. Installs under a protected directory (e.g. `Program Files`,
/// `/usr/bin`) fall back to `~/.nFterm/temp`, matching `ssh_storage_dir()`'s
/// existing writability-probe pattern for SSH keys.
pub(crate) fn recording_temp_dir() -> Result<PathBuf, String> {
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            let candidate = parent.join("temp");
            if fs::create_dir_all(&candidate).is_ok() {
                let probe = candidate.join(format!(".nfterm-write-test-{}", std::process::id()));
                let writable = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&probe)
                    .is_ok();
                let _ = fs::remove_file(&probe);
                if writable {
                    return Ok(candidate);
                }
            }
        }
    }
    let fallback = crate::local_home()?.join(".nFterm").join("temp");
    fs::create_dir_all(&fallback).map_err(|error| error.to_string())?;
    Ok(fallback)
}

/// One tab's in-progress recording: open file handles for the raw (with
/// ANSI escapes), plain (stripped), and commands transcripts, plus the
/// running byte/line counters returned to the frontend so it never has to
/// re-read its own files just to know "is there anything recorded yet".
struct RecordingEntry {
    raw_path: PathBuf,
    plain_path: PathBuf,
    commands_path: PathBuf,
    raw_file: File,
    plain_file: File,
    commands_file: File,
    // Running logical totals -- incremented the instant a chunk arrives,
    // regardless of whether it has been physically flushed to disk yet, so
    // `RecordingStats` (and thus the frontend's "has anything been
    // recorded?"/byte-count UI) is always accurate.
    raw_bytes: u64,
    plain_bytes: u64,
    command_count: u64,
    // Not-yet-flushed bytes, written to their respective files (and the
    // buffers cleared) once `maybe_flush` decides a flush is due. Kept as
    // `Vec<u8>` rather than `String` since the raw stream can in principle
    // straddle a multi-byte UTF-8 boundary between two chunks; only ever
    // written back out as raw bytes, never re-decoded as text.
    raw_buffer: Vec<u8>,
    plain_buffer: Vec<u8>,
    commands_buffer: Vec<u8>,
    last_flush: Instant,
}

/// Physically writes and flushes any buffered bytes for `entry`, then
/// resets its flush timer -- used both by the byte/time-threshold check in
/// `maybe_flush` (forced) and directly by callers that must guarantee
/// durability right now (`stop_ssh_recording`, `discard_ssh_recording`'s
/// implicit drop, `finalize_ssh_recording`).
fn flush_entry_now(entry: &mut RecordingEntry) -> Result<(), String> {
    if !entry.raw_buffer.is_empty() {
        entry
            .raw_file
            .write_all(&entry.raw_buffer)
            .map_err(|error| error.to_string())?;
        entry.raw_buffer.clear();
    }
    if !entry.plain_buffer.is_empty() {
        entry
            .plain_file
            .write_all(&entry.plain_buffer)
            .map_err(|error| error.to_string())?;
        entry.plain_buffer.clear();
    }
    if !entry.commands_buffer.is_empty() {
        entry
            .commands_file
            .write_all(&entry.commands_buffer)
            .map_err(|error| error.to_string())?;
        entry.commands_buffer.clear();
    }
    entry.raw_file.flush().map_err(|error| error.to_string())?;
    entry
        .plain_file
        .flush()
        .map_err(|error| error.to_string())?;
    entry
        .commands_file
        .flush()
        .map_err(|error| error.to_string())?;
    entry.last_flush = Instant::now();
    Ok(())
}

/// Flushes `entry` only once `RECORDING_FLUSH_BYTES` of combined buffered
/// data has accumulated or `RECORDING_FLUSH_INTERVAL` has elapsed since the
/// last flush -- the throttle described at this module's top. All three
/// transcripts are flushed together (even if only one buffer crossed the
/// threshold) so they stay time-synchronized on disk and this stays a
/// single cheap size/time check per call rather than three independent
/// ones.
fn maybe_flush(entry: &mut RecordingEntry) -> Result<(), String> {
    let buffered = entry.raw_buffer.len() + entry.plain_buffer.len() + entry.commands_buffer.len();
    if buffered == 0 {
        return Ok(());
    }
    if buffered >= RECORDING_FLUSH_BYTES || entry.last_flush.elapsed() >= RECORDING_FLUSH_INTERVAL {
        flush_entry_now(entry)?;
    }
    Ok(())
}

static RECORDINGS: OnceLock<Mutex<HashMap<String, RecordingEntry>>> = OnceLock::new();

fn recordings() -> &'static Mutex<HashMap<String, RecordingEntry>> {
    RECORDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingStats {
    pub raw_bytes: u64,
    pub plain_bytes: u64,
    pub command_count: u64,
}

/// Tab ids are frontend-generated UUIDs, but this sanitizes them the same
/// defensive way `save_ssh_logs` always sanitized its (arbitrary,
/// user-typed) profile name, since these ids end up as filename components.
fn sanitize_id(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "tab".to_string()
    } else {
        sanitized
    }
}

fn unique_timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn remove_entry_files(entry: &RecordingEntry) {
    let _ = fs::remove_file(&entry.raw_path);
    let _ = fs::remove_file(&entry.plain_path);
    let _ = fs::remove_file(&entry.commands_path);
}

fn stats_of(entry: &RecordingEntry) -> RecordingStats {
    RecordingStats {
        raw_bytes: entry.raw_bytes,
        plain_bytes: entry.plain_bytes,
        command_count: entry.command_count,
    }
}

/// Start a new on-disk recording for `tab_id`, seeding the raw/plain
/// transcripts with `raw_seed`/`plain_seed` -- the terminal's scrollback
/// accumulated *before* the user pressed "Start Recording"
/// (`SshTerminalTab.output`/its ANSI-stripped form), so a recording started
/// against an already-open session captures what was already on screen
/// instead of only what arrives from this point on. Command detection has no
/// equivalent history to seed from (past keystrokes were never retained),
/// so the commands transcript always starts empty.
///
/// Any previous (unfinished, unsaved) recording still registered for this
/// tab id is discarded first -- starting a new recording always begins a
/// fresh transcript, matching the previous in-memory behavior of resetting
/// `rawLog`/`plainLog`/`commandLog` to `""`.
pub(crate) fn start_ssh_recording(
    tab_id: String,
    raw_seed: String,
    plain_seed: String,
) -> Result<RecordingStats, String> {
    discard_ssh_recording(tab_id.clone())?;

    let directory = recording_temp_dir()?;
    let safe_id = sanitize_id(&tab_id);
    let stem = directory.join(format!("{safe_id}-{}", unique_timestamp()));
    let raw_path = stem.with_extension("raw.tmp");
    let plain_path = stem.with_extension("plain.tmp");
    let commands_path = stem.with_extension("commands.tmp");

    let mut raw_file = File::create(&raw_path).map_err(|error| error.to_string())?;
    let mut plain_file = File::create(&plain_path).map_err(|error| error.to_string())?;
    let commands_file = File::create(&commands_path).map_err(|error| error.to_string())?;

    raw_file
        .write_all(raw_seed.as_bytes())
        .map_err(|error| error.to_string())?;
    raw_file.flush().map_err(|error| error.to_string())?;
    plain_file
        .write_all(plain_seed.as_bytes())
        .map_err(|error| error.to_string())?;
    plain_file.flush().map_err(|error| error.to_string())?;

    let entry = RecordingEntry {
        raw_path,
        plain_path,
        commands_path,
        raw_file,
        plain_file,
        commands_file,
        raw_bytes: raw_seed.len() as u64,
        plain_bytes: plain_seed.len() as u64,
        command_count: 0,
        raw_buffer: Vec::new(),
        plain_buffer: Vec::new(),
        commands_buffer: Vec::new(),
        last_flush: Instant::now(),
    };
    let stats = stats_of(&entry);
    recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?
        .insert(tab_id, entry);
    Ok(stats)
}

/// Append one chunk of freshly-received SSH output to the raw/plain
/// transcripts. The chunk is durably counted in `RecordingStats`
/// immediately, but only physically written+flushed to disk once
/// `maybe_flush`'s byte/time threshold is due -- see this module's top
/// comment and `RECORDING_FLUSH_BYTES`/`RECORDING_FLUSH_INTERVAL`.
pub(crate) fn append_ssh_recording(
    tab_id: String,
    raw_chunk: String,
    plain_chunk: String,
) -> Result<RecordingStats, String> {
    let mut guard = recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?;
    let entry = guard
        .get_mut(&tab_id)
        .ok_or_else(|| "No recording is in progress for this terminal tab".to_string())?;
    entry.raw_buffer.extend_from_slice(raw_chunk.as_bytes());
    entry.raw_bytes += raw_chunk.len() as u64;
    entry.plain_buffer.extend_from_slice(plain_chunk.as_bytes());
    entry.plain_bytes += plain_chunk.len() as u64;
    maybe_flush(entry)?;
    Ok(stats_of(entry))
}

/// Append one detected command line to the commands transcript, subject to
/// the same buffered/throttled flush as `append_ssh_recording`.
pub(crate) fn append_ssh_recording_command(
    tab_id: String,
    line: String,
) -> Result<RecordingStats, String> {
    let mut guard = recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?;
    let entry = guard
        .get_mut(&tab_id)
        .ok_or_else(|| "No recording is in progress for this terminal tab".to_string())?;
    entry.commands_buffer.extend_from_slice(line.as_bytes());
    entry.command_count += 1;
    maybe_flush(entry)?;
    Ok(stats_of(entry))
}

/// Force an unconditional flush of every buffered byte for `tab_id`'s
/// recording to disk, bypassing the byte/time throttle -- "Stop Recording"
/// must never leave any already-received data sitting unflushed in memory.
/// The registry entry (and its temp files) is deliberately kept around
/// after this -- "Stop Recording" only means "no more new data is
/// expected", not "discard what was recorded" -- the user can still press
/// "Save Log" afterwards, or close the tab, at which point
/// `finalize_ssh_recording`/`discard_ssh_recording` take over.
pub(crate) fn stop_ssh_recording(tab_id: String) -> Result<(), String> {
    let mut guard = recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?;
    if let Some(entry) = guard.get_mut(&tab_id) {
        flush_entry_now(entry)?;
    }
    Ok(())
}

/// Abandon `tab_id`'s recording: drop its open file handles and delete its
/// temp files. Used both when the user explicitly discards an unsaved
/// recording (e.g. closing its terminal tab without saving) and internally
/// by `start_ssh_recording` to clear out any stale entry before starting a
/// fresh one. A no-op (not an error) if no recording is registered for this
/// tab id.
pub(crate) fn discard_ssh_recording(tab_id: String) -> Result<(), String> {
    let entry = recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?
        .remove(&tab_id);
    if let Some(entry) = entry {
        remove_entry_files(&entry);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshLogPaths {
    pub raw: String,
    pub plain: String,
    pub commands: String,
    pub metadata: String,
}

/// Finalize `tab_id`'s recording: copy its temp files to `destination_path`
/// under `profile_name`, write a metadata JSON file describing the
/// recording (computed from the actual files -- never from a
/// frontend-supplied byte count that could have raced an in-flight append),
/// then delete the temp files. Uses `fs::copy` + `fs::remove_file` rather
/// than `fs::rename`, since the temp directory and the user-chosen
/// destination are not guaranteed to be on the same filesystem/drive (a
/// cross-device rename would otherwise fail outright).
pub(crate) fn finalize_ssh_recording(
    tab_id: String,
    profile_name: String,
    host: String,
    destination_directory: &Path,
    started_at_iso: Option<String>,
) -> Result<SshLogPaths, String> {
    let mut entry = recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?
        .remove(&tab_id)
        .ok_or_else(|| "There is no completed SSH recording to save.".to_string())?;
    // Defensive: the normal flow always calls `stop_ssh_recording` (which
    // force-flushes) before this, but finalize must never copy a file that
    // could still have unflushed buffered bytes sitting in memory,
    // regardless of call order.
    flush_entry_now(&mut entry)?;

    let safe_name: String = profile_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    let safe_name = if safe_name.is_empty() {
        "ssh-session".to_string()
    } else {
        safe_name
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    let finalize_result = (|| -> Result<SshLogPaths, String> {
        fs::create_dir_all(destination_directory).map_err(|error| error.to_string())?;
        let stem = destination_directory.join(format!("{safe_name}-{timestamp}"));
        let raw_path = stem.with_extension("raw.log");
        let plain_path = stem.with_extension("txt");
        let commands_path = stem.with_extension("commands.log");
        let metadata_path = stem.with_extension("meta.json");

        fs::copy(&entry.raw_path, &raw_path).map_err(|error| error.to_string())?;
        fs::copy(&entry.plain_path, &plain_path).map_err(|error| error.to_string())?;
        fs::copy(&entry.commands_path, &commands_path).map_err(|error| error.to_string())?;

        let metadata = serde_json::json!({
            "profileName": profile_name,
            "host": host,
            "startedAt": started_at_iso,
            "endedAt": chrono_now_iso(),
            "rawBytes": entry.raw_bytes,
            "plainBytes": entry.plain_bytes,
            "commandCount": entry.command_count,
            "files": ["raw.log", "txt", "commands.log", "meta.json"],
        });
        fs::write(
            &metadata_path,
            serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

        Ok(SshLogPaths {
            raw: raw_path.display().to_string(),
            plain: plain_path.display().to_string(),
            commands: commands_path.display().to_string(),
            metadata: metadata_path.display().to_string(),
        })
    })();

    // Whether finalizing succeeded or failed, the temp files themselves are
    // done being useful: on success they've been copied to their permanent
    // home, and on failure they'd otherwise leak into `<install dir>/temp`
    // forever since `tab_id` is no longer registered for any future
    // discard/save call to clean up.
    remove_entry_files(&entry);
    finalize_result
}

/// Best-effort ISO-8601 timestamp without pulling in the `chrono` crate just
/// for this: `finalize_ssh_recording`'s metadata only needs a
/// human-readable "when did saving happen" marker, not calendar-accurate
/// formatting, so a manual UTC breakdown from `SystemTime` is enough.
fn chrono_now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_seconds = now.as_secs();
    let millis = now.subsec_millis();
    let days = total_seconds / 86_400;
    let seconds_of_day = total_seconds % 86_400;
    let (hours, minutes, seconds) = (
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60,
    );
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
    )
}

/// Howard Hinnant's `civil_from_days`: converts a day count since the Unix
/// epoch (1970-01-01) into a proleptic-Gregorian (year, month, day) tuple,
/// valid for every date this application could ever realistically produce.
/// Pure integer arithmetic, no external dependency required.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if month <= 2 { y + 1 } else { y };
    (year, month, day)
}

/// Wipe `<install dir>/temp` on application startup. Every entry in
/// `RECORDINGS` only ever exists for the lifetime of the running process --
/// a fresh launch always starts with an empty registry -- so any file left
/// over in the temp directory at startup can only be an orphan from a
/// previous run that ended (crashed, was force-quit, or the user discarded a
/// tab) without going through `finalize_ssh_recording`/
/// `discard_ssh_recording`'s normal cleanup. Per product decision, unsaved
/// recordings are not worth persisting across app restarts, so this simply
/// clears them out rather than trying to recover or prompt about them.
pub(crate) fn cleanup_stale_recording_temp_files() {
    let Ok(directory) = recording_temp_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&directory) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = fs::remove_file(entry.path());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_ssh_recording, civil_from_days, discard_ssh_recording, start_ssh_recording,
        stop_ssh_recording, RECORDING_FLUSH_BYTES,
    };
    use std::fs;

    #[test]
    fn civil_from_days_matches_known_epoch_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(31), (1970, 2, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    // Every raw/plain temp file path this test starts is deterministic
    // (`<tab_id>-<timestamp>.<kind>.tmp` under `recording_temp_dir()`), so
    // this reads it straight from the registry rather than recomputing the
    // path -- exercised indirectly through `stats_of`'s byte counters and a
    // direct disk-size check below.
    fn raw_temp_path_bytes_on_disk(tab_id: &str) -> u64 {
        let guard = super::recordings().lock().expect("recording registry lock should not be poisoned");
        let entry = guard.get(tab_id).expect("a recording should be registered for this tab id in this test");
        fs::metadata(&entry.raw_path).map(|metadata| metadata.len()).unwrap_or(0)
    }

    #[test]
    fn small_chunks_stay_buffered_on_disk_below_the_flush_threshold() {
        let tab_id = format!("test-buffered-{}", super::unique_timestamp());
        let stats = start_ssh_recording(tab_id.clone(), String::new(), String::new())
            .expect("starting a recording should succeed");
        assert_eq!(stats.raw_bytes, 0);

        let stats = append_ssh_recording(tab_id.clone(), "hello".to_string(), "hello".to_string())
            .expect("appending a small chunk should succeed");
        // The logical counter reflects the chunk immediately...
        assert_eq!(stats.raw_bytes, 5);
        // ...but nothing this small should have crossed the byte/time
        // threshold yet, so the file on disk should still be empty (the
        // chunk is sitting in the in-process buffer, not yet flushed).
        assert_eq!(raw_temp_path_bytes_on_disk(&tab_id), 0);

        discard_ssh_recording(tab_id).expect("discarding a recording should succeed");
    }

    #[test]
    fn crossing_the_byte_threshold_flushes_to_disk() {
        let tab_id = format!("test-threshold-{}", super::unique_timestamp());
        start_ssh_recording(tab_id.clone(), String::new(), String::new())
            .expect("starting a recording should succeed");

        let big_chunk = "x".repeat(RECORDING_FLUSH_BYTES + 1);
        let stats = append_ssh_recording(tab_id.clone(), big_chunk.clone(), big_chunk.clone())
            .expect("appending a chunk past the threshold should succeed");
        assert_eq!(stats.raw_bytes, big_chunk.len() as u64);
        assert_eq!(raw_temp_path_bytes_on_disk(&tab_id), big_chunk.len() as u64);

        discard_ssh_recording(tab_id).expect("discarding a recording should succeed");
    }

    #[test]
    fn stop_recording_force_flushes_any_still_buffered_bytes() {
        let tab_id = format!("test-stop-flush-{}", super::unique_timestamp());
        start_ssh_recording(tab_id.clone(), String::new(), String::new())
            .expect("starting a recording should succeed");

        append_ssh_recording(tab_id.clone(), "small".to_string(), "small".to_string())
            .expect("appending a small chunk should succeed");
        assert_eq!(raw_temp_path_bytes_on_disk(&tab_id), 0);

        stop_ssh_recording(tab_id.clone()).expect("stopping a recording should succeed");
        assert_eq!(raw_temp_path_bytes_on_disk(&tab_id), 5);

        discard_ssh_recording(tab_id).expect("discarding a recording should succeed");
    }
}
