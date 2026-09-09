#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod netcheck;
mod oplog;
mod proxmox;
mod recording;
mod ssh;

use reqwest::{cookie::Jar, multipart, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::io::{AsyncRead, ReadBuf};

static CANCELLED_TRANSFER_IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static API_CLIENTS: OnceLock<Mutex<HashMap<bool, Client>>> = OnceLock::new();
static DOWNLOAD_CLIENTS: OnceLock<Mutex<HashMap<bool, Client>>> = OnceLock::new();
static SESSION_COOKIE_JARS: OnceLock<Mutex<HashMap<bool, Arc<Jar>>>> = OnceLock::new();
static API_SESSIONS: OnceLock<Mutex<HashMap<String, Arc<ApiSession>>>> = OnceLock::new();
static UPLOAD_ATTEMPTS: OnceLock<Mutex<HashMap<String, Arc<UploadCancellation>>>> = OnceLock::new();

struct UploadCancellation {
    signal: tokio::sync::watch::Sender<bool>,
    reader_waker: futures_util::task::AtomicWaker,
}

impl UploadCancellation {
    fn new() -> Self {
        Self {
            signal: tokio::sync::watch::channel(false).0,
            reader_waker: futures_util::task::AtomicWaker::new(),
        }
    }

    fn cancel(&self) {
        self.signal.send_replace(true);
        self.reader_waker.wake();
    }

    fn is_cancelled(&self) -> bool {
        *self.signal.borrow()
    }

    async fn cancelled(&self) {
        let mut receiver = self.signal.subscribe();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
}

struct UploadAttempt {
    id: String,
    cancellation: Arc<UploadCancellation>,
}

impl UploadAttempt {
    fn start(id: String) -> Result<Self, String> {
        // Lock in the same order as cancel_transfer, so cancellation before
        // dispatch cannot be lost between checking the marker and registering.
        let cancelled = cancelled_transfer_ids().lock().map_err(|e| e.to_string())?;
        if cancelled.contains(&id) {
            return Err("Upload transport cancelled; server outcome is unconfirmed".to_string());
        }
        let mut attempts = UPLOAD_ATTEMPTS
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        if attempts.contains_key(&id) {
            return Err("Upload attempt is already active; use a fresh transferId".to_string());
        }
        let cancellation = Arc::new(UploadCancellation::new());
        attempts.insert(id.clone(), cancellation.clone());
        Ok(Self { id, cancellation })
    }
}

impl Drop for UploadAttempt {
    fn drop(&mut self) {
        // Also stop a body reader retained by the HTTP task after its caller
        // drops the request future or receives an early response.
        self.cancellation.cancel();
        if let Ok(mut attempts) = UPLOAD_ATTEMPTS.get_or_init(Default::default).lock() {
            attempts.remove(&self.id);
        }
    }
}

async fn await_upload<T>(
    cancellation: &UploadCancellation,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        // A complete response wins a simultaneous late cancellation. Never
        // replace an already received batch acceptance with a transport error.
        result = work => result,
        _ = cancellation.cancelled() =>
            Err("Upload transport cancelled; server outcome is unconfirmed".to_string()),
    }
}

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
    let mut cancelled = cancelled_transfer_ids()
        .lock()
        .map_err(|error| error.to_string())?;
    cancelled.insert(transfer_id.clone());
    if let Some(attempt) = UPLOAD_ATTEMPTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .get(&transfer_id)
    {
        attempt.cancel();
    }
    Ok(())
}

fn reset_transfer_cancellation(transfer_id: &str) {
    if let Ok(mut ids) = cancelled_transfer_ids().lock() {
        ids.remove(transfer_id);
    }
}

/// Client-side TCP reachability probe (see `netcheck.rs`). Used by VNC mode
/// to decide, from the desktop machine's own point of view, whether a Proxmox
/// guest VM (or the Proxmox host itself, for an SSH jump) can be reached
/// directly before falling back to the QEMU guest-agent API transfer path.
#[tauri::command]
async fn tcp_check_reachable(host: String, port: u16, timeout_ms: u64) -> bool {
    netcheck::is_port_reachable(&host, port, timeout_ms).await
}

/// Real SSH-transport reachability probe (see
/// `ssh::check_transport_reachable`). Unlike `tcp_check_reachable`, this
/// proves a live SSH server actually answers at `profile.host:port` -- and,
/// when `profile.jump_host` is set, that the jump host's stored credentials
/// authenticate and it can tunnel through to that target -- rather than
/// just that *some* process holds the port open. VNC mode's
/// `detectTransferMode()` uses this (instead of probing the always-up
/// Proxmox host port) to decide whether `direct-sftp`/`jump-sftp` will
/// actually work for the VM before falling back to the guest-agent path.
#[tauri::command]
async fn ssh_check_transport_reachable(profile: ssh::SshProfile, timeout_ms: u64) -> bool {
    ssh::check_transport_reachable(profile, timeout_ms).await
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    status_text: String,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
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
    cancellation: Arc<UploadCancellation>,
    completed: Arc<AtomicU64>,
    emit: Arc<dyn Fn(u64) + Send + Sync>,
    last_emit: Instant,
}

impl<R: AsyncRead + Unpin> AsyncRead for UploadProgressReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        self.cancellation.reader_waker.register(cx.waker());
        if self.cancellation.is_cancelled() {
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Transfer cancelled",
            )));
        }
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        if let Poll::Ready(Ok(())) = &result {
            let read = (buffer.filled().len() - before) as u64;
            let completed = self.completed.fetch_add(read, Ordering::Relaxed) + read;
            if read > 0 && self.last_emit.elapsed().as_millis() >= 200 {
                (self.emit)(completed);
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
struct LocalDirectoryChild {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDirectoryChildren {
    path: String,
    directories: Vec<LocalDirectoryChild>,
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

#[allow(clippy::type_complexity)]
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
        // LOCAL pane entries are HOME-relative; native picker entries are
        // absolute. Read-only sources use the OS ACL as the authority.
        let source = resolve_local_read_entry(path)?;
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

fn http_origin(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid HTTP(S) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Expected an HTTP(S) URL without embedded credentials".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

struct ApiSession {
    origin: String,
    ignore_tls_errors: bool,
    jar: Arc<Jar>,
    clients: Mutex<HashMap<bool, Client>>,
}

impl ApiSession {
    fn new(origin: &str, ignore_tls_errors: bool) -> Result<Self, String> {
        Ok(Self {
            origin: http_origin(origin)?,
            ignore_tls_errors,
            jar: Arc::new(Jar::default()),
            clients: Mutex::new(HashMap::new()),
        })
    }

    fn client(&self, url: &str, ignore_tls_errors: bool, download: bool) -> Result<Client, String> {
        if http_origin(url)? != self.origin {
            return Err("API session origin mismatch".to_string());
        }
        if ignore_tls_errors != self.ignore_tls_errors {
            return Err("API session TLS policy mismatch".to_string());
        }
        let mut clients = self.clients.lock().map_err(|error| error.to_string())?;
        if let Some(client) = clients.get(&download) {
            return Ok(client.clone());
        }
        let origin = self.origin.clone();
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(if download { 300 } else { 30 }))
            .cookie_provider(self.jar.clone())
            .danger_accept_invalid_certs(self.ignore_tls_errors)
            .danger_accept_invalid_hostnames(self.ignore_tls_errors)
            // Cookie domains do not isolate ports. Check every redirect before
            // reqwest can attach this session's cookie or forward a request body.
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if http_origin(attempt.url().as_str()).ok().as_ref() != Some(&origin) {
                    attempt.error("API session redirect origin mismatch")
                } else if attempt.previous().len() >= 10 {
                    attempt.error("Too many redirects")
                } else {
                    attempt.follow()
                }
            }));
        if download {
            builder = builder.no_gzip();
        }
        let client = builder.build().map_err(describe_error)?;
        clients.insert(download, client.clone());
        Ok(client)
    }
}

#[tauri::command]
fn create_api_session(origin: String, ignore_tls_errors: Option<bool>) -> Result<String, String> {
    let session = Arc::new(ApiSession::new(
        &origin,
        ignore_tls_errors.unwrap_or(false),
    )?);
    let id = uuid::Uuid::new_v4().to_string();
    API_SESSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
fn clear_api_session(session_id: String) -> Result<(), String> {
    // Removing the handle does not mutate any jar already held by an active
    // request. A later login always receives a new, independent jar.
    API_SESSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&session_id);
    Ok(())
}

fn request_client(
    url: &str,
    session_id: Option<&str>,
    ignore_tls_errors: bool,
    download: bool,
) -> Result<Client, String> {
    if let Some(id) = session_id {
        let session = API_SESSIONS
            .get_or_init(Default::default)
            .lock()
            .map_err(|error| error.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "Unknown or cleared API session".to_string())?;
        return session.client(url, ignore_tls_errors, download);
    }
    // Omitted handles retain the generic REST client behavior. An invalid
    // supplied handle must never fall through to these shared cookie jars.
    if download {
        download_client(ignore_tls_errors)
    } else {
        api_client(ignore_tls_errors)
    }
}

fn api_client(ignore_tls_errors: bool) -> Result<Client, String> {
    let clients = API_CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = clients.lock() {
        if let Some(client) = cache.get(&ignore_tls_errors) {
            return Ok(client.clone());
        }
    }
    let jar = session_cookie_jar(ignore_tls_errors)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        // Keep the server's HttpOnly session cookie in the native client and
        // attach it to later requests. This is the desktop equivalent of the
        // browser automatically sending an HttpOnly cookie.
        .cookie_provider(jar)
        // This is intentionally opt-in for private, self-signed servers.
        .danger_accept_invalid_certs(ignore_tls_errors)
        .danger_accept_invalid_hostnames(ignore_tls_errors)
        .build()
        .map_err(describe_error)?;
    clients
        .lock()
        .map_err(|error| error.to_string())?
        .insert(ignore_tls_errors, client.clone());
    Ok(client)
}

fn download_client(ignore_tls_errors: bool) -> Result<Client, String> {
    let clients = DOWNLOAD_CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = clients.lock() {
        if let Some(client) = cache.get(&ignore_tls_errors) {
            return Ok(client.clone());
        }
    }
    let jar = session_cookie_jar(ignore_tls_errors)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .no_gzip()
        .cookie_provider(jar)
        .danger_accept_invalid_certs(ignore_tls_errors)
        .danger_accept_invalid_hostnames(ignore_tls_errors)
        .build()
        .map_err(describe_error)?;
    clients
        .lock()
        .map_err(|error| error.to_string())?
        .insert(ignore_tls_errors, client.clone());
    Ok(client)
}

fn session_cookie_jar(ignore_tls_errors: bool) -> Result<Arc<Jar>, String> {
    let jars = SESSION_COOKIE_JARS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = jars.lock() {
        if let Some(jar) = cache.get(&ignore_tls_errors) {
            return Ok(jar.clone());
        }
    }
    let jar = Arc::new(Jar::default());
    jars.lock()
        .map_err(|error| error.to_string())?
        .insert(ignore_tls_errors, jar.clone());
    Ok(jar)
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
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    let body = response.bytes().await.map_err(describe_error)?.to_vec();
    Ok(ApiResponse {
        status,
        status_text,
        body,
        headers,
    })
}

#[tauri::command]
async fn api_request(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    ignore_tls_errors: bool,
    session_id: Option<String>,
) -> Result<ApiResponse, String> {
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(
        request_client(&url, session_id.as_deref(), ignore_tls_errors, false)?.request(method, url),
        headers,
    );
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
    // Temporary live-debugging aid for the "Download never shows a folder
    // picker" investigation: log every step so a failure that happens
    // before rfd ever gets a chance to show a dialog (or a dialog that
    // returns something unexpected) is visible in operations.log instead
    // of only surfacing as an opaque error banner in the UI.
    oplog::log("DEBUG", "local_pick_directory", "started", &path, "", "{}");
    let initial_directory = match resolve_local_download_destination(&path) {
        Ok(directory) => directory,
        Err(error) => {
            oplog::log(
                "DEBUG",
                "local_pick_directory",
                "initial_directory_failed",
                &path,
                "",
                &serde_json::json!({ "error": error }).to_string(),
            );
            return Err(error);
        }
    };
    oplog::log(
        "DEBUG",
        "local_pick_directory",
        "initial_directory_resolved",
        &path,
        &initial_directory.display().to_string(),
        "{}",
    );
    let selected = rfd::AsyncFileDialog::new()
        .set_directory(&initial_directory)
        .pick_folder()
        .await;
    let Some(selected) = selected else {
        oplog::log(
            "DEBUG",
            "local_pick_directory",
            "dialog_cancelled_or_unavailable",
            &path,
            &initial_directory.display().to_string(),
            "{}",
        );
        return Ok(None);
    };
    oplog::log(
        "DEBUG",
        "local_pick_directory",
        "dialog_returned_selection",
        &path,
        &selected.path().display().to_string(),
        "{}",
    );
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

#[tauri::command]
async fn save_text_file(name: String, content: String) -> Result<Option<String>, String> {
    let selected = rfd::AsyncFileDialog::new()
        .set_file_name(&name)
        .save_file()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    std::fs::write(selected.path(), content.as_bytes()).map_err(|error| error.to_string())?;
    Ok(Some(selected.path().display().to_string()))
}

fn sanitize_iml_file_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['.', ' ']);
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

#[tauri::command]
fn create_iml_csv_session(
    serial_number: String,
    timestamp: String,
    header: String,
) -> Result<String, String> {
    let desktop = local_home()?.join("Desktop");
    std::fs::create_dir_all(&desktop).map_err(|error| error.to_string())?;
    let serial = sanitize_iml_file_component(&serial_number);
    let stamp = sanitize_iml_file_component(&timestamp);
    let base = format!("HPE{serial}-iml-{stamp}.csv");
    let mut path = desktop.join(&base);
    let mut attempt = 1u32;
    while path.exists() {
        path = desktop.join(format!("HPE{serial}-iml-{stamp}_({attempt}).csv"));
        attempt += 1;
    }
    std::fs::write(&path, header.as_bytes()).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn append_iml_csv_session(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    let desktop = local_home()?.join("Desktop");
    let target = canonicalize(
        target
            .parent()
            .ok_or_else(|| "IML CSV path has no parent directory".to_string())?,
    )?
    .join(
        target
            .file_name()
            .ok_or_else(|| "IML CSV path has no file name".to_string())?,
    );
    if !target.starts_with(canonicalize(desktop)?) {
        return Err("IML CSV path must remain on the user's Desktop".to_string());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(false)
        .append(true)
        .open(&target)
        .map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
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

fn create_unique_download_file(path: &Path) -> Result<(PathBuf, PathBuf, std::fs::File), String> {
    let mut attempt = 1;
    loop {
        let candidate = if attempt == 1 {
            path.to_path_buf()
        } else {
            path.parent()
                .unwrap_or_else(|| Path::new(""))
                .join(dedupe_candidate_name(
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("download"),
                    attempt - 1,
                ))
        };
        if candidate.exists() {
            attempt += 1;
            continue;
        }
        let file_name = candidate
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid download filename".to_string())?;
        let temporary = candidate
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(format!(".{file_name}.part"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((candidate, temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
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

pub(crate) fn local_home() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to locate the Windows user profile".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to locate the local home directory".to_string())
    }
}

/// Resolve the directory used for SSH keys and known hosts.
///
/// Windows prefers a `.ssh` directory next to the executable so portable
/// installations keep their SSH state with the application. Installed copies
/// under a protected directory (for example, `Program Files`) fall back to
/// the current user's profile. Unix platforms retain the standard
/// `$HOME/.ssh` location.
pub(crate) fn ssh_storage_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if let Ok(executable) = std::env::current_exe() {
            if let Some(parent) = executable.parent() {
                let portable_dir = parent.join(".ssh");
                if std::fs::create_dir_all(&portable_dir).is_ok() {
                    let probe =
                        portable_dir.join(format!(".nfterm-write-test-{}", std::process::id()));
                    let writable = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&probe)
                        .is_ok();
                    let _ = std::fs::remove_file(&probe);
                    if writable {
                        return Ok(portable_dir);
                    }
                }
            }
        }

        let user_profile = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to locate the Windows user profile".to_string())?;
        let user_ssh_dir = user_profile.join(".ssh");
        std::fs::create_dir_all(&user_ssh_dir).map_err(|error| error.to_string())?;
        Ok(user_ssh_dir)
    }

    #[cfg(not(windows))]
    {
        let ssh_dir = local_home()?.join(".ssh");
        std::fs::create_dir_all(&ssh_dir).map_err(|error| error.to_string())?;
        Ok(ssh_dir)
    }
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

    #[cfg(windows)]
    #[test]
    fn allows_unc_paths_for_read_only_local_sources() {
        assert!(super::is_local_read_scope(
            std::path::Path::new(r"\\server\share\folder"),
            std::path::Path::new(r"C:\Users\Administrator"),
            false,
        ));
    }

    #[cfg(windows)]
    #[test]
    fn keeps_unc_paths_out_of_write_capable_local_scope() {
        assert!(!super::is_within_home_or_elevated(
            std::path::Path::new(r"\\server\share\folder"),
            std::path::Path::new(r"C:\Users\Administrator"),
            false,
        ));
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
/// gate for lifting the HOME-drive restriction on Windows and the HOME jail
/// on Unix. Every path resolver below re-checks the real process privilege
/// rather than trusting a flag the frontend could pass in.
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

/// Filesystem roots available to the LOCAL tree. Windows excludes the HOME
/// drive for regular users because C: outside HOME remains restricted, while
/// other drive roots are offered only when their root can be enumerated.
#[cfg(windows)]
fn local_roots() -> Vec<String> {
    let home_drive = local_home()
        .ok()
        .and_then(|home| canonicalize(home).ok())
        .and_then(|home| {
            home.components().find_map(|component| match component {
                std::path::Component::Prefix(prefix) => match prefix.kind() {
                    std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => {
                        Some(letter.to_ascii_uppercase())
                    }
                    _ => None,
                },
                _ => None,
            })
        });
    let elevated = is_elevated();
    let mut seen = std::collections::HashSet::new();
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let drive = format!("{}:\\", letter as char);
            if !elevated && (home_drive.is_none() || home_drive == Some(letter)) {
                return None;
            }
            let (root, directory) = resolve_local_read_path(&drive).ok()?;
            if std::fs::read_dir(&directory).is_err() {
                return None;
            }
            // Match listing/tree identities even when a mapped drive resolves to UNC.
            let identity = local_display_path(root.as_deref(), &directory).ok()?;
            (!identity.is_empty() && seen.insert(identity.clone())).then_some(identity)
        })
        .collect()
}

#[cfg(not(windows))]
fn local_roots() -> Vec<String> {
    vec!["/".to_string()]
}

#[tauri::command]
fn list_local_roots() -> Vec<String> {
    #[cfg(windows)]
    {
        local_roots()
    }
    #[cfg(not(windows))]
    {
        local_roots()
    }
}

/// Whether a local path is allowed through a write-capable filesystem
/// boundary. Read-only sources use `is_local_read_scope` below instead: the
/// operating system's ACL is the authority for files the user is allowed to
/// inspect and upload, including mapped network drives.
fn is_within_home_or_elevated(resolved: &Path, home: &Path, elevated: bool) -> bool {
    if resolved.starts_with(home) || elevated {
        return true;
    }

    #[cfg(windows)]
    {
        let drive_letter = |path: &Path| {
            path.components().find_map(|component| match component {
                std::path::Component::Prefix(prefix) => match prefix.kind() {
                    std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => {
                        Some(letter.to_ascii_uppercase())
                    }
                    _ => None,
                },
                _ => None,
            })
        };
        return drive_letter(resolved).is_some() && drive_letter(resolved) != drive_letter(home);
    }

    #[cfg(not(windows))]
    {
        false
    }
}

fn is_local_read_scope(resolved: &Path, home: &Path, elevated: bool) -> bool {
    if resolved.starts_with(home) || elevated {
        return true;
    }

    #[cfg(windows)]
    {
        // `canonicalize` turns many mapped drive paths such as `Z:\Share`
        // into UNC paths such as `\\server\share`. Both forms are absolute
        // paths, and the user's Windows ACL is the correct authority for a
        // read-only LOCAL source. Do not reuse the write-path restriction
        // here: it only understands local drive letters by design.
        return resolved.is_absolute();
    }

    #[cfg(not(windows))]
    {
        true
    }
}

/// Resolve a LOCAL path for read-only browsing and transfer sources. Relative
/// paths start in HOME. Absolute paths are allowed when the platform policy
/// permits them, and the final filesystem operation remains the OS ACL check.
/// On Windows this includes mapped drives after they canonicalize to UNC paths.
fn resolve_local_read_path(path: &str) -> Result<(Option<PathBuf>, PathBuf), String> {
    let input = Path::new(path);
    if input
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local read path must not contain '..'".to_string());
    }

    let home = canonicalize(local_home()?)?;
    let directory = if input.is_absolute() {
        canonicalize(input)?
    } else {
        canonicalize(home.join(input))?
    };
    if !directory.is_dir() {
        return Err("Local path is not a directory".to_string());
    }

    if !is_local_read_scope(&directory, &home, is_elevated()) {
        return Err("Local path is outside the permitted local filesystem".to_string());
    }

    let relative_root = directory.starts_with(&home).then_some(home);
    Ok((relative_root, directory))
}

fn resolve_local_read_entry(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if input
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local read path must not contain '..'".to_string());
    }
    let home = canonicalize(local_home()?)?;
    let resolved = canonicalize(if input.is_absolute() {
        input.to_path_buf()
    } else {
        home.join(input)
    })?;
    if !is_local_read_scope(&resolved, &home, is_elevated()) {
        return Err("Local path is outside the permitted local filesystem".to_string());
    }
    Ok(resolved)
}

fn local_display_path(root: Option<&Path>, directory: &Path) -> Result<String, String> {
    match root {
        Some(root) => Ok(directory
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/")),
        None => {
            let display = directory.to_string_lossy().replace('\\', "/");
            #[cfg(windows)]
            if display.starts_with("//") {
                return Ok(display.trim_end_matches('/').to_string());
            }
            Ok(display)
        }
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
        // Native OS file/folder pickers (used by the Proxmox VNC upload/
        // download flow) always return absolute paths, even for a file that
        // is legitimately inside the user's own home directory (e.g. their
        // Desktop) -- an absolute path alone says nothing about whether it
        // is inside or outside the jail, so it must actually be checked
        // against `home` rather than treated as automatically "outside".
        let resolved = canonicalize(input)?;
        let home = canonicalize(local_home()?)?;
        if is_within_home_or_elevated(&resolved, &home, is_elevated()) {
            return Ok(resolved);
        }
        return Err(
            "Local transfer path must remain inside the current user's home directory".to_string(),
        );
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
        // Check the lexical destination before creating it. This prevents a
        // denied C: path from being created before the policy rejects it.
        let home = canonicalize(local_home()?)?;
        #[cfg(windows)]
        if !is_within_home_or_elevated(input, &home, is_elevated()) {
            return Err(
                "Download destination is outside the permitted local filesystem".to_string(),
            );
        }
        std::fs::create_dir_all(input).map_err(|error| error.to_string())?;
        let resolved = canonicalize(input)?;
        if is_within_home_or_elevated(&resolved, &home, is_elevated()) {
            return Ok(resolved);
        }
        return Err("Download destination is outside the permitted local filesystem".to_string());
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

/// Resolve a file destination below `destination_folder` and verify the
/// canonical parent after creating missing directories. Checking only the
/// lexical path is not sufficient: an existing symlink/junction in a
/// relative component can otherwise redirect a download outside the local
/// HOME jail.
fn resolve_local_download_file(
    destination_folder: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid destination path for queued download".to_string());
    }
    let destination_root = if Path::new(destination_folder).is_absolute() {
        let root = canonicalize(destination_folder)?;
        if !is_within_home_or_elevated(&root, &canonicalize(local_home()?)?, is_elevated()) {
            return Err(
                "Download destination is outside the permitted local filesystem".to_string(),
            );
        }
        root
    } else {
        resolve_local_download_destination(destination_folder)?
    };
    let requested = destination_root.join(relative);
    let parent = requested
        .parent()
        .ok_or_else(|| "Invalid destination path for queued download".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let canonical_parent = canonicalize(parent)?;
    if !canonical_parent.starts_with(&destination_root) {
        return Err("Download destination leaves its selected folder".to_string());
    }
    let file_name = requested
        .file_name()
        .ok_or_else(|| "Invalid destination filename".to_string())?;
    Ok(canonical_parent.join(file_name))
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
        let name = input
            .file_name()
            .ok_or_else(|| "Invalid local path".to_string())?
            .to_os_string();
        let parent = canonicalize(
            input
                .parent()
                .ok_or_else(|| "Invalid local path".to_string())?,
        )?;
        // See resolve_local_transfer_path: an absolute path from a native
        // picker isn't necessarily outside the jail, so it must be checked
        // against `home` rather than automatically requiring elevation.
        let home = canonicalize(local_home()?)?;
        if is_within_home_or_elevated(&parent, &home, is_elevated()) {
            return Ok(parent.join(name));
        }
        return Err(
            "Local transfer path must remain inside the current user's home directory".to_string(),
        );
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
        let mut input = std::fs::File::open(path).map_err(|error| error.to_string())?;
        std::io::copy(&mut input, writer).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Compress `paths` (each a file/folder already inside `destination_folder`)
/// into a new `<archive_name>.zip` in `destination_folder`. Collision
/// avoidance auto-appends "_(n)" to the archive name -- it never prompts.
#[tauri::command]
#[allow(unreachable_code, unused_variables)]
fn local_compress_paths(
    paths: Vec<String>,
    destination_folder: String,
    archive_name: String,
) -> Result<String, String> {
    return Err("LOCAL is read-only".to_string());
    #[allow(unreachable_code)]
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
#[allow(unreachable_code, unused_variables)]
fn local_extract_archive(path: String, destination_folder: String) -> Result<String, String> {
    return Err("LOCAL is read-only".to_string());
    #[allow(unreachable_code)]
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
    let (root, directory) = resolve_local_read_path(&path)?;

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
            let child_path = local_display_path(root.as_deref(), &child).ok()?;
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
    files.sort_by_key(|left| left.name.to_lowercase());

    Ok(LocalDirectory {
        path: local_display_path(root.as_deref(), &directory)?,
        files,
    })
}

#[tauri::command]
fn local_list_directories(path: String) -> Result<LocalDirectoryChildren, String> {
    let (root, directory) = resolve_local_read_path(&path)?;

    let mut directories = std::fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let name = entry.file_name().to_str()?.to_string();
            let child = directory.join(&name);
            let child_path = local_display_path(root.as_deref(), &child).ok()?;
            Some(LocalDirectoryChild {
                name,
                path: child_path,
            })
        })
        .collect::<Vec<_>>();
    directories.sort_by_key(|left| left.name.to_lowercase());

    Ok(LocalDirectoryChildren {
        path: local_display_path(root.as_deref(), &directory)?,
        directories,
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

#[allow(clippy::too_many_arguments)]
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
    session_id: Option<String>,
) -> Result<ApiResponse, String> {
    // transferId identifies this dispatch attempt, not a reusable queue row.
    let attempt = UploadAttempt::start(transfer_id.clone())?;
    let client = request_client(&url, session_id.as_deref(), ignore_tls_errors, false)?;
    await_upload(&attempt.cancellation, async {
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
        let completed = Arc::new(AtomicU64::new(0));
        let emit: Arc<dyn Fn(u64) + Send + Sync> = Arc::new(move |bytes_completed| {
            let _ = app.emit(
                "upload-progress",
                UploadProgressEvent {
                    transfer_id: transfer_id.clone(),
                    bytes_completed,
                    bytes_total: total_size,
                },
            );
        });
        emit(0);
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
                cancellation: attempt.cancellation.clone(),
                completed: completed.clone(),
                emit: emit.clone(),
                last_emit: Instant::now() - std::time::Duration::from_secs(1),
            };
            let stream = tokio_util::io::ReaderStream::new(reader);
            let part =
                multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), file_size)
                    .file_name(file_name.to_string());
            form = form.text("filePaths[]", relative_path);
            form = form.part("files", part);
        }
        if attempt.cancellation.is_cancelled() {
            return Err("Upload transport cancelled; server outcome is unconfirmed".to_string());
        }
        let request = apply_headers(client.post(url).multipart(form), headers);
        let response = response_from(request.send().await.map_err(describe_error)?).await?;
        // Source reads are transport progress, not proof of server acceptance.
        emit(completed.load(Ordering::Relaxed));
        Ok(response)
    })
    .await
}

#[allow(clippy::too_many_arguments)]
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
    session_id: Option<String>,
) -> Result<String, String> {
    reset_transfer_cancellation(&transfer_id);
    if is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(
        request_client(&url, session_id.as_deref(), ignore_tls_errors, true)?.request(method, url),
        headers,
    )
    .header(reqwest::header::ACCEPT_ENCODING, "identity");
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
    let (destination, temporary, mut file) = create_unique_download_file(&requested_destination)?;
    let mut bytes_completed: u64 = 0;
    let expected_bytes = bytes_total;
    let mut last_emit = Instant::now();
    while let Some(chunk) = match response.chunk().await {
        Ok(chunk) => chunk,
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(describe_error(error));
        }
    } {
        if is_transfer_cancelled(&transfer_id) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err("Transfer cancelled".to_string());
        }
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
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
    drop(file);
    if let Some(expected) = expected_bytes {
        if bytes_completed != expected {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "Incomplete download: received {bytes_completed} of {expected} bytes"
            ));
        }
    }
    std::fs::rename(&temporary, &destination).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })?;
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
#[allow(clippy::too_many_arguments)]
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
    session_id: Option<String>,
) -> Result<String, String> {
    reset_transfer_cancellation(&transfer_id);
    if is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(
        request_client(&url, session_id.as_deref(), ignore_tls_errors, true)?.request(method, url),
        headers,
    )
    .header(reqwest::header::ACCEPT_ENCODING, "identity");
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
    let requested_destination = resolve_local_download_file(&destination_folder, &relative_path)?;
    let (destination, temporary, mut file) = create_unique_download_file(&requested_destination)?;
    let expected_bytes = response.content_length();
    let mut bytes_completed = 0u64;
    while let Some(chunk) = match response.chunk().await {
        Ok(chunk) => chunk,
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(describe_error(error));
        }
    } {
        if is_transfer_cancelled(&transfer_id) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err("Transfer cancelled".to_string());
        }
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        bytes_completed += chunk.len() as u64;
    }
    drop(file);
    if let Some(expected) = expected_bytes {
        if bytes_completed != expected {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "Incomplete download: received {bytes_completed} of {expected} bytes"
            ));
        }
    }
    std::fs::rename(&temporary, &destination).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })?;
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
    session_id: Option<String>,
) -> Result<String, String> {
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(
        request_client(&url, session_id.as_deref(), ignore_tls_errors, false)?.request(method, url),
        headers,
    );
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
    while let Some(chunk) = match response.chunk().await {
        Ok(chunk) => chunk,
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(&destination);
            return Err(error.to_string());
        }
    } {
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&destination);
            return Err(error.to_string());
        }
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
    session_id: Option<String>,
) -> Result<String, String> {
    let method = method
        .parse()
        .map_err(|error| format!("Invalid HTTP method: {error}"))?;
    let request = apply_headers(
        request_client(&url, session_id.as_deref(), ignore_tls_errors, false)?.request(method, url),
        headers,
    );
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
    let staging_directory = operation_storage_directory()?
        .join("drag-staging")
        .join(&safe_set_id);
    std::fs::create_dir_all(&staging_directory).map_err(|error| error.to_string())?;
    let destination =
        resolve_local_download_file(&staging_directory.to_string_lossy(), &relative_path)?;
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

/// Mirrors the frontend's "Allow legacy SSH algorithms for older servers"
/// Settings toggle into this process, called once on startup and again
/// whenever the user changes it, so every connect path (interactive
/// terminal, SFTP browser, key install) picks it up immediately.
#[tauri::command]
fn ssh_set_allow_legacy_algorithms(enabled: bool) {
    ssh::set_allow_legacy_algorithms(enabled);
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
fn rest_save_secret(entry_id: String, kind: String, value: String) -> Result<(), String> {
    ssh::save_rest_secret(entry_id, kind, value)
}

#[tauri::command]
fn rest_load_secret(entry_id: String, kind: String) -> Result<Option<String>, String> {
    ssh::load_rest_secret(entry_id, kind)
}

#[tauri::command]
fn rest_forget_secret(entry_id: String, kind: String) -> Result<(), String> {
    ssh::forget_rest_secret(entry_id, kind)
}

#[tauri::command]
fn proxmox_save_secret(entry_id: String, kind: String, value: String) -> Result<(), String> {
    ssh::save_proxmox_secret(&entry_id, &kind, &value)
}

#[tauri::command]
fn proxmox_load_secret(entry_id: String, kind: String) -> Result<Option<String>, String> {
    ssh::load_proxmox_secret(&entry_id, &kind)
}

#[tauri::command]
fn proxmox_forget_secret(entry_id: String, kind: String) -> Result<(), String> {
    ssh::forget_proxmox_secret(&entry_id, &kind)
}

#[tauri::command]
async fn proxmox_list_vms(
    entry: proxmox::VncEntry,
    password: String,
) -> Result<Vec<proxmox::VmSummary>, String> {
    proxmox::list_vms(entry, password).await
}

#[tauri::command]
async fn proxmox_login(entry: proxmox::VncEntry, password: String) -> Result<String, String> {
    proxmox::authenticate(entry, password).await
}

#[tauri::command]
async fn proxmox_logout(session_id: String) -> Result<(), String> {
    proxmox::logout(session_id).await
}

#[tauri::command]
async fn proxmox_list_vms_session(
    entry: proxmox::VncEntry,
    session_id: String,
) -> Result<Vec<proxmox::VmSummary>, String> {
    proxmox::list_vms_session(entry, session_id).await
}

#[tauri::command]
async fn proxmox_vnc_start_session(
    entry: proxmox::VncEntry,
    session_id: String,
) -> Result<proxmox::VncConnection, String> {
    proxmox::start_session(entry, session_id).await
}

#[tauri::command]
async fn proxmox_vnc_start(
    entry: proxmox::VncEntry,
    password: String,
) -> Result<proxmox::VncConnection, String> {
    proxmox::start(entry, password).await
}

#[tauri::command]
async fn proxmox_vnc_cancel(connection_id: String) -> Result<(), String> {
    proxmox::cancel(connection_id).await
}

#[tauri::command]
async fn direct_vnc_start(host: String, port: u16) -> Result<proxmox::VncConnection, String> {
    proxmox::start_direct(host, port).await
}

#[tauri::command]
async fn direct_vnc_cancel(connection_id: String) -> Result<(), String> {
    proxmox::cancel_direct(connection_id).await
}

/// QEMU Guest Agent file-transfer fallback commands (see `proxmox.rs`). Used
/// only when neither a direct nor a jump-host SFTP route to the VM is
/// reachable from this client.
#[tauri::command]
async fn proxmox_agent_ping(entry: proxmox::VncEntry, session_id: String) -> Result<(), String> {
    proxmox::agent_ping(entry, session_id).await
}

#[tauri::command]
async fn proxmox_agent_network_interfaces(
    entry: proxmox::VncEntry,
    session_id: String,
) -> Result<Vec<String>, String> {
    proxmox::agent_network_interfaces(entry, session_id).await
}

#[tauri::command]
async fn proxmox_agent_list_directory(
    entry: proxmox::VncEntry,
    session_id: String,
    path: String,
) -> Result<LocalDirectory, String> {
    proxmox::agent_list_directory(entry, session_id, path).await
}

#[tauri::command]
async fn proxmox_agent_download_file(
    app: tauri::AppHandle,
    entry: proxmox::VncEntry,
    session_id: String,
    transfer_id: String,
    remote_path: String,
    destination_folder: String,
) -> Result<String, String> {
    proxmox::agent_download_file(
        app,
        entry,
        session_id,
        transfer_id,
        remote_path,
        destination_folder,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn proxmox_agent_upload_file(
    app: tauri::AppHandle,
    entry: proxmox::VncEntry,
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    size_limit_bytes: u64,
) -> Result<(), String> {
    let local_path = resolve_local_read_entry(&local_path)?;
    proxmox::agent_upload_file(
        app,
        entry,
        session_id,
        transfer_id,
        local_path.display().to_string(),
        remote_path,
        size_limit_bytes,
    )
    .await
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
    let local_path = resolve_local_download_file(
        Path::new(&local_path)
            .parent()
            .and_then(|parent| parent.to_str())
            .unwrap_or_default(),
        Path::new(&local_path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Invalid local destination path".to_string())?,
    )?;
    ssh::sftp::download_file(profile, remote_path, local_path.display().to_string()).await
}

#[tauri::command]
async fn scp_upload(
    profile: ssh::SshProfile,
    local_path: String,
    remote_path: String,
) -> Result<String, String> {
    let local_path = resolve_local_read_entry(&local_path)?;
    ssh::sftp::upload_file(profile, local_path.display().to_string(), remote_path).await
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
    let local_path = resolve_local_read_entry(&local_path)?;
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

/// Save the completed disk-backed recording for `tab_id` (see the
/// `recording` module) into `destination_path`. This used to receive the
/// entire raw/plain/commands transcript as three `String` IPC arguments and
/// write them out in one shot; now that every chunk is already durable on
/// disk under `<install dir>/temp` the moment it arrives (`recording::
/// append_ssh_recording`), this only needs to copy those temp files to
/// their final, user-chosen home and compute metadata from the files
/// themselves -- never trusting a frontend-supplied byte count, which could
/// otherwise race an append that hadn't resolved yet.
#[tauri::command]
fn save_ssh_logs(
    tab_id: String,
    profile_name: String,
    host: String,
    destination_path: String,
    started_at_iso: Option<String>,
) -> Result<recording::SshLogPaths, String> {
    let directory = resolve_local_download_destination(&destination_path)?;
    recording::finalize_ssh_recording(tab_id, profile_name, host, &directory, started_at_iso)
}

/// Thin `#[tauri::command]` wrappers around the `recording` module's plain
/// functions (see that module's doc comment for the overall design) --
/// every other Tauri command in this codebase is likewise defined directly
/// in `main.rs` even when its supporting state/logic lives in a submodule
/// (compare `ssh_connect` here delegating to `ssh::` internals), so these
/// follow the same convention rather than annotating functions inside
/// `recording.rs` itself.
#[tauri::command]
fn start_ssh_recording(
    tab_id: String,
    raw_seed: String,
    plain_seed: String,
) -> Result<recording::RecordingStats, String> {
    recording::start_ssh_recording(tab_id, raw_seed, plain_seed)
}

#[tauri::command]
fn append_ssh_recording(
    tab_id: String,
    raw_chunk: String,
    plain_chunk: String,
) -> Result<recording::RecordingStats, String> {
    recording::append_ssh_recording(tab_id, raw_chunk, plain_chunk)
}

#[tauri::command]
fn append_ssh_recording_command(
    tab_id: String,
    line: String,
) -> Result<recording::RecordingStats, String> {
    recording::append_ssh_recording_command(tab_id, line)
}

#[tauri::command]
fn stop_ssh_recording(tab_id: String) -> Result<(), String> {
    recording::stop_ssh_recording(tab_id)
}

#[tauri::command]
fn discard_ssh_recording(tab_id: String) -> Result<(), String> {
    recording::discard_ssh_recording(tab_id)
}

fn validate_local_user_path(path: &str) -> Result<std::path::PathBuf, String> {
    resolve_local_read_entry(path)
}

fn decode_text_file(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        if !bytes[2..].len().is_multiple_of(2) {
            return Err("Text file has an incomplete UTF-16 code unit".to_string());
        }
        return String::from_utf16(&units)
            .map_err(|_| "Text file contains invalid UTF-16".to_string());
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        if !bytes[2..].len().is_multiple_of(2) {
            return Err("Text file has an incomplete UTF-16 code unit".to_string());
        }
        return String::from_utf16(&units)
            .map_err(|_| "Text file contains invalid UTF-16".to_string());
    }

    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "Only UTF-8 and UTF-16 text files can be viewed".to_string())
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
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    decode_text_file(&bytes)
}

#[tauri::command]
fn open_local_file(path: String) -> Result<(), String> {
    let path = validate_local_user_path(&path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Only regular files can be opened".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Use the Windows shell API directly so paths with spaces are not
        // reparsed by cmd.exe and do not receive an extra quote character.
        let wide_path: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                wide_path.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if (result as usize) <= 32 {
            Err(format!(
                "Unable to open file (ShellExecuteW error {result:?})"
            ))
        } else {
            Ok(())
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Unable to open file: {error}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Unable to open file: {error}"))
    }
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
fn read_operation_logs() -> Result<Vec<serde_json::Value>, String> {
    let (_, log_path) = operation_paths()?;
    let mut records = Vec::new();
    for path in [
        log_path.with_extension("log.2"),
        log_path.with_extension("log.1"),
        log_path,
    ] {
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        records.extend(
            content
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok()),
        );
    }
    Ok(records)
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
    // Drop oplog's cached open file handle first: it caches an appending
    // `BufWriter` across calls (see `oplog::write_line`) to avoid
    // re-opening the file on every log line, and that handle would
    // otherwise keep referencing the inode this function is about to
    // unlink, silently reappending to a now-deleted file on next write.
    oplog::invalidate_cached_writer();
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
    for suffix in [
        "operations.pretty.log",
        "operations.pretty.log.1",
        "operations.pretty.log.2",
    ] {
        let _ = std::fs::remove_file(operation_storage_directory()?.join(suffix));
    }
    Ok(())
}

#[tauri::command]
fn initialize_operation_log() -> Result<(), String> {
    // Same reason as in `clear_operation_logs` above: this function
    // renames/truncates `operations.log` directly on disk, so any cached
    // open handle in `oplog::write_line` must be dropped first or it would
    // keep writing through a stale file descriptor.
    oplog::invalidate_cached_writer();
    let staging_directory = operation_storage_directory()?.join("drag-staging");
    if staging_directory.exists() {
        std::fs::remove_dir_all(&staging_directory).map_err(|error| error.to_string())?;
    }
    for suffix in [
        "operations.pretty.log",
        "operations.pretty.log.1",
        "operations.pretty.log.2",
    ] {
        let _ = std::fs::remove_file(operation_storage_directory()?.join(suffix));
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
    // Apply the Rust-side mirrored setting as well. REST DEBUG records are
    // emitted directly from the workspace and do not pass through the
    // frontend's writeOperationLog helper.
    oplog::log(
        &level,
        &operation,
        &status,
        &source_label,
        &destination_label,
        &detail,
    );
    Ok(())
}

#[tauri::command]
fn append_structured_operation_log(record: serde_json::Value) -> Result<(), String> {
    let object = record
        .as_object()
        .ok_or_else(|| "Operation log record must be a JSON object".to_string())?;
    if !object
        .get("level")
        .and_then(serde_json::Value::as_str)
        .is_some()
        || !object
            .get("operation")
            .and_then(serde_json::Value::as_str)
            .is_some()
        || !object
            .get("status")
            .and_then(serde_json::Value::as_str)
            .is_some()
    {
        return Err("Operation log record requires level, operation, and status".to_string());
    }
    oplog::log_structured(record);
    Ok(())
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
    use super::{
        create_unique_download_file, decode_text_file, dedupe_candidate_name, sanitize_archive_name,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn decodes_utf8_and_utf8_bom() {
        assert_eq!(decode_text_file("hello".as_bytes()).unwrap(), "hello");
        assert_eq!(
            decode_text_file(&[0xEF, 0xBB, 0xBF, b'h', b'i']).unwrap(),
            "hi"
        );
    }

    #[test]
    fn decodes_utf16_little_and_big_endian_bom() {
        assert_eq!(
            decode_text_file(&[0xFF, 0xFE, b'h', 0, b'i', 0]).unwrap(),
            "hi"
        );
        assert_eq!(
            decode_text_file(&[0xFE, 0xFF, 0, b'h', 0, b'i']).unwrap(),
            "hi"
        );
    }

    #[test]
    fn rejects_invalid_text_encoding() {
        assert!(decode_text_file(&[0xFF, 0xFE, b'h']).is_err());
        assert!(decode_text_file(&[0xFF, 0xFE, 0, 0xD8]).is_err());
        assert!(decode_text_file(&[0xFF, 0x00, 0xFE]).is_err());
    }

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

    #[test]
    fn download_uses_a_hidden_part_file_until_completion() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("nfterm-download-{suffix}"));
        std::fs::create_dir_all(&directory).expect("temporary directory should be created");
        let requested = directory.join("ubuntu.iso");
        let (destination, temporary, file) =
            create_unique_download_file(&requested).expect("download part file should be created");
        assert_eq!(destination, requested);
        assert!(temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".part"));
        assert!(!destination.exists());
        assert!(temporary.exists());
        drop(file);
        let _ = std::fs::remove_dir_all(directory);
    }
}

#[cfg(test)]
mod native_session_tests {
    use super::*;
    use reqwest::cookie::CookieStore;
    use tokio::io::AsyncReadExt;

    #[test]
    fn canonical_origin_includes_scheme_and_effective_port() {
        assert_eq!(
            http_origin("HTTPS://EXAMPLE.COM:443/a").unwrap(),
            "https://example.com"
        );
        assert_ne!(
            http_origin("http://localhost:8000").unwrap(),
            http_origin("http://localhost:8001").unwrap()
        );
        assert_ne!(
            http_origin("http://localhost").unwrap(),
            http_origin("https://localhost").unwrap()
        );
        for invalid in [
            "not a URL",
            "file:///tmp/a",
            "ftp://example.com",
            "https://user:pass@example.com",
        ] {
            assert!(ApiSession::new(invalid, false).is_err());
        }
    }

    #[test]
    fn session_rejects_cross_port_host_scheme_and_tls_mismatch() {
        let session = ApiSession::new("https://example.com:8443", true).unwrap();
        for url in [
            "https://example.com:8444/a",
            "https://other.example:8443/a",
            "http://example.com:8443/a",
        ] {
            assert_eq!(
                session.client(url, true, false).unwrap_err(),
                "API session origin mismatch"
            );
        }
        assert_eq!(
            session
                .client("https://example.com:8443/a", false, true)
                .unwrap_err(),
            "API session TLS policy mismatch"
        );
        assert!(session.client("file:///tmp/a", true, false).is_err());
        assert!(session.clients.lock().unwrap().is_empty());
    }

    #[test]
    fn cookie_jars_are_isolated_even_when_cookie_domains_ignore_ports() {
        let first = ApiSession::new("http://localhost:8000", false).unwrap();
        let second = ApiSession::new("http://localhost:8001", false).unwrap();
        let later_login = ApiSession::new("http://localhost:8000", false).unwrap();
        let url = reqwest::Url::parse("http://localhost:8000/api").unwrap();
        let cross_port = reqwest::Url::parse("http://localhost:8001/api").unwrap();
        first
            .jar
            .add_cookie_str("session=first; HttpOnly; Path=/", &url);
        assert!(first.jar.cookies(&cross_port).is_some());
        assert!(second.jar.cookies(&cross_port).is_none());
        assert!(later_login.jar.cookies(&url).is_none());
        assert!(first.client(cross_port.as_str(), false, false).is_err());
    }

    #[test]
    fn clearing_is_idempotent_and_active_arcs_cannot_reach_new_login() {
        let id = create_api_session("https://example.com".into(), None).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        let old = API_SESSIONS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .clone();
        assert!(!old.ignore_tls_errors);
        clear_api_session(id.clone()).unwrap();
        clear_api_session(id.clone()).unwrap();
        assert_eq!(
            request_client("https://example.com", Some(&id), false, false).unwrap_err(),
            "Unknown or cleared API session"
        );
        let new_id = create_api_session("https://example.com".into(), Some(false)).unwrap();
        let new = API_SESSIONS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get(&new_id)
            .unwrap()
            .clone();
        assert_ne!(id, new_id);
        let url = reqwest::Url::parse("https://example.com/api").unwrap();
        old.jar
            .add_cookie_str("session=late-old-response; Path=/; Secure", &url);
        assert!(new.jar.cookies(&url).is_none());
        assert!(old.jar.cookies(&url).is_some());
        clear_api_session(new_id).unwrap();
    }

    #[tokio::test]
    async fn clients_are_cached_per_session_and_share_only_its_jar() {
        let session = ApiSession::new("https://example.com", false).unwrap();
        session
            .client("https://example.com/login", false, false)
            .unwrap();
        session
            .client("https://example.com/upload", false, false)
            .unwrap();
        assert_eq!(session.clients.lock().unwrap().len(), 1);
        session
            .client("https://example.com/download", false, true)
            .unwrap();
        assert_eq!(session.clients.lock().unwrap().len(), 2);
        // The generic REST jar is separate, and clearing a native handle must
        // not remove it or an unrelated native session.
        let generic = session_cookie_jar(false).unwrap();
        assert!(!Arc::ptr_eq(&generic, &session.jar));
        let id = create_api_session("https://example.com".into(), None).unwrap();
        clear_api_session(id).unwrap();
        assert!(Arc::ptr_eq(&generic, &session_cookie_jar(false).unwrap()));
    }

    #[test]
    fn earlier_cancel_is_not_reset_and_other_attempts_are_unaffected() {
        let id = uuid::Uuid::new_v4().to_string();
        cancel_transfer(id.clone()).unwrap();
        assert!(UploadAttempt::start(id.clone()).is_err());
        assert!(is_transfer_cancelled(&id));
        let next = UploadAttempt::start(uuid::Uuid::new_v4().to_string()).unwrap();
        assert!(!next.cancellation.is_cancelled());
        // Only remove this test's marker, not any application's shared state.
        reset_transfer_cancellation(&id);
    }

    #[tokio::test]
    async fn cancellation_wakes_response_wait_and_drops_pending_work() {
        let attempt = UploadAttempt::start(uuid::Uuid::new_v4().to_string()).unwrap();
        let id = attempt.id.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (dropped_tx, mut dropped_rx) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let result: Result<(), String> = await_upload(&attempt.cancellation, async move {
                let _drop_signal = dropped_tx;
                started_tx.send(()).unwrap();
                std::future::pending().await
            })
            .await;
            result
        });
        started_rx.await.unwrap();
        cancel_transfer(id.clone()).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("server outcome is unconfirmed"));
        assert_eq!(
            dropped_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        );
        assert!(!UPLOAD_ATTEMPTS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .contains_key(&id));
        reset_transfer_cancellation(&id);
    }

    #[tokio::test]
    async fn complete_response_wins_late_cancel_without_inventing_success() {
        for status in [202, 400, 500] {
            let cancellation = UploadCancellation::new();
            cancellation.cancel();
            let response = reqwest::Response::from(
                http::Response::builder()
                    .status(status)
                    .body(r#"{"batchId":"owned-batch"}"#)
                    .unwrap(),
            );
            let result = await_upload(&cancellation, response_from(response))
                .await
                .unwrap();
            assert_eq!(result.status, status);
            assert_eq!(result.body, br#"{"batchId":"owned-batch"}"#);
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_incomplete_response_body() {
        let cancellation = Arc::new(UploadCancellation::new());
        let signal = cancellation.clone();
        let stream = futures_util::stream::pending::<Result<Vec<u8>, std::io::Error>>();
        let response = reqwest::Response::from(
            http::Response::builder()
                .status(202)
                .body(reqwest::Body::wrap_stream(stream))
                .unwrap(),
        );
        let task =
            tokio::spawn(async move { await_upload(&cancellation, response_from(response)).await });
        signal.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }

    #[test]
    fn attempt_drop_signals_body_and_removes_registry_entry() {
        let id = uuid::Uuid::new_v4().to_string();
        let attempt = UploadAttempt::start(id.clone()).unwrap();
        assert!(UploadAttempt::start(id.clone()).is_err());
        let signal = attempt.cancellation.clone();
        drop(attempt);
        assert!(signal.is_cancelled());
        assert!(!UPLOAD_ATTEMPTS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .contains_key(&id));
    }

    #[tokio::test]
    async fn progress_counts_actual_reads_across_files_including_zero() {
        let count = Arc::new(AtomicU64::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        for bytes in [b"ab".as_slice(), b"".as_slice(), b"cde".as_slice()] {
            let captured = events.clone();
            let mut reader = UploadProgressReader {
                inner: bytes,
                cancellation: Arc::new(UploadCancellation::new()),
                completed: count.clone(),
                emit: Arc::new(move |count| captured.lock().unwrap().push(count)),
                last_emit: Instant::now() - Duration::from_secs(1),
            };
            reader.read_to_end(&mut Vec::new()).await.unwrap();
        }
        assert_eq!(count.load(Ordering::Relaxed), 5);
        assert_eq!(*events.lock().unwrap(), vec![2, 5]);
        let zero = serde_json::to_value(UploadProgressEvent {
            transfer_id: "empty".into(),
            bytes_completed: 0,
            bytes_total: 0,
        })
        .unwrap();
        assert_eq!(zero["bytesCompleted"], 0);
        assert_eq!(zero["bytesTotal"], 0);
    }

    #[test]
    fn cancellation_wakes_a_pending_source_read_without_counting_bytes() {
        struct WakeCount(AtomicU64);
        impl futures_util::task::ArcWake for WakeCount {
            fn wake_by_ref(arc_self: &Arc<Self>) {
                arc_self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let (input, _writer) = tokio::io::duplex(16);
        let cancellation = Arc::new(UploadCancellation::new());
        let count = Arc::new(AtomicU64::new(0));
        let mut reader = UploadProgressReader {
            inner: input,
            cancellation: cancellation.clone(),
            completed: count.clone(),
            emit: Arc::new(|_| panic!("No bytes were read")),
            last_emit: Instant::now(),
        };
        let wakes = Arc::new(WakeCount(AtomicU64::new(0)));
        let waker = futures_util::task::waker(wakes.clone());
        let mut cx = Context::from_waker(&waker);
        let mut bytes = [0; 8];
        let mut buffer = ReadBuf::new(&mut bytes);
        assert!(Pin::new(&mut reader)
            .poll_read(&mut cx, &mut buffer)
            .is_pending());
        cancellation.cancel();
        assert_eq!(wakes.0.load(Ordering::Relaxed), 1);
        assert!(matches!(
            Pin::new(&mut reader).poll_read(&mut cx, &mut buffer),
            Poll::Ready(Err(_))
        ));
        assert_eq!(count.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn early_http_error_preserves_partial_read_count() {
        let completed = Arc::new(AtomicU64::new(0));
        let cancellation = Arc::new(UploadCancellation::new());
        let mut reader = UploadProgressReader {
            inner: b"sixbytes".as_slice(),
            cancellation: cancellation.clone(),
            completed: completed.clone(),
            emit: Arc::new(|_| {}),
            last_emit: Instant::now(),
        };
        reader.read_exact(&mut [0; 2]).await.unwrap();
        let response = reqwest::Response::from(
            http::Response::builder()
                .status(413)
                .body("rejected")
                .unwrap(),
        );
        assert_eq!(
            await_upload(&cancellation, response_from(response))
                .await
                .unwrap()
                .status,
            413
        );
        cancellation.cancel();
        assert!(reader.read(&mut [0; 8]).await.is_err());
        assert_eq!(completed.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn actual_backend_cookie_upload_cancellation_and_logout() {
        use std::io::BufRead;
        use std::process::{Child, Command, Stdio};

        struct Fixture {
            child: Option<Child>,
            reader: Option<std::thread::JoinHandle<()>>,
            root: PathBuf,
            sessions: Vec<String>,
        }
        impl Fixture {
            fn stop(&mut self) {
                if let Some(mut child) = self.child.take() {
                    let _ = child.kill();
                    child.wait().expect("reap owned Node fixture");
                }
                if let Some(reader) = self.reader.take() {
                    reader.join().expect("join fixture stdout reader");
                }
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                self.stop();
                for id in self.sessions.drain(..) {
                    let _ = clear_api_session(id);
                }
                // Only this UUID directory was created by this test. Never
                // delete the shared opencode parent or a child-supplied path.
                std::fs::remove_dir_all(&self.root).expect("remove owned fixture directory");
            }
        }
        async fn send(
            origin: &str,
            session: &str,
            endpoint: &str,
            method: &str,
            headers: &[(String, String)],
            body: Option<serde_json::Value>,
        ) -> ApiResponse {
            let mut headers = headers.to_vec();
            if body.is_some() {
                headers.push(("Content-Type".into(), "application/json".into()));
            }
            tokio::time::timeout(
                Duration::from_secs(10),
                api_request(
                    format!("{origin}{endpoint}"),
                    method.into(),
                    headers,
                    body.map(|value| serde_json::to_vec(&value).unwrap()),
                    false,
                    Some(session.into()),
                ),
            )
            .await
            .expect("native API request deadline")
            .expect("native API transport")
        }
        fn json(response: ApiResponse, status: u16) -> serde_json::Value {
            assert_eq!(
                response.status,
                status,
                "{}",
                String::from_utf8_lossy(&response.body)
            );
            serde_json::from_slice(&response.body).expect("backend JSON response")
        }

        let parent = std::env::temp_dir().join("opencode");
        assert!(
            parent.is_dir(),
            "approved temporary parent must already exist"
        );
        let root = parent
            .canonicalize()
            .unwrap()
            .join(format!("native-backend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).expect("create exclusive disposable fixture directory");
        let mut fixture = Fixture {
            child: None,
            reader: None,
            root: root.clone(),
            sessions: vec![],
        };
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../checks/backend-fixture.cjs");
        // Keep only executable/system/temp lookup variables. In particular,
        // NODE_OPTIONS, dotenv flags, credentials and proxy configuration are
        // not inherited by the child. This does not mutate the Rust process env.
        let environment = ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]
            .into_iter()
            .filter_map(|key| std::env::var_os(key).map(|value| (key, value)));
        fixture.child = Some(
            Command::new("node")
                .arg(script)
                .arg(&root)
                .current_dir(&root)
                .env_clear()
                .envs(environment)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("start test-owned Node fixture; no dependency fetch"),
        );
        let stdout = fixture.child.as_mut().unwrap().stdout.take().unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        fixture.reader = Some(std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(stdout.take(4096))
                .read_line(&mut line)
                .map(|_| line);
            let _ = ready_tx.send(result);
        }));
        let ready = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("bounded fixture startup")
            .expect("fixture stdout");
        let ready: serde_json::Value =
            serde_json::from_str(&ready).expect("fixture emits one ready JSON line");
        let port = ready["port"]
            .as_u64()
            .filter(|port| (1..=65535).contains(port))
            .expect("ephemeral fixture port");
        let origin = format!("http://127.0.0.1:{port}");
        let admin = create_api_session(origin.clone(), None).unwrap();
        fixture.sessions.push(admin.clone());
        let user = create_api_session(origin.clone(), None).unwrap();
        fixture.sessions.push(user.clone());

        tokio::time::timeout(Duration::from_secs(40), async {
            json(
                send(&origin, &admin, "/api/locations", "GET", &[], None).await,
                401,
            );
            for (session, username, id) in
                [(&admin, "fixture-admin", 0), (&user, "fixture-user", 7)]
            {
                let response = send(
                    &origin,
                    session,
                    "/auth/login",
                    "POST",
                    &[],
                    Some(serde_json::json!({
                        "username": username, "password": "native-fixture-password"
                    })),
                )
                .await;
                assert!(response
                    .headers
                    .iter()
                    .any(|(name, value)| name == "set-cookie" && value.contains("HttpOnly")));
                let login = json(response, 200);
                assert_eq!(login["user"]["id"], id);
                assert!(login.get("token").is_none());
                let verified = json(
                    send(&origin, session, "/auth/verify", "POST", &[], None).await,
                    200,
                );
                assert_eq!(verified["user"]["id"], id);
            }
            // All subsequent authentication uses the native jar, not copied
            // Cookie/Authorization headers or a test-signed JWT.
            let locations = json(
                send(&origin, &admin, "/api/locations", "GET", &[], None).await,
                200,
            );
            let revision = locations["locations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|location| location["id"] == "default")
                .unwrap()["revision"]
                .as_str()
                .unwrap()
                .to_string();
            assert!(!revision.is_empty());
            let headers = vec![
                ("X-Location-ID".into(), "default".into()),
                ("X-Location-Revision".into(), revision),
            ];
            let mut stale = headers.clone();
            stale[1].1 = "stale-revision".into();
            json(
                send(&origin, &admin, "/api/files", "GET", &stale, None).await,
                409,
            );
            json(
                send(&origin, &admin, "/api/files", "GET", &headers, None).await,
                200,
            );

            for (filename, contents, cancel) in [
                ("cancelled.txt", b"cancel this upload".as_slice(), true),
                ("completed.txt", b"native measured bytes".as_slice(), false),
            ] {
                let reserved = json(
                    send(
                        &origin,
                        &admin,
                        "/api/upload/batches",
                        "POST",
                        &headers,
                        Some(serde_json::json!({ "path": "" })),
                    )
                    .await,
                    201,
                );
                let batch = reserved["batchId"].as_str().unwrap();
                let progress_url = format!("/api/progress/batch/{batch}");
                if cancel {
                    assert_eq!(
                        json(
                            send(&origin, &admin, "/__test/hold", "POST", &[], None).await,
                            200
                        )["held"],
                        true
                    );
                }
                let completed = Arc::new(AtomicU64::new(0));
                let reader = UploadProgressReader {
                    inner: contents,
                    cancellation: Arc::new(UploadCancellation::new()),
                    completed: completed.clone(),
                    emit: Arc::new(|_| {}),
                    last_emit: Instant::now(),
                };
                let part = multipart::Part::stream_with_length(
                    reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(reader)),
                    contents.len() as u64,
                )
                .file_name(filename.to_string());
                let form = multipart::Form::new()
                    .text("path", "")
                    .text("filePaths[]", filename)
                    .part("files", part);
                let url = format!("{origin}/api/upload/multiple");
                let mut upload_headers = headers.clone();
                upload_headers.push(("X-Upload-Batch-ID".into(), batch.into()));
                // api_upload_paths requires a live AppHandle. Exercise its real
                // session client, progress reader, multipart and response core
                // against the actual backend parser without launching Tauri.
                let request = apply_headers(
                    request_client(&url, Some(&admin), false, false)
                        .unwrap()
                        .post(url)
                        .multipart(form),
                    upload_headers,
                );
                let accepted = json(
                    response_from(request.send().await.unwrap()).await.unwrap(),
                    202,
                );
                assert_eq!(accepted["batchId"], batch);
                assert_eq!(completed.load(Ordering::Relaxed), contents.len() as u64);
                json(
                    send(&origin, &user, &progress_url, "GET", &headers, None).await,
                    404,
                );
                json(
                    send(
                        &origin,
                        &user,
                        &format!("{progress_url}/cancel"),
                        "POST",
                        &headers,
                        None,
                    )
                    .await,
                    404,
                );
                if cancel {
                    let pending = json(
                        send(&origin, &admin, &progress_url, "GET", &headers, None).await,
                        200,
                    );
                    assert_eq!(pending["pendingCount"], 1);
                    assert_eq!(pending["totalSize"], contents.len());
                    let cancelled = json(
                        send(
                            &origin,
                            &admin,
                            &format!("{progress_url}/cancel"),
                            "POST",
                            &headers,
                            None,
                        )
                        .await,
                        200,
                    );
                    assert_eq!(cancelled["status"], "cancelled");
                    assert_eq!(cancelled["cancelledCount"], 1);
                    assert_eq!(cancelled["successCount"], 0);
                    let empty = json(
                        send(&origin, &admin, "/__test/inspect", "GET", &[], None).await,
                        200,
                    );
                    assert_eq!(
                        empty,
                        serde_json::json!({ "storage": { "files": 0, "bytes": 0 },
                        "staging": { "files": 0, "bytes": 0 }, "forbiddenCalls": [] })
                    );
                    json(
                        send(&origin, &admin, "/__test/release", "POST", &[], None).await,
                        200,
                    );
                    let after_release = json(
                        send(&origin, &admin, "/__test/inspect", "GET", &[], None).await,
                        200,
                    );
                    assert_eq!(after_release, empty);
                } else {
                    // Inspect waits for actual worker settlement, not a guessed delay.
                    let inspected = json(
                        send(&origin, &admin, "/__test/inspect", "GET", &[], None).await,
                        200,
                    );
                    assert_eq!(
                        inspected,
                        serde_json::json!({ "storage": { "files": 1, "bytes": contents.len() },
                        "staging": { "files": 0, "bytes": 0 }, "forbiddenCalls": [] })
                    );
                    let progress = json(
                        send(&origin, &admin, &progress_url, "GET", &headers, None).await,
                        200,
                    );
                    assert_eq!(progress["status"], "completed");
                    assert_eq!(progress["totalSize"], contents.len());
                    assert_eq!(progress["transferredSize"], contents.len());
                    assert_eq!(progress["successCount"], 1);
                    let downloaded = send(
                        &origin,
                        &admin,
                        &format!("/api/files/download/{filename}"),
                        "GET",
                        &headers,
                        None,
                    )
                    .await;
                    assert_eq!(downloaded.status, 200);
                    assert_eq!(downloaded.body, contents);
                }
            }
            json(
                send(&origin, &admin, "/auth/logout", "POST", &[], None).await,
                200,
            );
            json(
                send(&origin, &admin, "/api/locations", "GET", &[], None).await,
                401,
            );
            json(
                send(&origin, &user, "/api/locations", "GET", &[], None).await,
                200,
            );
        })
        .await
        .expect("real backend integration deadline");

        fixture.stop();
        // Simulate logout network failure, then clear the still-authenticated
        // second session. Invalidated handles must fail before network dispatch.
        let failed_logout = api_request(
            format!("{origin}/auth/logout"),
            "POST".into(),
            vec![],
            None,
            false,
            Some(user.clone()),
        );
        assert!(tokio::time::timeout(Duration::from_secs(3), failed_logout)
            .await
            .unwrap()
            .is_err());
        clear_api_session(user.clone()).unwrap();
        clear_api_session(user.clone()).unwrap();
        let invalidated = api_request(
            format!("{origin}/api/locations"),
            "GET".into(),
            vec![],
            None,
            false,
            Some(user),
        )
        .await;
        assert!(matches!(invalidated, Err(error) if error == "Unknown or cleared API session"));
        drop(fixture);
        assert!(!root.exists(), "owned fixture directory was removed");
        println!("Real backend gate: numeric 0/7 cookie auth; Location revision 409; reserved multipart 202; foreign batch 404; confirmed cancellation with zero outputs; measured completion/download; logout 401; failed-network handle clear; child reaped and owned temp removed");
    }
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|_app| {
            // Any file still sitting in `<install dir>/temp` at startup can
            // only be an orphan from a previous run's unsaved recording
            // (crash, force-quit, or a discarded tab) -- see
            // `recording::cleanup_stale_recording_temp_files`'s own doc
            // comment for why this is safe to always do unconditionally.
            recording::cleanup_stale_recording_temp_files();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_api_session,
            clear_api_session,
            api_request,
            tcp_check_reachable,
            ssh_check_transport_reachable,
            pick_upload_files,
            pick_local_directory,
            save_text_file,
            create_iml_csv_session,
            append_iml_csv_session,
            local_list_directory,
            local_list_directories,
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
            open_local_file,
            cancel_transfer,
            download_to_disk,
            download_to_disk_at,
            download_to_drag_staging,
            download_to_drag_staging_at,
            cleanup_drag_staging,
            ssh_connect,
            ssh_set_allow_legacy_algorithms,
            ssh_key_available,
            ssh_install_key,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_save_password,
            ssh_forget_password,
            ssh_has_password,
            rest_save_secret,
            rest_load_secret,
            rest_forget_secret,
            proxmox_save_secret,
            proxmox_load_secret,
            proxmox_forget_secret,
            proxmox_list_vms,
            proxmox_login,
            proxmox_logout,
            proxmox_list_vms_session,
            proxmox_vnc_start_session,
            proxmox_vnc_start,
            proxmox_vnc_cancel,
            direct_vnc_start,
            direct_vnc_cancel,
            proxmox_agent_ping,
            proxmox_agent_network_interfaces,
            proxmox_agent_list_directory,
            proxmox_agent_download_file,
            proxmox_agent_upload_file,
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
            start_ssh_recording,
            append_ssh_recording,
            append_ssh_recording_command,
            stop_ssh_recording,
            discard_ssh_recording,
            read_local_file,
            edit_local_file,
            operation_storage_info,
            read_operation_logs,
            clear_operation_history,
            clear_operation_logs,
            initialize_operation_log,
            append_operation_log,
            append_structured_operation_log,
            set_operation_log_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running nFterm desktop application");
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize, dedupe_candidate_name, is_local_read_scope, is_within_home_or_elevated,
        local_create_directory, local_delete_path, local_display_path, local_list_directory,
        local_rename_path, local_roots, resolve_local_download_destination,
        resolve_local_download_file, resolve_local_new_path, resolve_local_read_entry,
        resolve_local_read_path, resolve_local_transfer_path, UploadProgressEvent,
    };
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    // `HOME` is a process-wide env var; serialize every test that mutates it
    // so they can't stomp on each other when cargo runs tests in parallel
    // threads (same pattern as oplog::tests::TEST_LOCK).
    static HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home<T>(run: impl FnOnce(&std::path::Path) -> T) -> T {
        let _lock = HOME_ENV_LOCK
            .lock()
            .expect("home env lock should not be poisoned");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let home = std::env::temp_dir().join(format!("nfterm-home-{suffix}"));
        fs::create_dir_all(&home).expect("temporary home directory should be created");
        let previous_home = std::env::var_os("HOME");
        #[cfg(windows)]
        let previous_user_profile = std::env::var_os("USERPROFILE");
        std::env::set_var("HOME", &home);
        #[cfg(windows)]
        std::env::set_var("USERPROFILE", &home);
        let result = run(&home);
        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        #[cfg(windows)]
        match previous_user_profile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = fs::remove_dir_all(&home);
        result
    }

    #[test]
    fn is_within_home_or_elevated_only_allows_containment_or_elevation() {
        let home = std::path::Path::new("/home/alice");
        let inside = std::path::Path::new("/home/alice/Desktop/file.txt");
        let outside = std::path::Path::new("/tmp/file.txt");
        assert!(is_within_home_or_elevated(inside, home, false));
        assert!(is_within_home_or_elevated(inside, home, true));
        assert!(!is_within_home_or_elevated(outside, home, false));
        assert!(is_within_home_or_elevated(outside, home, true));
    }

    #[cfg(windows)]
    #[test]
    fn regular_windows_users_can_use_other_drive_letters_but_not_c_root() {
        let home = std::path::Path::new(r"C:\Users\alice");
        assert!(is_within_home_or_elevated(
            std::path::Path::new(r"C:\Users\alice\Desktop"),
            home,
            false,
        ));
        assert!(!is_within_home_or_elevated(
            std::path::Path::new(r"C:\Windows"),
            home,
            false,
        ));
        assert!(is_within_home_or_elevated(
            std::path::Path::new(r"D:\Projects"),
            home,
            false,
        ));
        assert!(!is_within_home_or_elevated(
            std::path::Path::new(r"\\server\share"),
            home,
            false,
        ));
    }

    #[test]
    fn resolve_local_transfer_path_accepts_an_absolute_path_inside_home() {
        with_temp_home(|home| {
            let desktop = home.join("Desktop");
            fs::create_dir_all(&desktop).expect("Desktop directory should be created");
            let file = desktop.join("report.txt");
            fs::write(&file, b"hello").expect("test file should be written");
            // Regression test for the confirmed bug: a native file-picker
            // dialog always returns an absolute path, even for a file that
            // is legitimately inside the user's own home directory -- this
            // must resolve successfully without requiring elevation.
            let resolved = resolve_local_transfer_path(&file.display().to_string())
                .expect("a file inside home should resolve without elevation");
            assert!(
                resolved.ends_with("Desktop/report.txt")
                    || resolved.ends_with("Desktop\\report.txt")
            );
        });
    }

    #[test]
    fn local_read_sources_accept_files_directories_and_home() {
        with_temp_home(|home| {
            let folder = home.join("source folder");
            fs::create_dir(&folder).unwrap();
            let file = folder.join("source.txt");
            fs::write(&file, b"source bytes").unwrap();
            for (relative, absolute) in [
                ("", home.to_path_buf()),
                ("source folder", folder.clone()),
                ("source folder/source.txt", file.clone()),
            ] {
                let expected = canonicalize(&absolute).unwrap();
                assert_eq!(resolve_local_read_entry(relative).unwrap(), expected);
                assert_eq!(
                    resolve_local_read_entry(absolute.to_str().unwrap()).unwrap(),
                    expected
                );
            }
            assert_eq!(
                fs::read(resolve_local_read_entry("source folder/source.txt").unwrap()).unwrap(),
                b"source bytes"
            );
            assert!(resolve_local_read_path(file.to_str().unwrap()).is_err());
            assert_eq!(
                local_list_directory("source folder".into()).unwrap().path,
                "source folder"
            );
            assert_eq!(local_list_directory("".into()).unwrap().path, "");
        });
    }

    #[test]
    fn local_read_sources_reject_missing_invalid_and_traversal_paths() {
        with_temp_home(|home| {
            fs::create_dir(home.join("folder")).unwrap();
            fs::write(home.join("file"), b"source bytes").unwrap();
            for path in [
                "missing-source",
                "bad\0name",
                "../outside",
                "folder/../file",
            ] {
                let entry_error = resolve_local_read_entry(path).unwrap_err();
                let directory_error = resolve_local_read_path(path).unwrap_err();
                if path.contains("..") {
                    assert!(entry_error.contains("must not contain '..'"), "{path:?}");
                    assert!(
                        directory_error.contains("must not contain '..'"),
                        "{path:?}"
                    );
                }
            }
            let absolute_traversal = home.join("..").join("outside");
            assert!(
                resolve_local_read_entry(absolute_traversal.to_str().unwrap())
                    .unwrap_err()
                    .contains("must not contain '..'")
            );
            assert!(
                resolve_local_read_entry(home.join("missing-source").to_str().unwrap()).is_err()
            );
            #[cfg(windows)]
            assert!(resolve_local_read_entry(r"folder\..\file")
                .unwrap_err()
                .contains("must not contain '..'"));
        });
    }

    #[test]
    fn local_mutations_are_enabled_but_remain_home_scoped() {
        with_temp_home(|home| {
            local_create_directory("created".into()).expect("HOME folder creation should work");
            fs::write(home.join("original.txt"), b"bytes").unwrap();
            let renamed = local_rename_path("original.txt".into(), "renamed.txt".into()).expect("HOME rename should work");
            assert_eq!(renamed, "renamed.txt");
            assert!(home.join("renamed.txt").is_file());
            local_delete_path("renamed.txt".into(), false).expect("HOME delete should work");
            assert!(!home.join("renamed.txt").exists());
            assert!(local_create_directory("../outside".into()).is_err());
        });
    }

    #[test]
    fn local_read_scope_does_not_relax_destination_scope() {
        #[cfg(windows)]
        let (home, outside) = (
            std::path::Path::new(r"C:\Users\alice"),
            std::path::Path::new(r"C:\Windows"),
        );
        #[cfg(not(windows))]
        let (home, outside) = (
            std::path::Path::new("/home/alice"),
            std::path::Path::new("/tmp"),
        );
        assert!(is_local_read_scope(outside, home, false));
        assert!(!is_within_home_or_elevated(outside, home, false));
        assert!(is_within_home_or_elevated(outside, home, true));
        assert!(is_local_read_scope(home, home, false));
        assert!(is_within_home_or_elevated(home, home, false));
        with_temp_home(|home| {
            let outside = canonicalize(home.parent().unwrap()).unwrap();
            assert_eq!(
                resolve_local_read_entry(outside.to_str().unwrap()).unwrap(),
                outside
            );
            if !super::is_elevated() {
                assert!(resolve_local_transfer_path(outside.to_str().unwrap()).is_err());
            }
        });
    }

    #[test]
    fn local_root_identities_match_directory_listings_and_are_unique() {
        with_temp_home(|_| {
            let roots = local_roots();
            let unique: std::collections::HashSet<_> = roots.iter().collect();
            assert_eq!(unique.len(), roots.len());
            for root in roots {
                assert!(!root.is_empty());
                assert_eq!(local_list_directory(root.clone()).unwrap().path, root);
            }
        });
    }

    #[test]
    fn local_display_keeps_home_relative_identities() {
        with_temp_home(|home| {
            assert_eq!(local_display_path(Some(home), home).unwrap(), "");
            assert_eq!(
                local_display_path(Some(home), &home.join("Documents")).unwrap(),
                "Documents"
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn local_windows_root_display_normalizes_verbatim_and_unc_trailing_slashes() {
        for (path, expected) in [
            (r"C:\", "C:/"),
            (r"\\?\C:\", "C:/"),
            (r"\\server\share", "//server/share"),
            (r"\\server\share\", "//server/share"),
            (r"\\?\UNC\server\share\", "//server/share"),
            (r"\\?\UNC\server\share\folder", "//server/share/folder"),
        ] {
            let path = super::strip_verbatim_prefix(std::path::PathBuf::from(path));
            assert_eq!(local_display_path(None, &path).unwrap(), expected);
        }
    }

    #[test]
    fn resolve_local_download_destination_accepts_an_absolute_path_inside_home() {
        with_temp_home(|home| {
            let downloads = home.join("Downloads");
            let resolved = resolve_local_download_destination(&downloads.display().to_string())
                .expect("a not-yet-existing folder inside home should resolve without elevation");
            assert!(resolved.ends_with("Downloads"));
            assert!(resolved.is_dir());
        });
    }

    #[test]
    fn resolve_local_new_path_accepts_an_absolute_parent_inside_home() {
        with_temp_home(|home| {
            let target = home.join("notes.txt");
            let resolved = resolve_local_new_path(&target.display().to_string())
                .expect("a new file whose parent is inside home should resolve without elevation");
            assert!(resolved.ends_with("notes.txt"));
        });
    }

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

    #[test]
    fn queued_download_paths_reject_absolute_and_parent_components() {
        assert!(resolve_local_download_file(".", "../outside.txt").is_err());
        assert!(resolve_local_download_file(".", "/outside.txt").is_err());
    }
}
