#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod oplog;
mod ssh;

use reqwest::{multipart, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Instant;
use tauri::Emitter;
use tokio::io::{AsyncRead, ReadBuf};

static CANCELLED_TRANSFER_IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_transfer_ids() -> &'static Mutex<HashSet<String>> {
    CANCELLED_TRANSFER_IDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_transfer_cancelled(id: &str) -> bool {
    cancelled_transfer_ids()
        .lock()
        .map(|ids| ids.contains(id))
        .unwrap_or(true)
}

#[tauri::command]
fn cancel_transfer(transfer_id: String) -> Result<(), String> {
    cancelled_transfer_ids()
        .lock()
        .map_err(|error| error.to_string())?
        .insert(transfer_id);
    Ok(())
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: Vec<u8>,
}

// Emitted from download_to_disk while streaming a single-file (or archive)
// download, so the Transfer Queue can show byte-level progress instead of a
// static "Downloading..." label. `transfer_id` matches the frontend's
// TransferQueueItem.id so the listener can route the event to the right
// queue row. Emission is throttled to once per 200ms so a fast local
// network / big file doesn't flood the event loop.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    transfer_id: String,
    bytes_completed: u64,
    bytes_total: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProgressEvent {
    transfer_id: String,
    bytes_completed: u64,
    bytes_total: u64,
}

struct UploadProgressReader<R> {
    inner: R,
    app: tauri::AppHandle,
    transfer_id: String,
    completed_before: u64,
    completed: u64,
    total: u64,
    last_emit: Instant,
}

impl<R: AsyncRead + Unpin> AsyncRead for UploadProgressReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if is_transfer_cancelled(&self.transfer_id) {
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Transfer cancelled",
            )));
        }
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        if let Poll::Ready(Ok(())) = &result {
            let read = (buffer.filled().len() - before) as u64;
            self.completed += read;
            if read > 0 && self.last_emit.elapsed().as_millis() >= 200 {
                let _ = self.app.emit(
                    "upload-progress",
                    UploadProgressEvent {
                        transfer_id: self.transfer_id.clone(),
                        bytes_completed: self.completed_before + self.completed,
                        bytes_total: self.total,
                    },
                );
                self.last_emit = Instant::now();
            }
        }
        result
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadSummary {
    files: usize,
    directories: usize,
    total_size: u64,
    sources: Vec<UploadSource>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadSource {
    path: String,
    size: u64,
    modified: u128,
}

fn upload_source_snapshot(path: &Path) -> Result<UploadSource, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    Ok(UploadSource {
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        modified,
    })
}

fn validate_upload_sources(expected: &[UploadSource]) -> Result<(), String> {
    for source in expected {
        let current = upload_source_snapshot(Path::new(&source.path))?;
        if current.size != source.size || current.modified != source.modified {
            return Err(format!(
                "Upload source changed before transfer: {}",
                source.path
            ));
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFile {
    name: String,
    path: String,
    is_directory: bool,
    size: u64,
    modified: u128,
}

#[derive(Serialize)]
struct LocalDirectory {
    path: String,
    files: Vec<LocalFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshLogPaths {
    raw: String,
    plain: String,
    commands: String,
    metadata: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationStorageInfo {
    history_path: String,
    log_path: String,
    history_bytes: u64,
    log_bytes: u64,
    log_files: Vec<String>,
}

fn operation_storage_directory() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("FILEAPI_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    // Renamed from the legacy ".fileapi-desktop" as part of the nFterm
    // rebrand. Upgrading users keep their history by running
    // upgrade_tools/migrate-desktop-data.ps1, which copies the legacy
    // directory over before the app is relaunched under the new name.
    Ok(local_home()?.join(".nFterm"))
}

fn operation_paths() -> Result<(PathBuf, PathBuf), String> {
    let directory = operation_storage_directory()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok((
        directory.join("undo-history.json"),
        directory.join("operations.log"),
    ))
}

fn collect_upload_path(
    path: &Path,
    relative_path: String,
    files: &mut Vec<(PathBuf, String)>,
    directories: &mut Vec<String>,
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Unable to inspect upload path '{}': {error}",
            path.display()
        )
    })?;
    if metadata.is_dir() {
        directories.push(relative_path.clone());
        let mut children = std::fs::read_dir(path)
            .map_err(|error| {
                format!(
                    "Unable to read upload directory '{}': {error}",
                    path.display()
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                format!(
                    "Unable to enumerate upload directory '{}': {error}",
                    path.display()
                )
            })?;
        children.sort_by_key(|entry| entry.path());
        for child in children {
            let name = child
                .file_name()
                .to_str()
                .ok_or_else(|| "Upload path contains a non-UTF-8 filename".to_string())?
                .to_string();
            collect_upload_path(
                &child.path(),
                format!("{relative_path}/{name}"),
                files,
                directories,
            )?;
        }
    } else if metadata.is_file() {
        files.push((path.to_path_buf(), relative_path));
    } else {
        return Err(format!("Unsupported upload path: {}", path.display()));
    }
    Ok(())
}

fn collect_upload_paths(paths: &[String]) -> Result<(Vec<(PathBuf, String)>, Vec<String>), String> {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for path in paths {
        let input = Path::new(path);
        if input
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(format!("Upload path must not contain '..': {path}"));
        }
        let source = if input.is_absolute() {
            input.to_path_buf()
        } else {
            // LOCAL pane entries are HOME-relative; file-picker entries are
            // absolute. Resolve only the former against the same HOME jail
            // used by local_list_directory.
            local_home()?.join(input)
        };
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "Invalid upload filename".to_string())?;
        collect_upload_path(&source, name.to_string(), &mut files, &mut directories)?;
    }
    Ok((files, directories))
}

/// `error.to_string()` on a `reqwest::Error` only prints its own top-level
/// message (e.g. just "builder error" for a malformed URL or an invalid
/// header value) -- the actual reason lives in `.source()` and is silently
/// dropped unless it is walked explicitly. That leaves a genuinely useless
/// message on screen and in the operation log with no way to diagnose what
/// actually went wrong, so every reqwest-facing `.map_err()` below chains
/// the full `source()` chain into the message instead of a bare `to_string()`.
fn describe_error<E: std::error::Error>(error: E) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    message
}

fn api_client(ignore_tls_errors: bool) -> Result<Client, String> {
    Client::builder()
        // This is intentionally opt-in for private, self-signed servers.
        .danger_accept_invalid_certs(ignore_tls_errors)
        .danger_accept_invalid_hostnames(ignore_tls_errors)
        .build()
        .map_err(describe_error)
}

fn apply_headers(
    request: reqwest::RequestBuilder,
    headers: Vec<(String, String)>,
) -> reqwest::RequestBuilder {
    headers.into_iter().fold(request, |request, (name, value)| {
        request.header(name, value)
    })
}

async fn response_from(response: reqwest::Response) -> Result<ApiResponse, String> {
    let status = response.status().as_u16();
    let body = response.bytes().await.map_err(describe_error)?.to_vec();
    Ok(ApiResponse { status, body })
}

#[tauri::command]
async fn api_request(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    ignore_tls_errors: bool,
) -> Result<ApiResponse, String> {
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(api_client(ignore_tls_errors)?.request(method, url), headers);
    let request = if let Some(body) = body {
        request.body(body)
    } else {
        request
    };
    response_from(request.send().await.map_err(describe_error)?).await
}

#[tauri::command]
async fn pick_upload_files() -> Result<Vec<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .pick_files()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|file| file.path().display().to_string())
        .collect())
}

#[tauri::command]
async fn pick_local_directory(path: String) -> Result<Option<String>, String> {
    let initial_directory = resolve_local_download_destination(&path)?;
    let selected = rfd::AsyncFileDialog::new()
        .set_directory(initial_directory)
        .pick_folder()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected_path = canonicalize(selected.path())?;
    let home = canonicalize(local_home()?)?;
    if selected_path.starts_with(&home) {
        return Ok(Some(
            selected_path
                .strip_prefix(&home)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
        ));
    }
    if is_elevated() {
        return Ok(Some(selected_path.to_string_lossy().replace('\\', "/")));
    }
    Err("Selected directory must remain inside the current user's home directory".to_string())
}

/// Build the `name_(n).ext` candidate for the n-th collision-avoidance
/// attempt on `name` (e.g. `video.mp4` -> `video_(1).mp4` -> `video_(2).mp4`).
/// Matching Windows/macOS Explorer's own "keep both files" convention, this
/// is applied automatically -- never by prompting the user -- everywhere a
/// move/rename/upload/download could otherwise silently overwrite an
/// unrelated file that happens to share its destination name.
pub fn dedupe_candidate_name(name: &str, attempt: u32) -> String {
    let path = Path::new(name);
    let value = path.to_string_lossy();
    if let Some(stem) = value
        .strip_suffix(".tar.gz")
        .or_else(|| value.strip_suffix(".TAR.GZ"))
    {
        return format!("{stem}_({attempt}).tar.gz");
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("{stem}_({attempt}).{extension}"),
        None => format!("{stem}_({attempt})"),
    }
}

pub fn sanitize_archive_name(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '-'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_end_matches([' ', '.'])
        .to_string();
    if sanitized.is_empty() {
        "nFterm".to_string()
    } else {
        sanitized
    }
}

fn create_unique_file(path: &Path) -> Result<(PathBuf, std::fs::File), String> {
    let mut candidate = path.to_path_buf();
    let mut attempt = 1;
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate =
                    path.parent()
                        .unwrap_or_else(|| Path::new(""))
                        .join(dedupe_candidate_name(
                            path.file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("download"),
                            attempt,
                        ));
                attempt += 1;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn content_disposition_filename(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let value = headers
        .get(reqwest::header::CONTENT_DISPOSITION)?
        .to_str()
        .ok()?;
    let mut fallback = None;
    for part in value.split(';').map(str::trim) {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        let candidate = raw.trim().trim_matches('"');
        if key.eq_ignore_ascii_case("filename*") {
            let encoded = candidate.strip_prefix("UTF-8''").unwrap_or(candidate);
            return Some(percent_decode(encoded));
        }
        if key.eq_ignore_ascii_case("filename") {
            fallback = Some(candidate.to_string());
        }
    }
    fallback
}

fn local_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to locate the local home directory".to_string())
}

/// `Path::canonicalize()` resolves symlinks and returns an absolute path,
/// but on Windows it prepends the "verbatim" `\\?\` prefix (e.g.
/// `\\?\C:\Users\Administrator`) that only the raw Win32 API understands.
/// Every canonicalized path in this file is either sent back to the
/// frontend as a plain string or fed back into `Path::new` after this
/// file's own `\` -> `/` conversion -- and once that happens, the verbatim
/// prefix is no longer recognised as such and instead looks like a
/// malformed UNC path, so the next filesystem call on it fails with Windows
/// os error 123 ("The filename, directory, or volume label syntax is
/// incorrect"). This is what broke an elevated session's "../" navigation
/// up out of HOME on Windows (issue #159): `local_home_path()` canonicalized
/// HOME to a verbatim path, and stepping up from it round-tripped that
/// straight back through `Path::new`. Stripping the prefix immediately
/// after every canonicalize() call keeps paths in the ordinary `C:\...`
/// form end-to-end. A no-op on non-Windows paths.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    match path.to_str() {
        Some(text) => {
            if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
                PathBuf::from(format!(r"\\{rest}"))
            } else if let Some(rest) = text.strip_prefix(r"\\?\") {
                PathBuf::from(rest)
            } else {
                path
            }
        }
        None => path,
    }
}

/// `std::path::Path::canonicalize()`, with the Windows verbatim prefix
/// stripped (see `strip_verbatim_prefix`) and the error already converted
/// to the `String` this file's Tauri commands return. Use this everywhere
/// instead of calling `.canonicalize()` directly.
fn canonicalize(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    path.as_ref()
        .canonicalize()
        .map(strip_verbatim_prefix)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod verbatim_prefix_tests {
    use super::strip_verbatim_prefix;
    use std::path::PathBuf;

    #[test]
    fn strips_the_plain_verbatim_drive_prefix() {
        let input = PathBuf::from(r"\\?\C:\Users\Administrator");
        assert_eq!(
            strip_verbatim_prefix(input),
            PathBuf::from(r"C:\Users\Administrator")
        );
    }

    #[test]
    fn rewrites_the_verbatim_unc_prefix_to_a_plain_unc_path() {
        let input = PathBuf::from(r"\\?\UNC\server\share\folder");
        assert_eq!(
            strip_verbatim_prefix(input),
            PathBuf::from(r"\\server\share\folder")
        );
    }

    #[test]
    fn leaves_an_ordinary_path_unchanged() {
        let input = PathBuf::from(r"C:\Users\Administrator");
        assert_eq!(strip_verbatim_prefix(input.clone()), input);
    }

    #[test]
    fn leaves_a_unix_style_path_unchanged() {
        let input = PathBuf::from("/home/user/project");
        assert_eq!(strip_verbatim_prefix(input.clone()), input);
    }
}

/// HOME's own real, absolute filesystem path. The frontend's LOCAL pane
/// otherwise only ever deals in HOME-relative path strings ("" = HOME
/// itself); an elevated session needs this to know where to go when
/// stepping "up" past HOME towards the real root.
#[tauri::command]
fn local_home_path() -> Result<String, String> {
    Ok(canonicalize(local_home()?)?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// Whether the desktop app is currently running with elevated privileges
/// (root on Unix, an elevated Administrator token on Windows). This is the
/// gate for lifting the "stay inside the user's home directory" jail that
/// `resolve_local_transfer_path`/`resolve_local_new_path`/
/// `local_list_directory` otherwise enforce -- a non-elevated process must
/// never be trusted to browse or move files outside of HOME, so every path
/// resolver below re-checks this itself rather than trusting a flag the
/// frontend could pass in.
#[cfg(unix)]
fn is_elevated() -> bool {
    extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() == 0 }
}

#[cfg(windows)]
fn is_elevated() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

#[tauri::command]
fn is_local_elevated() -> bool {
    is_elevated()
}

/// The real filesystem roots a privileged user can browse from: the drive
/// letters on Windows, or just "/" everywhere else. Only meaningful (and
/// only returned) when `is_elevated()` is true -- a non-elevated caller gets
/// an empty list, since it can never navigate above HOME anyway.
#[cfg(windows)]
fn local_roots() -> Vec<String> {
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).is_dir() {
                Some(drive.replace('\\', "/"))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(not(windows))]
fn local_roots() -> Vec<String> {
    vec!["/".to_string()]
}

#[tauri::command]
fn list_local_roots() -> Vec<String> {
    if is_elevated() {
        local_roots()
    } else {
        Vec::new()
    }
}

fn resolve_local_transfer_path(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if input
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local transfer path must not contain '..'".to_string());
    }
    if input.is_absolute() {
        if !is_elevated() {
            return Err(
                "Local transfer path must remain inside the current user's home directory"
                    .to_string(),
            );
        }
        return canonicalize(input);
    }
    let home = canonicalize(local_home()?)?;
    let candidate = home.join(input);
    let resolved = canonicalize(&candidate)?;
    if !resolved.starts_with(&home) {
        return Err(
            "Local transfer path must remain inside the current user's home directory".to_string(),
        );
    }
    Ok(resolved)
}

/// Resolve a download *destination* directory, creating it (and any missing
/// parents) first if it does not already exist yet. This differs from
/// `resolve_local_transfer_path`, which requires the target to already
/// exist -- appropriate for a move/upload *source*, but not for a download
/// destination such as the LOCAL pane's active directory (already real) or
/// a first-time literal folder name that simply hasn't been created yet.
/// Only ever used for destinations, never for a path whose non-existence
/// should itself be an error.
fn resolve_local_download_destination(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if input
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local transfer path must not contain '..'".to_string());
    }
    if input.is_absolute() {
        if !is_elevated() {
            return Err(
                "Local transfer path must remain inside the current user's home directory"
                    .to_string(),
            );
        }
        std::fs::create_dir_all(input).map_err(|error| error.to_string())?;
        return canonicalize(input);
    }
    let home = canonicalize(local_home()?)?;
    let candidate = home.join(input);
    std::fs::create_dir_all(&candidate).map_err(|error| error.to_string())?;
    let resolved = canonicalize(&candidate)?;
    if !resolved.starts_with(&home) {
        return Err(
            "Local transfer path must remain inside the current user's home directory".to_string(),
        );
    }
    Ok(resolved)
}

/// Resolve a local path that does not need to already exist (e.g. the
/// destination of `mkdir`/`rename`). The path's *parent* must exist and
/// stay inside the user's home directory (or be anywhere on disk when
/// running elevated); the leaf itself is not touched.
fn resolve_local_new_path(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if input
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local transfer path must not contain '..'".to_string());
    }
    if input.is_absolute() {
        if !is_elevated() {
            return Err(
                "Local transfer path must remain inside the current user's home directory"
                    .to_string(),
            );
        }
        let name = input
            .file_name()
            .ok_or_else(|| "Invalid local path".to_string())?
            .to_os_string();
        let parent = canonicalize(
            input
                .parent()
                .ok_or_else(|| "Invalid local path".to_string())?,
        )?;
        return Ok(parent.join(name));
    }
    let home = canonicalize(local_home()?)?;
    let candidate = home.join(input);
    let name = candidate
        .file_name()
        .ok_or_else(|| "Invalid local path".to_string())?
        .to_os_string();
    let parent = canonicalize(
        candidate
            .parent()
            .ok_or_else(|| "Invalid local path".to_string())?,
    )?;
    if !parent.starts_with(&home) {
        return Err(
            "Local transfer path must remain inside the current user's home directory".to_string(),
        );
    }
    Ok(parent.join(name))
}

#[tauri::command]
fn local_create_directory(path: String) -> Result<(), String> {
    let resolved = resolve_local_new_path(&path)?;
    std::fs::create_dir_all(&resolved).map_err(|error| error.to_string())
}

#[tauri::command]
fn local_rename_path(old_path: String, new_path: String) -> Result<String, String> {
    let old_resolved = resolve_local_transfer_path(&old_path)?;
    let mut new_resolved = resolve_local_new_path(&new_path)?;
    if new_resolved != old_resolved && new_resolved.exists() {
        let name = new_resolved
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid local path".to_string())?
            .to_string();
        let parent = new_resolved
            .parent()
            .ok_or_else(|| "Invalid local path".to_string())?
            .to_path_buf();
        let mut attempt = 1;
        loop {
            let candidate = parent.join(dedupe_candidate_name(&name, attempt));
            if !candidate.exists() {
                new_resolved = candidate;
                break;
            }
            attempt += 1;
        }
    }
    std::fs::rename(&old_resolved, &new_resolved).map_err(|error| error.to_string())?;
    Ok(new_resolved
        .strip_prefix(canonicalize(local_home()?)?)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| new_resolved.display().to_string().replace('\\', "/")))
}

#[tauri::command]
fn local_delete_path(path: String, is_directory: bool) -> Result<(), String> {
    let resolved = resolve_local_transfer_path(&path)?;
    if is_directory {
        std::fs::remove_dir_all(&resolved).map_err(|error| error.to_string())
    } else {
        std::fs::remove_file(&resolved).map_err(|error| error.to_string())
    }
}

/// Recursively add `path` (a file or directory) to `writer` under `name`,
/// preserving the folder structure of a directory tree.
fn add_path_to_zip<W: std::io::Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    path: &std::path::Path,
    name: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        writer
            .add_directory(format!("{name}/"), options)
            .map_err(|error| error.to_string())?;
        let mut entries = std::fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            let child_name = entry
                .file_name()
                .to_str()
                .ok_or_else(|| "Compress path contains a non-UTF-8 filename".to_string())?
                .to_string();
            add_path_to_zip(
                writer,
                &entry.path(),
                &format!("{name}/{child_name}"),
                options,
            )?;
        }
    } else if metadata.is_file() {
        writer
            .start_file(name, options)
            .map_err(|error| error.to_string())?;
        let data = std::fs::read(path).map_err(|error| error.to_string())?;
        std::io::Write::write_all(writer, &data).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Compress `paths` (each a file/folder already inside `destination_folder`)
/// into a new `<archive_name>.zip` in `destination_folder`. Collision
/// avoidance auto-appends "_(n)" to the archive name -- it never prompts.
#[tauri::command]
fn local_compress_paths(
    paths: Vec<String>,
    destination_folder: String,
    archive_name: String,
) -> Result<String, String> {
    let destination_dir = resolve_local_transfer_path(&destination_folder)?;
    if !destination_dir.is_dir() {
        return Err("Destination is not a folder".to_string());
    }
    let items = paths
        .iter()
        .map(|item| {
            let resolved = resolve_local_transfer_path(item)?;
            let name = resolved
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Invalid local path".to_string())?
                .to_string();
            Ok::<_, String>((resolved, name))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let base_name = sanitize_archive_name(if archive_name.trim().is_empty() {
        "Archive"
    } else {
        archive_name.trim()
    });
    let zip_name = if base_name.to_lowercase().ends_with(".zip") {
        base_name
    } else {
        format!("{base_name}.zip")
    };
    let mut final_name = zip_name.clone();
    let mut attempt = 1;
    while destination_dir.join(&final_name).exists() {
        final_name = dedupe_candidate_name(&zip_name, attempt);
        attempt += 1;
    }

    let archive_path = destination_dir.join(&final_name);
    let file = std::fs::File::create(&archive_path).map_err(|error| error.to_string())?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (resolved, name) in &items {
        add_path_to_zip(&mut writer, resolved, name, options)?;
    }
    writer.finish().map_err(|error| error.to_string())?;
    Ok(final_name)
}

/// Extract a local `.zip` archive into a new deduped subfolder of
/// `destination_folder` (named after the archive) -- never overwriting an
/// existing folder of that name, and never prompting the user about it.
#[tauri::command]
fn local_extract_archive(path: String, destination_folder: String) -> Result<String, String> {
    let archive_path = resolve_local_transfer_path(&path)?;
    let destination_dir = resolve_local_transfer_path(&destination_folder)?;
    let file = std::fs::File::open(&archive_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;

    let stem = archive_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Extracted")
        .to_string();
    let mut final_name = stem.clone();
    let mut attempt = 1;
    while destination_dir.join(&final_name).exists() {
        final_name = dedupe_candidate_name(&stem, attempt);
        attempt += 1;
    }
    let target_root = destination_dir.join(&final_name);
    std::fs::create_dir_all(&target_root).map_err(|error| error.to_string())?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(entry_path) = entry.enclosed_name() else {
            continue;
        };
        let out_path = target_root.join(entry_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut out_file =
                std::fs::File::create(&out_path).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|error| error.to_string())?;
        }
    }
    Ok(final_name)
}

#[tauri::command]
fn local_list_directory(path: String) -> Result<LocalDirectory, String> {
    let input = Path::new(&path);
    if input
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local path must not contain '..'".to_string());
    }
    // `root` is `Some(home)` while browsing the HOME-relative jail (the
    // normal, non-elevated case): every returned path is relative to it, as
    // the rest of the frontend expects. When running elevated and given an
    // absolute path, `root` is `None` and paths are absolute end-to-end
    // instead -- see `is_elevated()` for why this is never trusted from an
    // unprivileged process.
    let (root, directory): (Option<PathBuf>, PathBuf) = if input.is_absolute() {
        if !is_elevated() {
            return Err("Local path must stay inside the user home directory".to_string());
        }
        let directory = canonicalize(input)?;
        if !directory.is_dir() {
            return Err("Local path is not a directory".to_string());
        }
        (None, directory)
    } else {
        let home = canonicalize(local_home()?)?;
        let directory = canonicalize(home.join(input))?;
        if !directory.starts_with(&home) || !directory.is_dir() {
            return Err("Local path is outside the user home directory".to_string());
        }
        (Some(home), directory)
    };

    let mut files = std::fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() && !metadata.is_dir() {
                return None;
            }
            let name = entry.file_name().to_str()?.to_string();
            let child = directory.join(&name);
            let child_path = match &root {
                Some(root) => child
                    .strip_prefix(root)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/"),
                None => child.to_string_lossy().replace('\\', "/"),
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or_default();
            Some(LocalFile {
                name,
                path: child_path,
                is_directory: metadata.is_dir(),
                size: metadata.len(),
                modified,
            })
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(LocalDirectory {
        path: match &root {
            Some(root) => directory
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
            None => directory.to_string_lossy().replace('\\', "/"),
        },
        files,
    })
}

#[tauri::command]
fn inspect_upload_paths(paths: Vec<String>) -> Result<UploadSummary, String> {
    let (files, directories) = collect_upload_paths(&paths)?;
    let sources = files
        .iter()
        .map(|(path, _)| upload_source_snapshot(path))
        .collect::<Result<Vec<_>, _>>()?;
    let total_size = sources.iter().map(|source| source.size).sum();
    Ok(UploadSummary {
        files: files.len(),
        directories: directories.len(),
        total_size,
        sources,
    })
}

#[tauri::command]
fn hash_upload_paths(paths: Vec<String>) -> Result<HashMap<String, String>, String> {
    let (files, _) = collect_upload_paths(&paths)?;
    files
        .into_iter()
        .map(|(path, relative_path)| {
            let mut file = std::fs::File::open(&path).map_err(|error| {
                format!("Unable to hash upload path '{}': {error}", path.display())
            })?;
            let mut digest = Sha256::new();
            let mut buffer = [0_u8; 1024 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|error| {
                    format!("Unable to stream hash for '{}': {error}", path.display())
                })?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
            }
            let digest = digest.finalize();
            Ok((relative_path, format!("{digest:x}")))
        })
        .collect()
}

#[tauri::command]
async fn api_upload_paths(
    app: tauri::AppHandle,
    transfer_id: String,
    expected_sources: Vec<UploadSource>,
    url: String,
    headers: Vec<(String, String)>,
    paths: Vec<String>,
    path: String,
    ignore_tls_errors: bool,
) -> Result<ApiResponse, String> {
    if is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    validate_upload_sources(&expected_sources)?;
    let (files, directories) = collect_upload_paths(&paths)?;
    let total_size = files
        .iter()
        .map(|(file_path, _)| std::fs::metadata(file_path).map(|metadata| metadata.len()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .sum::<u64>();
    let mut form = multipart::Form::new().text("path", path);
    let mut completed_before = 0;
    for directory in directories {
        form = form.text("directoryPaths[]", directory);
    }
    for (file_path, relative_path) in files {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Invalid upload filename".to_string())?;
        let file_size = std::fs::metadata(&file_path)
            .map_err(|error| error.to_string())?
            .len();
        let file = tokio::fs::File::open(&file_path)
            .await
            .map_err(|error| error.to_string())?;
        let reader = UploadProgressReader {
            inner: file,
            app: app.clone(),
            transfer_id: transfer_id.clone(),
            completed_before,
            completed: 0,
            total: total_size,
            last_emit: Instant::now() - std::time::Duration::from_secs(1),
        };
        let stream = tokio_util::io::ReaderStream::new(reader);
        let part =
            multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), file_size)
                .file_name(file_name.to_string());
        form = form.text("filePaths[]", relative_path);
        form = form.part("files", part);
        completed_before += file_size;
    }
    let request = apply_headers(
        api_client(ignore_tls_errors)?.post(url).multipart(form),
        headers,
    );
    let response = response_from(request.send().await.map_err(describe_error)?).await?;
    if is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    let _ = app.emit(
        "upload-progress",
        UploadProgressEvent {
            transfer_id,
            bytes_completed: total_size,
            bytes_total: total_size,
        },
    );
    Ok(response)
}

#[tauri::command]
async fn download_to_disk(
    app: tauri::AppHandle,
    transfer_id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    file_name: String,
    destination_folder: String,
    ignore_tls_errors: bool,
) -> Result<String, String> {
    if is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(api_client(ignore_tls_errors)?.request(method, url), headers);
    let request = if let Some(body) = body {
        request.body(body)
    } else {
        request
    };
    let mut response = request.send().await.map_err(describe_error)?;
    if !response.status().is_success() {
        return Err(response
            .text()
            .await
            .unwrap_or_else(|_| "Download failed".to_string()));
    }
    let bytes_total = response.content_length();
    let response_name = content_disposition_filename(response.headers()).unwrap_or(file_name);
    let safe_name = std::path::Path::new(&response_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Invalid download filename".to_string())?;
    // `destination_folder` is the LOCAL pane's active directory at the time
    // the download was queued (HOME-relative, matching `local_list_directory`),
    // resolved through the same jail as every other LOCAL write so a download
    // can never land outside HOME (or, elevated, wherever the caller chose).
    // Unlike `resolve_local_transfer_path`, this creates the folder first if
    // it doesn't exist yet (e.g. a first-time literal "Downloads").
    let destination_root = resolve_local_download_destination(&destination_folder)?;
    let requested_destination = destination_root.join(safe_name);
    let (destination, mut file) = create_unique_file(&requested_destination)?;
    let mut bytes_completed: u64 = 0;
    let mut last_emit = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if is_transfer_cancelled(&transfer_id) {
            return Err("Transfer cancelled".to_string());
        }
        file.write_all(&chunk).map_err(|error| error.to_string())?;
        bytes_completed += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= 200 {
            let _ = app.emit(
                "download-progress",
                DownloadProgressEvent {
                    transfer_id: transfer_id.clone(),
                    bytes_completed,
                    bytes_total,
                },
            );
            last_emit = Instant::now();
        }
    }
    let _ = app.emit(
        "download-progress",
        DownloadProgressEvent {
            transfer_id,
            bytes_completed,
            bytes_total,
        },
    );
    Ok(destination.display().to_string())
}

/// Download a single file into `<destination_folder>/<relative_path>`,
/// creating any intermediate folders so a whole selection (multiple
/// files/folders) can be downloaded "queue style" -- one HTTP request per
/// file -- while still landing on disk with the original folder structure
/// intact, as an alternative to the always-available single-archive
/// download. `destination_folder` is the LOCAL pane's active directory at
/// the time the download was queued and `relative_path` is expected to
/// already start with the selection's own top-level name(s) (as returned by
/// the flatten endpoint) -- callers must not additionally wrap it in a
/// synthetic "<n> selected items" segment, which would otherwise nest a
/// single selected directory inside a duplicate copy of its own name.
#[tauri::command]
async fn download_to_disk_at(
    transfer_id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    destination_folder: String,
    relative_path: String,
    ignore_tls_errors: bool,
) -> Result<String, String> {
    if is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(api_client(ignore_tls_errors)?.request(method, url), headers);
    let request = if let Some(body) = body {
        request.body(body)
    } else {
        request
    };
    let mut response = request.send().await.map_err(describe_error)?;
    if !response.status().is_success() {
        return Err(response
            .text()
            .await
            .unwrap_or_else(|_| "Download failed".to_string()));
    }
    let relative = Path::new(&relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid destination path for queued download".to_string());
    }
    let destination_root = resolve_local_download_destination(&destination_folder)?;
    let requested_destination = destination_root.join(relative);
    if let Some(parent) = requested_destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let (destination, mut file) = create_unique_file(&requested_destination)?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if is_transfer_cancelled(&transfer_id) {
            return Err("Transfer cancelled".to_string());
        }
        file.write_all(&chunk).map_err(|error| error.to_string())?;
    }
    Ok(destination.display().to_string())
}

#[tauri::command]
async fn download_to_drag_staging(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    file_name: String,
    ignore_tls_errors: bool,
) -> Result<String, String> {
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(api_client(ignore_tls_errors)?.request(method, url), headers);
    let request = if let Some(body) = body {
        request.body(body)
    } else {
        request
    };
    let mut response = request.send().await.map_err(describe_error)?;
    if !response.status().is_success() {
        return Err(response
            .text()
            .await
            .unwrap_or_else(|_| "Download failed".to_string()));
    }
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Invalid staging filename".to_string())?;
    let staging_directory = operation_storage_directory()?.join("drag-staging");
    std::fs::create_dir_all(&staging_directory).map_err(|error| error.to_string())?;
    sweep_stale_drag_staging(&staging_directory);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let destination = staging_directory.join(format!("{stamp}-{safe_name}"));
    let mut file = std::fs::File::create(&destination).map_err(|error| error.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        file.write_all(&chunk).map_err(|error| error.to_string())?;
    }
    Ok(destination.display().to_string())
}

/// Like `download_to_drag_staging`, but for the "queue" drag-out mode: each
/// file in a multi-file/folder selection is downloaded individually into
/// `<drag-staging>/<set_id>/<relative_path>`, reconstructing the original
/// folder structure so the assembled `<drag-staging>/<set_id>` directory can
/// itself be dragged out as a single native OS drag item once every file has
/// landed.
#[tauri::command]
async fn download_to_drag_staging_at(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    set_id: String,
    relative_path: String,
    ignore_tls_errors: bool,
) -> Result<String, String> {
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(api_client(ignore_tls_errors)?.request(method, url), headers);
    let request = if let Some(body) = body {
        request.body(body)
    } else {
        request
    };
    let mut response = request.send().await.map_err(describe_error)?;
    if !response.status().is_success() {
        return Err(response
            .text()
            .await
            .unwrap_or_else(|_| "Download failed".to_string()));
    }
    let safe_set_id: String = set_id
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .collect();
    if safe_set_id.is_empty() {
        return Err("Invalid drag staging set identifier".to_string());
    }
    let relative = Path::new(&relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid staging path for queued drag download".to_string());
    }
    let staging_directory = operation_storage_directory()?
        .join("drag-staging")
        .join(&safe_set_id);
    let destination = staging_directory.join(relative);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = std::fs::File::create(&destination).map_err(|error| error.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        file.write_all(&chunk).map_err(|error| error.to_string())?;
    }
    Ok(destination.display().to_string())
}

/// Remove drag-staging archives/files left behind by abandoned or repeated
/// drag attempts (native OS drag-and-drop can be cancelled by the user, or
/// retried, without the app ever being told the previous attempt is done).
/// Anything older than this is almost certainly orphaned.
const DRAG_STAGING_MAX_AGE_SECS: u64 = 10 * 60;

fn sweep_stale_drag_staging(staging_directory: &Path) {
    let Ok(entries) = std::fs::read_dir(staging_directory) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age.as_secs() > DRAG_STAGING_MAX_AGE_SECS {
            let _ = if metadata.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

/// Explicitly remove a single staged drag file/archive once the drag
/// operation has finished (dropped or cancelled), instead of waiting for the
/// next app launch or the next stale sweep.
#[tauri::command]
fn cleanup_drag_staging(path: String) -> Result<(), String> {
    let staging_directory = operation_storage_directory()?.join("drag-staging");
    let candidate = Path::new(&path);
    let Ok(canonical) = candidate.canonicalize().map(strip_verbatim_prefix) else {
        return Ok(());
    };
    let Ok(staging_canonical) = staging_directory.canonicalize().map(strip_verbatim_prefix) else {
        return Ok(());
    };
    if !canonical.starts_with(&staging_canonical) {
        return Err("Refusing to remove a path outside the drag-staging directory".to_string());
    }
    let metadata = match std::fs::metadata(&canonical) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let result = if metadata.is_dir() {
        std::fs::remove_dir_all(&canonical)
    } else {
        std::fs::remove_file(&canonical)
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn ssh_connect(
    app: tauri::AppHandle,
    profile: ssh::SshProfile,
    request_id: String,
) -> Result<String, String> {
    ssh::connect(app, profile, request_id).await
}

#[tauri::command]
fn ssh_key_available(profile: ssh::SshProfile) -> Result<bool, String> {
    ssh::key_available(&profile)
}

#[tauri::command]
async fn ssh_install_key(profile: ssh::SshProfile) -> Result<String, String> {
    ssh::install_key(profile).await
}

#[tauri::command]
async fn ssh_write(session_id: String, data: String) -> Result<(), String> {
    ssh::write(session_id, data).await
}

#[tauri::command]
async fn ssh_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    ssh::resize(session_id, cols, rows).await
}

#[tauri::command]
async fn ssh_disconnect(session_id: String) -> Result<(), String> {
    ssh::disconnect(session_id).await
}

#[tauri::command]
fn ssh_save_password(entry_id: String, password: String) -> Result<(), String> {
    ssh::save_password(entry_id, password)
}

#[tauri::command]
fn ssh_forget_password(entry_id: String) -> Result<(), String> {
    ssh::forget_password(entry_id)
}

#[tauri::command]
fn ssh_has_password(entry_id: String) -> Result<bool, String> {
    ssh::has_password(entry_id)
}

#[tauri::command]
async fn ssh_list_directory(
    profile: ssh::SshProfile,
    path: String,
) -> Result<LocalDirectory, String> {
    ssh::sftp::list_directory(profile, path).await
}

#[tauri::command]
async fn ssh_sftp_disconnect(entry_id: String) -> Result<(), String> {
    ssh::sftp::disconnect(entry_id).await
}

/// Single-file `scp`-equivalent transfer primitives, deliberately limited to
/// LOCAL <-> SSH REMOTE (never the API Remote model).
#[tauri::command]
async fn scp_download(
    profile: ssh::SshProfile,
    remote_path: String,
    local_path: String,
) -> Result<String, String> {
    ssh::sftp::download_file(profile, remote_path, local_path).await
}

#[tauri::command]
async fn scp_upload(
    profile: ssh::SshProfile,
    local_path: String,
    remote_path: String,
) -> Result<String, String> {
    ssh::sftp::upload_file(profile, local_path, remote_path).await
}

/// Write parity for the SSH SFTP browse pane: create/delete/rename/upload/
/// download, matching the equivalent API Remote operations so the LOCATION
/// dropdown's "SSH: <name>" source behaves the same as an API Remote for
/// everyday file management (log retrieval, tool deployment, etc).
#[tauri::command]
async fn ssh_create_directory(profile: ssh::SshProfile, path: String) -> Result<(), String> {
    ssh::sftp::create_directory(profile, path).await
}

#[tauri::command]
async fn ssh_delete_path(
    profile: ssh::SshProfile,
    path: String,
    is_directory: bool,
) -> Result<(), String> {
    ssh::sftp::delete_path(profile, path, is_directory).await
}

#[tauri::command]
async fn ssh_rename_path(
    profile: ssh::SshProfile,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    ssh::sftp::rename_path(profile, old_path, new_path).await
}

#[tauri::command]
async fn ssh_upload_path(
    profile: ssh::SshProfile,
    local_path: String,
    remote_destination_folder: String,
) -> Result<String, String> {
    let local_path = resolve_local_transfer_path(&local_path)?;
    ssh::sftp::upload_path(
        profile,
        local_path.display().to_string(),
        remote_destination_folder,
    )
    .await
}

#[tauri::command]
async fn ssh_download_path(
    profile: ssh::SshProfile,
    remote_path: String,
    is_directory: bool,
    local_destination_folder: String,
) -> Result<String, String> {
    let local_destination_folder = resolve_local_transfer_path(&local_destination_folder)?;
    ssh::sftp::download_path(
        profile,
        remote_path,
        is_directory,
        local_destination_folder.display().to_string(),
    )
    .await
}

#[tauri::command]
async fn ssh_compress_paths(
    profile: ssh::SshProfile,
    paths: Vec<String>,
    destination_folder: String,
    archive_name: String,
) -> Result<String, String> {
    ssh::sftp::compress_paths(profile, paths, destination_folder, archive_name).await
}

#[tauri::command]
async fn ssh_extract_archive(
    profile: ssh::SshProfile,
    path: String,
    destination_folder: String,
) -> Result<String, String> {
    ssh::sftp::extract_archive(profile, path, destination_folder).await
}

/// Download into the drag-staging area so the result can be handed to the
/// native OS drag (mirrors `download_to_drag_staging_at` for API Remote
/// selections).
#[tauri::command]
async fn ssh_download_to_drag_staging(
    profile: ssh::SshProfile,
    remote_path: String,
    is_directory: bool,
    set_id: String,
) -> Result<String, String> {
    let safe_set_id: String = set_id
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .collect();
    if safe_set_id.is_empty() {
        return Err("Invalid drag staging set identifier".to_string());
    }
    let staging_directory = operation_storage_directory()?
        .join("drag-staging")
        .join(&safe_set_id);
    let parent_staging_directory = staging_directory
        .parent()
        .ok_or_else(|| "Invalid drag staging directory".to_string())?;
    std::fs::create_dir_all(parent_staging_directory).map_err(|error| error.to_string())?;
    sweep_stale_drag_staging(parent_staging_directory);
    std::fs::create_dir_all(&staging_directory).map_err(|error| error.to_string())?;
    match ssh::sftp::download_path(
        profile,
        remote_path,
        is_directory,
        staging_directory.display().to_string(),
    )
    .await
    {
        Ok(path) => Ok(path),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging_directory);
            Err(error)
        }
    }
}

#[tauri::command]
fn save_ssh_logs(
    profile_name: String,
    destination_path: String,
    raw: String,
    plain: String,
    commands: String,
    metadata: String,
) -> Result<SshLogPaths, String> {
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
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let directory = resolve_local_download_destination(&destination_path)?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let stem = directory.join(format!("{safe_name}-{timestamp}"));
    let raw_path = stem.with_extension("raw.log");
    let plain_path = stem.with_extension("txt");
    let commands_path = stem.with_extension("commands.log");
    let metadata_path = stem.with_extension("meta.json");
    std::fs::write(&raw_path, raw).map_err(|error| error.to_string())?;
    std::fs::write(&plain_path, plain).map_err(|error| error.to_string())?;
    std::fs::write(&commands_path, commands).map_err(|error| error.to_string())?;
    std::fs::write(&metadata_path, metadata).map_err(|error| error.to_string())?;
    Ok(SshLogPaths {
        raw: raw_path.display().to_string(),
        plain: plain_path.display().to_string(),
        commands: commands_path.display().to_string(),
        metadata: metadata_path.display().to_string(),
    })
}

fn validate_local_user_path(path: &str) -> Result<std::path::PathBuf, String> {
    resolve_local_transfer_path(path)
}

#[tauri::command]
fn read_local_file(path: String) -> Result<String, String> {
    let path = validate_local_user_path(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Only regular files can be viewed".to_string());
    }
    if metadata.len() > 8 * 1024 * 1024 {
        return Err("Files larger than 8 MB cannot be opened in the viewer".to_string());
    }
    std::fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn edit_local_file(path: String) -> Result<(), String> {
    let path = validate_local_user_path(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Only regular files can be edited".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("notepad")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Unable to start Notepad: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("gedit")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Unable to start gedit: {error}"))
    }
}

#[tauri::command]
fn operation_storage_info() -> Result<OperationStorageInfo, String> {
    let (history_path, log_path) = operation_paths()?;
    let history_bytes = std::fs::metadata(&history_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    let mut log_files = Vec::new();
    let mut log_bytes = 0;
    for path in [
        &log_path,
        &log_path.with_extension("log.1"),
        &log_path.with_extension("log.2"),
    ] {
        if let Ok(metadata) = std::fs::metadata(path) {
            log_bytes += metadata.len();
            log_files.push(path.display().to_string());
        }
    }
    Ok(OperationStorageInfo {
        history_path: history_path.display().to_string(),
        log_path: log_path.display().to_string(),
        history_bytes,
        log_bytes,
        log_files,
    })
}

#[tauri::command]
fn clear_operation_history() -> Result<(), String> {
    let (history_path, _) = operation_paths()?;
    match std::fs::remove_file(history_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn clear_operation_logs() -> Result<(), String> {
    let (_, log_path) = operation_paths()?;
    for path in [
        &log_path,
        &log_path.with_extension("log.1"),
        &log_path.with_extension("log.2"),
    ] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
fn initialize_operation_log() -> Result<(), String> {
    let staging_directory = operation_storage_directory()?.join("drag-staging");
    if staging_directory.exists() {
        std::fs::remove_dir_all(&staging_directory).map_err(|error| error.to_string())?;
    }
    let (_, log_path) = operation_paths()?;
    let rotated_two = log_path.with_extension("log.2");
    let rotated_one = log_path.with_extension("log.1");
    let has_active_log = std::fs::metadata(&log_path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false);
    if has_active_log {
        let _ = std::fs::remove_file(&rotated_two);
        if rotated_one.exists() {
            std::fs::rename(&rotated_one, &rotated_two).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&log_path, &rotated_one).map_err(|error| error.to_string())?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_path)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn append_operation_log(
    level: String,
    operation: String,
    status: String,
    source_label: String,
    destination_label: String,
    detail: String,
) -> Result<(), String> {
    // The frontend's `writeOperationLog` already applied its own
    // enabled/level filter before invoking this command, so this writes
    // unconditionally rather than re-checking the mirrored config (see
    // `oplog::write` for why).
    oplog::write(
        &level,
        &operation,
        &status,
        &source_label,
        &destination_label,
        &detail,
    )
}

/// Mirror the frontend's "Enable operation log" / "Log detail level"
/// Settings into this process, called once on startup and again whenever
/// the user changes either setting, so Rust-originated log calls (SSH auth
/// attempts, connect/disconnect, drag staging, etc.) respect the same
/// configuration as everything the frontend itself logs.
#[tauri::command]
fn set_operation_log_config(enabled: bool, level: String) {
    oplog::set_config(enabled, &level);
}

#[cfg(test)]
mod phase1_filename_tests {
    use super::{dedupe_candidate_name, sanitize_archive_name};

    #[test]
    fn dedupe_preserves_compound_archive_extensions() {
        assert_eq!(
            dedupe_candidate_name("session_2026-08-11_10_20_30.tar.gz", 1),
            "session_2026-08-11_10_20_30_(1).tar.gz"
        );
        assert_eq!(dedupe_candidate_name("report.zip", 2), "report_(2).zip");
    }

    #[test]
    fn archive_names_cannot_escape_the_destination() {
        assert_eq!(sanitize_archive_name("machine:/logs?"), "machine--logs-");
        assert_eq!(sanitize_archive_name("..."), "nFterm");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            api_request,
            pick_upload_files,
            pick_local_directory,
            local_list_directory,
            local_create_directory,
            local_rename_path,
            local_delete_path,
            is_local_elevated,
            list_local_roots,
            local_home_path,
            local_compress_paths,
            local_extract_archive,
            inspect_upload_paths,
            hash_upload_paths,
            api_upload_paths,
            cancel_transfer,
            download_to_disk,
            download_to_disk_at,
            download_to_drag_staging,
            download_to_drag_staging_at,
            cleanup_drag_staging,
            ssh_connect,
            ssh_key_available,
            ssh_install_key,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_save_password,
            ssh_forget_password,
            ssh_has_password,
            ssh_list_directory,
            ssh_sftp_disconnect,
            scp_download,
            scp_upload,
            ssh_create_directory,
            ssh_delete_path,
            ssh_rename_path,
            ssh_upload_path,
            ssh_download_path,
            ssh_download_to_drag_staging,
            ssh_compress_paths,
            ssh_extract_archive,
            save_ssh_logs,
            read_local_file,
            edit_local_file,
            operation_storage_info,
            clear_operation_history,
            clear_operation_logs,
            initialize_operation_log,
            append_operation_log,
            set_operation_log_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running nFterm desktop application");
}

#[cfg(test)]
mod tests {
    use super::{dedupe_candidate_name, UploadProgressEvent};

    #[test]
    fn upload_progress_event_keeps_normalized_queue_fields() {
        let event = UploadProgressEvent {
            transfer_id: "queue-1".to_string(),
            bytes_completed: 512,
            bytes_total: 1024,
        };
        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["transferId"], "queue-1");
        assert_eq!(value["bytesCompleted"], 512);
        assert_eq!(value["bytesTotal"], 1024);
    }

    #[test]
    fn download_collision_naming_is_distinct_from_upload_progress() {
        assert_eq!(
            dedupe_candidate_name("installer.exe", 1),
            "installer_(1).exe"
        );
        assert_eq!(
            dedupe_candidate_name("archive.tar.gz", 2),
            "archive_(2).tar.gz"
        );
    }
}
