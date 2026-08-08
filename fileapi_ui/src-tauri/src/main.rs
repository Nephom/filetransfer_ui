#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod oplog;
mod ssh;

use reqwest::{multipart, Client};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: Vec<u8>,
}

#[derive(Serialize)]
struct UploadSummary {
    files: usize,
    directories: usize,
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
    Ok(local_home()?.join(".fileapi-desktop"))
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
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        directories.push(relative_path.clone());
        let mut children = std::fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
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
        let path = Path::new(path);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "Invalid upload filename".to_string())?;
        collect_upload_path(path, name.to_string(), &mut files, &mut directories)?;
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
    let body = response
        .bytes()
        .await
        .map_err(describe_error)?
        .to_vec();
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

/// Build the `name_(n).ext` candidate for the n-th collision-avoidance
/// attempt on `name` (e.g. `video.mp4` -> `video_(1).mp4` -> `video_(2).mp4`).
/// Matching Windows/macOS Explorer's own "keep both files" convention, this
/// is applied automatically -- never by prompting the user -- everywhere a
/// move/rename/upload/download could otherwise silently overwrite an
/// unrelated file that happens to share its destination name.
pub fn dedupe_candidate_name(name: &str, attempt: u32) -> String {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("{stem}_({attempt}).{extension}"),
        None => format!("{stem}_({attempt})"),
    }
}

fn local_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to locate the local home directory".to_string())
}

/// HOME's own real, absolute filesystem path. The frontend's LOCAL pane
/// otherwise only ever deals in HOME-relative path strings ("" = HOME
/// itself); an elevated session needs this to know where to go when
/// stepping "up" past HOME towards the real root.
#[tauri::command]
fn local_home_path() -> Result<String, String> {
    Ok(local_home()?
        .canonicalize()
        .map_err(|error| error.to_string())?
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
            return Err("Local transfer path must remain inside the current user's home directory".to_string());
        }
        return input.canonicalize().map_err(|error| error.to_string());
    }
    let home = local_home()?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let candidate = home.join(input);
    let resolved = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !resolved.starts_with(&home) {
        return Err("Local transfer path must remain inside the current user's home directory".to_string());
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
            return Err("Local transfer path must remain inside the current user's home directory".to_string());
        }
        let name = input
            .file_name()
            .ok_or_else(|| "Invalid local path".to_string())?
            .to_os_string();
        let parent = input
            .parent()
            .ok_or_else(|| "Invalid local path".to_string())?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        return Ok(parent.join(name));
    }
    let home = local_home()?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let candidate = home.join(input);
    let name = candidate
        .file_name()
        .ok_or_else(|| "Invalid local path".to_string())?
        .to_os_string();
    let parent = candidate
        .parent()
        .ok_or_else(|| "Invalid local path".to_string())?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !parent.starts_with(&home) {
        return Err("Local transfer path must remain inside the current user's home directory".to_string());
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
        .strip_prefix(local_home()?.canonicalize().map_err(|error| error.to_string())?)
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
            add_path_to_zip(writer, &entry.path(), &format!("{name}/{child_name}"), options)?;
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
fn local_compress_paths(paths: Vec<String>, destination_folder: String, archive_name: String) -> Result<String, String> {
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

    let base_name = if archive_name.trim().is_empty() { "Archive".to_string() } else { archive_name.trim().to_string() };
    let zip_name = if base_name.to_lowercase().ends_with(".zip") { base_name } else { format!("{base_name}.zip") };
    let mut final_name = zip_name.clone();
    let mut attempt = 1;
    while destination_dir.join(&final_name).exists() {
        final_name = dedupe_candidate_name(&zip_name, attempt);
        attempt += 1;
    }

    let archive_path = destination_dir.join(&final_name);
    let file = std::fs::File::create(&archive_path).map_err(|error| error.to_string())?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
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
        let Some(entry_path) = entry.enclosed_name() else { continue };
        let out_path = target_root.join(entry_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut out_file = std::fs::File::create(&out_path).map_err(|error| error.to_string())?;
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
        let directory = input.canonicalize().map_err(|error| error.to_string())?;
        if !directory.is_dir() {
            return Err("Local path is not a directory".to_string());
        }
        (None, directory)
    } else {
        let home = local_home()?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let directory = home
            .join(input)
            .canonicalize()
            .map_err(|error| error.to_string())?;
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
                Some(root) => child.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"),
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
    Ok(UploadSummary {
        files: files.len(),
        directories: directories.len(),
    })
}

#[tauri::command]
fn hash_upload_paths(paths: Vec<String>) -> Result<HashMap<String, String>, String> {
    let (files, _) = collect_upload_paths(&paths)?;
    files
        .into_iter()
        .map(|(path, relative_path)| {
            let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
            let digest = Sha256::digest(bytes);
            Ok((relative_path, format!("{digest:x}")))
        })
        .collect()
}

#[tauri::command]
async fn api_upload_paths(
    url: String,
    headers: Vec<(String, String)>,
    paths: Vec<String>,
    path: String,
    ignore_tls_errors: bool,
) -> Result<ApiResponse, String> {
    let (files, directories) = collect_upload_paths(&paths)?;
    let mut form = multipart::Form::new().text("path", path);
    for directory in directories {
        form = form.text("directoryPaths[]", directory);
    }
    for (file_path, relative_path) in files {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Invalid upload filename".to_string())?;
        let part = multipart::Part::file(&file_path)
            .await
            .map_err(|error| error.to_string())?
            .file_name(file_name.to_string());
        form = form.text("filePaths[]", relative_path);
        form = form.part("files", part);
    }
    let request = apply_headers(
        api_client(ignore_tls_errors)?.post(url).multipart(form),
        headers,
    );
    response_from(request.send().await.map_err(describe_error)?).await
}

#[tauri::command]
async fn download_to_disk(
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
    let safe_name = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Invalid download filename".to_string())?;
    let downloads = local_home()?.join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let destination = downloads.join(safe_name);
    let mut file = std::fs::File::create(&destination).map_err(|error| error.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        file.write_all(&chunk).map_err(|error| error.to_string())?;
    }
    Ok(destination.display().to_string())
}

/// Download a single file into `~/Downloads/<relative_path>`, creating any
/// intermediate folders so a whole selection (multiple files/folders) can be
/// downloaded "queue style" -- one HTTP request per file -- while still
/// landing on disk with the original folder structure intact, as an
/// alternative to the always-available single-archive download.
#[tauri::command]
async fn download_to_disk_at(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
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
    let relative = Path::new(&relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid destination path for queued download".to_string());
    }
    let downloads = local_home()?.join("Downloads");
    let destination = downloads.join(relative);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = std::fs::File::create(&destination).map_err(|error| error.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
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
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-' || *character == '_')
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
        let Ok(metadata) = entry.metadata() else { continue };
        let Ok(modified) = metadata.modified() else { continue };
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
    let Ok(canonical) = candidate.canonicalize() else {
        return Ok(());
    };
    let Ok(staging_canonical) = staging_directory.canonicalize() else {
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
async fn ssh_connect(app: tauri::AppHandle, profile: ssh::SshProfile) -> Result<String, String> {
    ssh::connect(app, profile).await
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
async fn ssh_list_directory(profile: ssh::SshProfile, path: String) -> Result<LocalDirectory, String> {
    ssh::sftp::list_directory(profile, path).await
}

#[tauri::command]
async fn ssh_sftp_disconnect(entry_id: String) -> Result<(), String> {
    ssh::sftp::disconnect(entry_id).await
}

/// Single-file `scp`-equivalent transfer primitives, deliberately limited to
/// LOCAL <-> SSH REMOTE (never the API Remote model).
#[tauri::command]
async fn scp_download(profile: ssh::SshProfile, remote_path: String, local_path: String) -> Result<String, String> {
    ssh::sftp::download_file(profile, remote_path, local_path).await
}

#[tauri::command]
async fn scp_upload(profile: ssh::SshProfile, local_path: String, remote_path: String) -> Result<String, String> {
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
async fn ssh_delete_path(profile: ssh::SshProfile, path: String, is_directory: bool) -> Result<(), String> {
    ssh::sftp::delete_path(profile, path, is_directory).await
}

#[tauri::command]
async fn ssh_rename_path(profile: ssh::SshProfile, old_path: String, new_path: String) -> Result<String, String> {
    ssh::sftp::rename_path(profile, old_path, new_path).await
}

#[tauri::command]
async fn ssh_upload_path(profile: ssh::SshProfile, local_path: String, remote_destination_folder: String) -> Result<String, String> {
    let local_path = resolve_local_transfer_path(&local_path)?;
    ssh::sftp::upload_path(profile, local_path.display().to_string(), remote_destination_folder).await
}

#[tauri::command]
async fn ssh_download_path(
    profile: ssh::SshProfile,
    remote_path: String,
    is_directory: bool,
    local_destination_folder: String,
) -> Result<String, String> {
    let local_destination_folder = resolve_local_transfer_path(&local_destination_folder)?;
    ssh::sftp::download_path(profile, remote_path, is_directory, local_destination_folder.display().to_string()).await
}

#[tauri::command]
async fn ssh_compress_paths(profile: ssh::SshProfile, paths: Vec<String>, destination_folder: String, archive_name: String) -> Result<String, String> {
    ssh::sftp::compress_paths(profile, paths, destination_folder, archive_name).await
}

#[tauri::command]
async fn ssh_extract_archive(profile: ssh::SshProfile, path: String, destination_folder: String) -> Result<String, String> {
    ssh::sftp::extract_archive(profile, path, destination_folder).await
}

/// Download into the user's real Downloads folder, matching the API Remote
/// download button's destination.
#[tauri::command]
async fn ssh_download_to_downloads(
    profile: ssh::SshProfile,
    remote_path: String,
    is_directory: bool,
) -> Result<String, String> {
    let downloads = local_home()?.join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    ssh::sftp::download_path(profile, remote_path, is_directory, downloads.display().to_string()).await
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
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-' || *character == '_')
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
    match ssh::sftp::download_path(profile, remote_path, is_directory, staging_directory.display().to_string()).await {
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
    let home = local_home()?;
    let directory = home.join("Downloads");
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
    std::process::Command::new("gedit")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to start gedit: {error}"))
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
    oplog::write(&level, &operation, &status, &source_label, &destination_label, &detail)
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            api_request,
            pick_upload_files,
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
            ssh_download_to_downloads,
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
        .expect("error while running File Transfer desktop application");
}
