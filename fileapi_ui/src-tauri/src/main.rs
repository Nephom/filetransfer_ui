#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::{multipart, Client};
use serde::Serialize;
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
    let root = local_home()?.canonicalize().map_err(|error| error.to_string())?;
    let relative = Path::new(&path);
    if relative.is_absolute() || relative.components().any(|component| {
        matches!(component, std::path::Component::ParentDir)
    }) {
        return Err("Local path must stay inside the user home directory".to_string());
    }
    let directory = root.join(relative);
    let directory = directory.canonicalize().map_err(|error| error.to_string())?;
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
            let child_relative = child.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            api_request,
            pick_upload_files,
            local_list_directory,
            inspect_upload_paths,
            api_upload_paths,
            download_to_disk,
            write_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running File Transfer desktop application");
}
