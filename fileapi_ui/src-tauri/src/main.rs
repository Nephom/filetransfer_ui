#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

fn api_client(ignore_tls_errors: bool) -> Result<Client, String> {
    Client::builder()
        // This is intentionally opt-in for private, self-signed servers.
        .danger_accept_invalid_certs(ignore_tls_errors)
        .danger_accept_invalid_hostnames(ignore_tls_errors)
        .build()
        .map_err(|error| error.to_string())
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
        .map_err(|error| error.to_string())?
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
    response_from(request.send().await.map_err(|error| error.to_string())?).await
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

fn local_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to locate the local home directory".to_string())
}

#[tauri::command]
fn local_list_directory(path: String) -> Result<LocalDirectory, String> {
    let root = local_home()?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let relative = Path::new(&path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local path must stay inside the user home directory".to_string());
    }
    let directory = root.join(relative);
    let directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !directory.starts_with(&root) || !directory.is_dir() {
        return Err("Local path is outside the user home directory".to_string());
    }

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
            let child_relative = child
                .strip_prefix(&root)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or_default();
            Some(LocalFile {
                name,
                path: child_relative,
                is_directory: metadata.is_dir(),
                size: metadata.len(),
                modified,
            })
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(LocalDirectory {
        path: directory
            .strip_prefix(&root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/"),
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
    response_from(request.send().await.map_err(|error| error.to_string())?).await
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
    let mut response = request.send().await.map_err(|error| error.to_string())?;
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
    let mut response = request.send().await.map_err(|error| error.to_string())?;
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
    let mut response = request.send().await.map_err(|error| error.to_string())?;
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
    let mut response = request.send().await.map_err(|error| error.to_string())?;
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
async fn ssh_rename_path(profile: ssh::SshProfile, old_path: String, new_path: String) -> Result<(), String> {
    ssh::sftp::rename_path(profile, old_path, new_path).await
}

#[tauri::command]
async fn ssh_upload_path(profile: ssh::SshProfile, local_path: String, remote_destination_folder: String) -> Result<String, String> {
    ssh::sftp::upload_path(profile, local_path, remote_destination_folder).await
}

#[tauri::command]
async fn ssh_download_path(
    profile: ssh::SshProfile,
    remote_path: String,
    is_directory: bool,
    local_destination_folder: String,
) -> Result<String, String> {
    ssh::sftp::download_path(profile, remote_path, is_directory, local_destination_folder).await
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
    std::fs::create_dir_all(&staging_directory).map_err(|error| error.to_string())?;
    ssh::sftp::download_path(profile, remote_path, is_directory, staging_directory.display().to_string()).await
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
    let home = local_home()?;
    let candidate = std::path::Path::new(path);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(&home) {
        return Err("File path must remain inside the current user's home directory".to_string());
    }
    Ok(canonical)
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
    let (_, log_path) = operation_paths()?;
    let record = serde_json::json!({
        "timestamp": chrono_like_timestamp(),
        "level": sanitize_operation_value(level),
        "operation": sanitize_operation_value(operation),
        "status": sanitize_operation_value(status),
        "source": sanitize_operation_value(source_label),
        "destination": sanitize_operation_value(destination_label),
        "detail": sanitize_operation_value(detail),
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

fn sanitize_operation_value(value: String) -> String {
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

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            api_request,
            pick_upload_files,
            local_list_directory,
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
            save_ssh_logs,
            read_local_file,
            edit_local_file,
            operation_storage_info,
            clear_operation_history,
            clear_operation_logs,
            initialize_operation_log,
            append_operation_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running File Transfer desktop application");
}
