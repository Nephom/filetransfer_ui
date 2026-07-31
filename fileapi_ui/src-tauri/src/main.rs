#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::{multipart, Client};
use serde::Deserialize;
use serde::Serialize;
use std::io::Write;

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: Vec<u8>,
}

#[derive(Deserialize)]
struct BrowserHandoffResponse {
    url: String,
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
        .into_iter()
        .map(|file| file.path().display().to_string())
        .collect())
}

#[tauri::command]
async fn api_upload_paths(
    url: String,
    headers: Vec<(String, String)>,
    paths: Vec<String>,
    path: String,
    ignore_tls_errors: bool,
) -> Result<ApiResponse, String> {
    let mut form = multipart::Form::new().text("path", path);
    for path in paths {
        let file_path = std::path::PathBuf::from(&path);
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Invalid upload filename".to_string())?;
        let part = multipart::Part::file(&file_path)
            .await
            .map_err(|error| error.to_string())?
            .file_name(file_name.to_string());
        form = form.text("filePaths[]", file_name.to_string());
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

#[tauri::command]
async fn open_admin_console(
    base_url: String,
    headers: Vec<(String, String)>,
    ignore_tls_errors: bool,
) -> Result<(), String> {
    let response = apply_headers(
        api_client(ignore_tls_errors)?.post(format!("{base_url}/auth/browser-handoff")),
        headers,
    )
    .send()
    .await
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to create browser sign-in link".to_string()));
    }
    let handoff: BrowserHandoffResponse =
        response.json().await.map_err(|error| error.to_string())?;
    std::process::Command::new("xdg-open")
        .arg(format!("{base_url}{}", handoff.url))
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            api_request,
            pick_upload_files,
            api_upload_paths,
            download_to_disk,
            open_admin_console,
            write_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running File Transfer desktop application");
}
