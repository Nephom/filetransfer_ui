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
use std::time::{SystemTime, UNIX_EPOCH};

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
    raw_bytes: u64,
    plain_bytes: u64,
    command_count: u64,
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
    };
    let stats = stats_of(&entry);
    recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?
        .insert(tab_id, entry);
    Ok(stats)
}

/// Append one chunk of freshly-received SSH output to the raw/plain
/// transcripts on disk, flushing immediately so the data is actually durable
/// on disk rather than sitting in an in-process write buffer -- consistent
/// with the "即存即寫" (write-as-received, not accumulate-then-write) goal
/// this module exists for.
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
    entry
        .raw_file
        .write_all(raw_chunk.as_bytes())
        .map_err(|error| error.to_string())?;
    entry.raw_file.flush().map_err(|error| error.to_string())?;
    entry.raw_bytes += raw_chunk.len() as u64;
    entry
        .plain_file
        .write_all(plain_chunk.as_bytes())
        .map_err(|error| error.to_string())?;
    entry
        .plain_file
        .flush()
        .map_err(|error| error.to_string())?;
    entry.plain_bytes += plain_chunk.len() as u64;
    Ok(stats_of(entry))
}

/// Append one detected command line to the commands transcript on disk.
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
    entry
        .commands_file
        .write_all(line.as_bytes())
        .map_err(|error| error.to_string())?;
    entry
        .commands_file
        .flush()
        .map_err(|error| error.to_string())?;
    entry.command_count += 1;
    Ok(stats_of(entry))
}

/// Flush every open file for `tab_id`'s recording to disk. The registry
/// entry (and its temp files) is deliberately kept around after this --
/// "Stop Recording" only means "no more new data is expected", not "discard
/// what was recorded" -- the user can still press "Save Log" afterwards, or
/// close the tab, at which point `finalize_ssh_recording`/
/// `discard_ssh_recording` take over.
pub(crate) fn stop_ssh_recording(tab_id: String) -> Result<(), String> {
    let mut guard = recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?;
    if let Some(entry) = guard.get_mut(&tab_id) {
        entry.raw_file.flush().map_err(|error| error.to_string())?;
        entry
            .plain_file
            .flush()
            .map_err(|error| error.to_string())?;
        entry
            .commands_file
            .flush()
            .map_err(|error| error.to_string())?;
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
    let entry = recordings()
        .lock()
        .map_err(|_| "Recording registry lock was poisoned".to_string())?
        .remove(&tab_id)
        .ok_or_else(|| "There is no completed SSH recording to save.".to_string())?;

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
    use super::civil_from_days;

    #[test]
    fn civil_from_days_matches_known_epoch_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(31), (1970, 2, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }
}
