#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::{multipart, Client};
use serde::Serialize;

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: Vec<u8>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadFile {
    name: String,
    bytes: Vec<u8>,
    relative_path: Option<String>,
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
async fn api_upload(
    url: String,
    headers: Vec<(String, String)>,
    files: Vec<UploadFile>,
    path: String,
    ignore_tls_errors: bool,
) -> Result<ApiResponse, String> {
    let mut form = multipart::Form::new().text("path", path);
    for file in files {
        let relative_path = file.relative_path.unwrap_or_default();
        if !relative_path.is_empty() {
            form = form.text("filePaths[]", relative_path);
        }
        form = form.part(
            "files",
            multipart::Part::bytes(file.bytes).file_name(file.name),
        );
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            api_request,
            api_upload,
            write_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running File Transfer desktop application");
}
