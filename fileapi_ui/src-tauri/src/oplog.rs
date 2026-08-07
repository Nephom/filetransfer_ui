// Shared operation-log writer used by both the Tauri command surface (for
// frontend-originated events) and internal Rust modules (SSH/SFTP) that have
// no IPC round-trip to the frontend. Writing through one function keeps the
// JSON-lines format, secret redaction, and 10MB/3-file rotation identical no
// matter which side of the app produced the entry.
//
// Rust-side callers (e.g. `ssh::authenticate`) cannot read the frontend's
// `desktopSettings.operationLogEnabled`/`operationLogLevel` directly, so the
// frontend mirrors that setting into this module via `set_config` (see the
// `set_operation_log_config` Tauri command) every time it changes. This
// keeps a single log level/enabled flag in sync on both sides without
// threading the setting through every SSH-related command's parameters.

use std::io::Write;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy)]
struct LogConfig {
    enabled: bool,
    level: u8,
}

// Defaults mirror `defaultDesktopSettings` in the frontend (`main.tsx`):
// logging on, DEBUG detail, until the frontend's own effect reports the
// user's actual saved setting shortly after startup.
static LOG_CONFIG: OnceLock<Mutex<LogConfig>> = OnceLock::new();

fn config() -> &'static Mutex<LogConfig> {
    LOG_CONFIG.get_or_init(|| {
        Mutex::new(LogConfig {
            enabled: true,
            level: 0,
        })
    })
}

fn level_rank(level: &str) -> u8 {
    match level.to_ascii_uppercase().as_str() {
        "DEBUG" => 0,
        "INFO" => 1,
        "WARN" => 2,
        "ERROR" => 3,
        _ => 1,
    }
}

/// Mirror the frontend's "Enable operation log" / "Log detail level"
/// settings into this process so Rust-originated log calls (SSH auth
/// attempts, connect/disconnect, drag staging, etc.) respect the same
/// on/off switch and verbosity the user configured in Settings.
pub fn set_config(enabled: bool, level: &str) {
    if let Ok(mut guard) = config().lock() {
        guard.enabled = enabled;
        guard.level = level_rank(level);
    }
}

fn should_write(level: &str) -> bool {
    match config().lock() {
        Ok(guard) => guard.enabled && level_rank(level) >= guard.level,
        Err(_) => true,
    }
}

fn sanitize(value: &str) -> String {
    let normalized = value.replace(['\r', '\n'], " ");
    let lower = normalized.to_ascii_lowercase();
    if ["password", "token", "secret", "private key", "private_key"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return "[REDACTED]".to_string();
    }
    normalized.chars().take(256).collect()
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

/// Append one JSON-lines record to `operations.log`, rotating at 10MB and
/// keeping at most 3 files, matching the frontend-facing behavior this
/// module replaces (see `append_operation_log`). Errors are intentionally
/// swallowed by the public `log()` wrapper below -- a logging failure must
/// never interrupt an SSH/file operation that is otherwise succeeding.
fn write_record(
    level: &str,
    operation: &str,
    status: &str,
    source_label: &str,
    destination_label: &str,
    detail: &str,
) -> Result<(), String> {
    let (_, log_path) = crate::operation_paths()?;
    let record = serde_json::json!({
        "timestamp": timestamp(),
        "level": sanitize(level),
        "operation": sanitize(operation),
        "status": sanitize(status),
        "source": sanitize(source_label),
        "destination": sanitize(destination_label),
        "detail": sanitize(detail),
    });
    let line = format!(
        "{}\n",
        serde_json::to_string(&record).map_err(|error| error.to_string())?
    );
    if std::fs::metadata(&log_path)
        .map(|meta| meta.len())
        .unwrap_or(0)
        + line.len() as u64
        > 10 * 1024 * 1024
    {
        let rotated_two = log_path.with_extension("log.2");
        let rotated_one = log_path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated_two);
        if rotated_one.exists() {
            std::fs::rename(&rotated_one, &rotated_two).map_err(|error| error.to_string())?;
        }
        if log_path.exists() {
            std::fs::rename(&log_path, &rotated_one).map_err(|error| error.to_string())?;
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| error.to_string())?;
    file.write_all(line.as_bytes())
        .map_err(|error| error.to_string())
}

/// Best-effort operation-log write, filtered by the mirrored
/// enabled/level configuration. Never propagates an error: logging must
/// not be able to fail an otherwise-successful (or otherwise-failing, for a
/// different reason) SSH/file operation. Use this for Rust-originated log
/// calls (SSH auth attempts, connect/disconnect, drag staging, etc.) that
/// have not already been filtered by the frontend.
pub fn log(
    level: &str,
    operation: &str,
    status: &str,
    source_label: &str,
    destination_label: &str,
    detail: &str,
) {
    if !should_write(level) {
        return;
    }
    let _ = write_record(level, operation, status, source_label, destination_label, detail);
}

/// Write a record without re-checking the enabled/level filter. Used by the
/// `append_operation_log` Tauri command: the frontend's `writeOperationLog`
/// helper already applied its own enabled/level check before invoking it, so
/// re-filtering here would just risk a startup race (this process's mirrored
/// config may not have synced yet) silently dropping an entry the user
/// already decided to log.
pub fn write(
    level: &str,
    operation: &str,
    status: &str,
    source_label: &str,
    destination_label: &str,
    detail: &str,
) -> Result<(), String> {
    write_record(level, operation, status, source_label, destination_label, detail)
}
