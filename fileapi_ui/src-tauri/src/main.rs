#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::{multipart, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::Emitter;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshProfile {
    name: String,
    host: String,
    port: u16,
    username: String,
    private_key_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SshEvent {
    session_id: String,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshLogPaths {
    raw: String,
    plain: String,
    commands: String,
    metadata: String,
}

struct SshProcess {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

static SSH_PROCESSES: OnceLock<Arc<Mutex<HashMap<String, SshProcess>>>> = OnceLock::new();

fn ssh_processes() -> &'static Arc<Mutex<HashMap<String, SshProcess>>> {
    SSH_PROCESSES.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
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
fn write_download(file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let safe_name = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Invalid download filename".to_string())?;
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "Unable to locate the user home directory".to_string())?;
    let downloads = std::path::PathBuf::from(home).join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let destination = downloads.join(safe_name);
    std::fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    Ok(destination.display().to_string())
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
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "Unable to locate the user home directory".to_string())?;
    let downloads = std::path::PathBuf::from(home).join("Downloads");
    std::fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let destination = downloads.join(safe_name);
    let mut file = std::fs::File::create(&destination).map_err(|error| error.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        file.write_all(&chunk).map_err(|error| error.to_string())?;
    }
    Ok(destination.display().to_string())
}

fn validate_ssh_profile(profile: &SshProfile) -> Result<(), String> {
    if profile.name.trim().is_empty()
        || profile.host.trim().is_empty()
        || profile.username.trim().is_empty()
    {
        return Err("SSH profile name, host, and username are required".to_string());
    }
    if profile
        .host
        .chars()
        .any(|character| character.is_whitespace())
    {
        return Err("SSH host must not contain whitespace".to_string());
    }
    if profile
        .username
        .chars()
        .any(|character| character.is_whitespace())
    {
        return Err("SSH username must not contain whitespace".to_string());
    }
    if profile.port == 0 {
        return Err("SSH port must be between 1 and 65535".to_string());
    }
    if let Some(key_path) = &profile.private_key_path {
        let key = Path::new(key_path);
        if !key.is_absolute()
            || key
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err("SSH private key path must be an absolute path without '..'".to_string());
        }
        if !key.is_file() {
            return Err("SSH private key file does not exist".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn ssh_connect(app: tauri::AppHandle, profile: SshProfile) -> Result<String, String> {
    validate_ssh_profile(&profile)?;
    let session_id = format!("ssh-{}", uuid::Uuid::new_v4());
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut command = portable_pty::CommandBuilder::new("ssh");
    command.args(["-tt", "-p", &profile.port.to_string()]);
    command.args(["-o", "ConnectTimeout=15"]);
    command.args(["-o", "ServerAliveInterval=30"]);
    command.args(["-o", "ServerAliveCountMax=3"]);
    if let Some(key_path) = profile.private_key_path {
        command.args(["-i", &key_path]);
    }
    command.arg(format!("{}@{}", profile.username, profile.host));

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let writer = Arc::new(Mutex::new(writer));
    let reader_session = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let _ = app.emit(
                        "ssh-output",
                        SshEvent {
                            session_id: reader_session.clone(),
                            data,
                        },
                    );
                }
            }
        }
        let _ = app.emit(
            "ssh-exit",
            SshEvent {
                session_id: reader_session,
                data: "SSH process ended.".to_string(),
            },
        );
    });

    let process = SshProcess {
        writer,
        child: child,
    };
    ssh_processes()
        .lock()
        .map_err(|_| "SSH process registry is unavailable".to_string())?
        .insert(session_id.clone(), process);
    Ok(session_id)
}

#[tauri::command]
fn ssh_install_key(app: tauri::AppHandle, profile: SshProfile) -> Result<String, String> {
    validate_ssh_profile(&profile)?;
    let home = local_home()?;
    let key_path = profile
        .private_key_path
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".ssh").join("id_ed25519"));
    if !key_path.is_file() {
        if let Some(parent) = key_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let status = std::process::Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-f"])
            .arg(&key_path)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Unable to generate the local SSH key".to_string());
        }
    }
    let public_key = PathBuf::from(format!("{}.pub", key_path.display()));
    if !public_key.is_file() {
        return Err(format!(
            "SSH public key not found: {}",
            public_key.display()
        ));
    }

    let session_id = format!("ssh-copy-id-{}", uuid::Uuid::new_v4());
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = portable_pty::CommandBuilder::new("ssh-copy-id");
    command.args([
        "-i",
        &public_key.display().to_string(),
        "-p",
        &profile.port.to_string(),
    ]);
    command.args(["-o", "ConnectTimeout=15"]);
    command.arg(format!("{}@{}", profile.username, profile.host));
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|error| error.to_string())?,
    ));
    let reader_session = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let _ = app.emit(
                        "ssh-output",
                        SshEvent {
                            session_id: reader_session.clone(),
                            data,
                        },
                    );
                }
            }
        }
        let _ = app.emit(
            "ssh-exit",
            SshEvent {
                session_id: reader_session,
                data: "SSH key installation process ended.".to_string(),
            },
        );
    });
    ssh_processes()
        .lock()
        .map_err(|_| "SSH process registry is unavailable".to_string())?
        .insert(session_id.clone(), SshProcess { writer, child });
    Ok(session_id)
}

#[tauri::command]
fn ssh_write(session_id: String, data: String) -> Result<(), String> {
    let mut processes = ssh_processes()
        .lock()
        .map_err(|_| "SSH process registry is unavailable".to_string())?;
    let process = processes
        .get_mut(&session_id)
        .ok_or_else(|| "SSH session is not connected".to_string())?;
    let result = {
        let mut writer = process
            .writer
            .lock()
            .map_err(|_| "SSH writer is unavailable".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    };
    result
}

#[tauri::command]
fn ssh_disconnect(session_id: String) -> Result<(), String> {
    if let Some(mut process) = ssh_processes()
        .lock()
        .map_err(|_| "SSH process registry is unavailable".to_string())?
        .remove(&session_id)
    {
        process.child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            api_request,
            pick_upload_files,
            local_list_directory,
            inspect_upload_paths,
            hash_upload_paths,
            api_upload_paths,
            download_to_disk,
            write_download,
            ssh_connect,
            ssh_install_key,
            ssh_write,
            ssh_disconnect,
            save_ssh_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running File Transfer desktop application");
}
