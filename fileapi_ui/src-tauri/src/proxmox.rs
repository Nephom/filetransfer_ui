use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::de::{DeserializeOwned, Deserializer, Error as DeError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::{accept_hdr_async, Connector, WebSocketStream};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VncEntry {
    pub base_url: String,
    pub username: String,
    pub node: String,
    pub vmid: Option<u64>,
    pub guest_type: String,
    pub ignore_tls_errors: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VmSummary {
    pub vmid: u64,
    pub name: Option<String>,
    pub node: String,
    pub status: Option<String>,
    pub guest_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncConnection {
    pub id: String,
    pub websocket_url: String,
    pub password: String,
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct LoginData {
    ticket: String,
    #[serde(rename = "CSRFPreventionToken")]
    csrf_token: String,
}

#[derive(Deserialize)]
struct ProxyData {
    #[serde(deserialize_with = "deserialize_port")]
    port: u16,
    ticket: String,
    password: Option<String>,
}

fn deserialize_port<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Port {
        Number(u16),
        Text(String),
    }

    match Port::deserialize(deserializer)? {
        Port::Number(port) => Ok(port),
        Port::Text(port) => port
            .parse::<u16>()
            .map_err(|error| D::Error::custom(format!("invalid VNC port: {error}"))),
    }
}

#[derive(Deserialize)]
struct ClusterVm {
    vmid: u64,
    name: Option<String>,
    node: String,
    status: Option<String>,
    #[serde(rename = "type")]
    guest_type: String,
}

#[derive(Clone)]
struct PendingConnection {
    operation_id: String,
    cookie: String,
    websocket_url: String,
    ignore_tls_errors: bool,
    relay_token: String,
}

#[derive(Clone)]
struct AuthSession {
    client: Client,
    ticket: String,
    csrf_token: String,
}

#[derive(Debug)]
struct AcceptAnyCertificate;

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PKCS1_SHA256,
        ]
    }
}

static PENDING: OnceLock<Arc<Mutex<HashMap<String, PendingConnection>>>> = OnceLock::new();
static AUTH_SESSIONS: OnceLock<Arc<Mutex<HashMap<String, AuthSession>>>> = OnceLock::new();

fn pending() -> &'static Arc<Mutex<HashMap<String, PendingConnection>>> {
    PENDING.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn auth_sessions() -> &'static Arc<Mutex<HashMap<String, AuthSession>>> {
    AUTH_SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn normalized_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Proxmox base URL is invalid".to_string())?;
    if url.scheme() != "https" {
        return Err("Proxmox base URL must start with https://".to_string());
    }
    if url.host_str().is_none() {
        return Err("Proxmox base URL must include a host".to_string());
    }
    Ok(url)
}

fn api_url(base: &Url, path: &str) -> Result<Url, String> {
    let value = format!(
        "{}/{}",
        base.as_str().trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    Url::parse(&value).map_err(|_| "Proxmox API URL is invalid".to_string())
}

fn client(ignore_tls_errors: bool) -> Result<Client, String> {
    Client::builder()
        .danger_accept_invalid_certs(ignore_tls_errors)
        .danger_accept_invalid_hostnames(ignore_tls_errors)
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())
}

fn endpoint_label(entry: &VncEntry) -> String {
    Url::parse(entry.base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "invalid-proxmox-host".to_string())
}

async fn api_error(stage: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = match response.bytes().await {
        Ok(body) => String::from_utf8_lossy(&body).chars().take(2048).collect(),
        Err(error) => format!("Unable to read response body: {error}"),
    };
    format!("Proxmox {stage} failed ({status}): {body}")
}

async fn decode_api<T: DeserializeOwned>(
    stage: &str,
    response: reqwest::Response,
) -> Result<T, String> {
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Unable to read Proxmox {stage} response: {error}"))?;
    serde_json::from_slice(&body)
        .map_err(|error| format!("Invalid Proxmox {stage} response: {error}"))
}

async fn login(entry: &VncEntry, password: &str) -> Result<(Client, String, String), String> {
    let base = normalized_url(&entry.base_url)?;
    let label = endpoint_label(entry);
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let http = client(entry.ignore_tls_errors)?;
    crate::oplog::log(
        "INFO",
        "proxmox_vnc",
        "ticket_login_started",
        &label,
        "proxmox",
        &serde_json::json!({"operationId": operation_id, "username": entry.username, "target": "api2/json/access/ticket"}).to_string(),
    );
    let response = http
        .post(api_url(&base, "api2/json/access/ticket")?)
        .form(&[
            ("username", entry.username.as_str()),
            ("password", password),
        ])
        .send()
        .await
        .map_err(|error| {
            let message = format!("Unable to reach Proxmox ticket endpoint: {error}");
            crate::oplog::log(
                "ERROR",
                "proxmox_vnc",
                "ticket_login_failed",
                &label,
                "proxmox",
                &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "failureType": "network", "error": message}).to_string(),
            );
            message
        })?;
    if !response.status().is_success() {
        let message = api_error("ticket login", response).await;
        crate::oplog::log(
            "ERROR",
            "proxmox_vnc",
            "ticket_login_failed",
            &label,
            "proxmox",
            &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "failureType": "http", "error": message}).to_string(),
        );
        return Err(message);
    }
    let data: ApiEnvelope<LoginData> =
        decode_api("ticket login", response)
            .await
            .map_err(|error| {
                let message = format!("Invalid Proxmox ticket response: {error}");
                crate::oplog::log(
                    "ERROR",
                    "proxmox_vnc",
                    "ticket_login_failed",
                    &label,
                    "proxmox",
                    &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "failureType": "parse", "error": message}).to_string(),
                );
                message
            })?;
    crate::oplog::log(
        "INFO",
        "proxmox_vnc",
        "ticket_login_succeeded",
        &label,
        "proxmox",
        &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis()}).to_string(),
    );
    Ok((http, data.data.ticket, data.data.csrf_token))
}

pub async fn list_vms(entry: VncEntry, password: String) -> Result<Vec<VmSummary>, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = endpoint_label(&entry);
    crate::oplog::log("DEBUG", "list_vms", "started", &label, "proxmox", &serde_json::json!({"operationId": operation_id}).to_string());
    let result = list_vms_inner(&entry, password).await;
    match &result {
        Ok(vms) => crate::oplog::log("INFO", "list_vms", "completed", &label, "proxmox", &serde_json::json!({"operationId": operation_id, "vmCount": vms.len(), "durationMs": started.elapsed().as_millis()}).to_string()),
        Err(error) => crate::oplog::log("ERROR", "list_vms", "failed", &label, "proxmox", &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "failureType": "vm_list", "error": error}).to_string()),
    }
    result
}

async fn list_vms_inner(entry: &VncEntry, password: String) -> Result<Vec<VmSummary>, String> {
    let (http, ticket, _) = login(entry, &password).await?;
    let base = normalized_url(&entry.base_url)?;
    let label = endpoint_label(entry);
    let response = http
        .get(api_url(&base, "api2/json/cluster/resources?type=vm")?)
        .header("Cookie", format!("PVEAuthCookie={ticket}"))
        .send()
        .await
        .map_err(|error| {
            let message = format!("Unable to reach Proxmox VM list endpoint: {error}");
            crate::oplog::log(
                "ERROR",
                "proxmox_vnc",
                "vm_list_failed",
                &label,
                "proxmox",
                &message,
            );
            message
        })?;
    if !response.status().is_success() {
        let message = api_error("VM list", response).await;
        crate::oplog::log(
            "ERROR",
            "proxmox_vnc",
            "vm_list_failed",
            &label,
            "proxmox",
            &message,
        );
        return Err(message);
    }
    let data: ApiEnvelope<Vec<ClusterVm>> =
        decode_api("VM list", response).await.map_err(|error| {
            let message = format!("Invalid Proxmox VM list response: {error}");
            crate::oplog::log(
                "ERROR",
                "proxmox_vnc",
                "vm_list_failed",
                &label,
                "proxmox",
                &message,
            );
            message
        })?;
    crate::oplog::log(
        "INFO",
        "proxmox_vnc",
        "vm_list_succeeded",
        &label,
        "proxmox",
        &format!("Loaded {} VM entries.", data.data.len()),
    );
    Ok(data
        .data
        .into_iter()
        .map(|vm| VmSummary {
            vmid: vm.vmid,
            name: vm.name,
            node: vm.node,
            status: vm.status,
            guest_type: vm.guest_type,
        })
        .collect())
}

pub async fn authenticate(entry: VncEntry, password: String) -> Result<String, String> {
    let (client, ticket, csrf_token) = login(&entry, &password).await?;
    let session_id = uuid::Uuid::new_v4().to_string();
    auth_sessions().lock().await.insert(
        session_id.clone(),
        AuthSession {
            client,
            ticket,
            csrf_token,
        },
    );
    Ok(session_id)
}

async fn session(session_id: &str) -> Result<AuthSession, String> {
    auth_sessions()
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Proxmox session is not logged in or has expired".to_string())
}

pub async fn logout(session_id: String) -> Result<(), String> {
    let removed = auth_sessions().lock().await.remove(&session_id).is_some();
    crate::oplog::log(
        "INFO",
        "proxmox_session",
        "logout",
        "proxmox",
        "",
        &serde_json::json!({"sessionId": session_id, "removed": removed}).to_string(),
    );
    Ok(())
}

pub async fn list_vms_session(
    entry: VncEntry,
    session_id: String,
) -> Result<Vec<VmSummary>, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = endpoint_label(&entry);
    let auth = match session(&session_id).await {
        Ok(auth) => auth,
        Err(error) => {
            crate::oplog::log("ERROR", "list_vms_session", "failed", &label, "proxmox", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "missing_session", "error": error}).to_string());
            return Err(error);
        }
    };
    let base = normalized_url(&entry.base_url)?;
    let response = auth
        .client
        .get(api_url(&base, "api2/json/cluster/resources?type=vm")?)
        .header("Cookie", format!("PVEAuthCookie={}", auth.ticket))
        .send()
        .await
        .map_err(|error| {
            let message = format!("Unable to reach Proxmox VM list endpoint: {error}");
            crate::oplog::log("ERROR", "proxmox_vnc", "vm_list_failed", &label, "proxmox", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "network", "error": message}).to_string());
            message
        })?;
    if !response.status().is_success() {
        let message = api_error("VM list", response).await;
        crate::oplog::log(
            "ERROR",
            "proxmox_vnc",
            "vm_list_failed",
            &label,
            "proxmox",
            &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "http", "error": message}).to_string(),
        );
        return Err(message);
    }
    let data: ApiEnvelope<Vec<ClusterVm>> = decode_api("VM list", response).await.map_err(|error| {
        let message = error.to_string();
        crate::oplog::log("ERROR", "proxmox_vnc", "vm_list_failed", &label, "proxmox", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "parse", "error": message}).to_string());
        message
    })?;
    crate::oplog::log(
        "INFO",
        "proxmox_vnc",
        "vm_list_succeeded",
        &label,
        "proxmox",
        &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "vmCount": data.data.len()}).to_string(),
    );
    Ok(data
        .data
        .into_iter()
        .map(|vm| VmSummary {
            vmid: vm.vmid,
            name: vm.name,
            node: vm.node,
            status: vm.status,
            guest_type: vm.guest_type,
        })
        .collect())
}

pub async fn start(entry: VncEntry, password: String) -> Result<VncConnection, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = endpoint_label(&entry);
    crate::oplog::log("DEBUG", "proxmox_vnc_start", "started", &label, "vnc", &serde_json::json!({"operationId": operation_id, "guestType": entry.guest_type, "node": entry.node, "vmid": entry.vmid}).to_string());
    let result = start_inner(entry, password).await;
    match &result {
        Ok(connection) => crate::oplog::log("INFO", "proxmox_vnc_start", "completed", &label, "vnc", &serde_json::json!({"operationId": operation_id, "connectionId": connection.id, "durationMs": started.elapsed().as_millis()}).to_string()),
        Err(error) => crate::oplog::log("ERROR", "proxmox_vnc_start", "failed", &label, "vnc", &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "failureType": "vnc_start", "error": error}).to_string()),
    }
    result
}

async fn start_inner(entry: VncEntry, password: String) -> Result<VncConnection, String> {
    if entry.guest_type != "qemu" && entry.guest_type != "lxc" {
        return Err("Proxmox guest type must be qemu or lxc".to_string());
    }
    let vmid = entry
        .vmid
        .filter(|value| *value > 0)
        .ok_or_else(|| "Proxmox node and VMID are required".to_string())?;
    if entry.node.trim().is_empty() {
        return Err("Proxmox node and VMID are required".to_string());
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let (http, auth_ticket, csrf_token) = login(&entry, &password).await?;
    let base = normalized_url(&entry.base_url)?;
    let label = endpoint_label(&entry);
    let guest_path = format!("{}/{}/{}", entry.guest_type, vmid, "vncproxy");
    let response = http
        .post(api_url(
            &base,
            &format!("api2/json/nodes/{}/{guest_path}", entry.node),
        )?)
        .header("Cookie", format!("PVEAuthCookie={auth_ticket}"))
        .header("CSRFPreventionToken", csrf_token)
        .form(&[("websocket", "1"), ("generate-password", "1")])
        .send()
        .await
        .map_err(|error| {
            let message = format!("Unable to reach Proxmox VNC proxy endpoint: {error}");
            crate::oplog::log(
                "ERROR",
                "proxmox_vnc",
                "vnc_proxy_failed",
                &label,
                "proxmox",
                &message,
            );
            message
        })?;
    if !response.status().is_success() {
        let message = api_error("VNC proxy", response).await;
        crate::oplog::log(
            "ERROR",
            "proxmox_vnc",
            "vnc_proxy_failed",
            &label,
            "proxmox",
            &message,
        );
        return Err(message);
    }
    let data: ApiEnvelope<ProxyData> =
        decode_api("VNC proxy", response).await.map_err(|error| {
            let message = format!("Invalid Proxmox VNC proxy response: {error}");
            crate::oplog::log(
                "ERROR",
                "proxmox_vnc",
                "vnc_proxy_failed",
                &label,
                "proxmox",
                &message,
            );
            message
        })?;
    let password = data.data.password.ok_or_else(|| {
        let message = "Proxmox VNC proxy did not return a VNC password".to_string();
        crate::oplog::log(
            "ERROR",
            "proxmox_vnc",
            "vnc_proxy_failed",
            &label,
            "proxmox",
            &message,
        );
        message
    })?;
    let websocket_url = api_url(
        &base,
        &format!(
            "api2/json/nodes/{}/{}/{}/vncwebsocket?port={}&vncticket={}",
            entry.node,
            entry.guest_type,
            vmid,
            data.data.port,
            urlencoding::encode(&data.data.ticket),
        ),
    )
    .and_then(|mut url| {
        url.set_scheme("wss")
            .map_err(|_| "Proxmox WebSocket URL is invalid".to_string())?;
        Ok(url.to_string())
    })?;
    let id = uuid::Uuid::new_v4().to_string();
    let relay_token = uuid::Uuid::new_v4().to_string();
    let listener = TcpListener::bind("localhost:0")
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    pending().lock().await.insert(
        id.clone(),
        PendingConnection {
            operation_id: operation_id.clone(),
            cookie: auth_ticket,
            websocket_url,
            ignore_tls_errors: entry.ignore_tls_errors,
            relay_token: relay_token.clone(),
        },
    );
    let connection_id = id.clone();
    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let pending_connection = pending().lock().await.remove(&connection_id);
            if let Some(pending_connection) = pending_connection {
                let _ = relay(stream, connection_id, pending_connection).await;
            }
        }
    });
    crate::oplog::log(
        "INFO",
        "proxmox_vnc",
        "vnc_proxy_succeeded",
        &label,
        "vnc",
        &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "connectionId": id}).to_string(),
    );
    Ok(VncConnection {
        id: id.clone(),
        websocket_url: format!(
            "ws://localhost:{}/vnc/{}?token={relay_token}",
            address.port(),
            id
        ),
        password,
    })
}

pub async fn cancel(connection_id: String) -> Result<(), String> {
    let removed = pending().lock().await.remove(&connection_id).is_some();
    crate::oplog::log(
        "WARN",
        "proxmox_vnc",
        "cancelled",
        "vnc",
        "",
        &serde_json::json!({"connectionId": connection_id, "removed": removed}).to_string(),
    );
    Ok(())
}

pub async fn start_session(entry: VncEntry, session_id: String) -> Result<VncConnection, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = endpoint_label(&entry);
    crate::oplog::log("DEBUG", "proxmox_vnc_start_session", "started", &label, "vnc", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "guestType": entry.guest_type, "node": entry.node, "vmid": entry.vmid}).to_string());
    let result = start_session_inner(entry, session_id.clone()).await;
    match &result {
        Ok(connection) => crate::oplog::log("INFO", "proxmox_vnc_start_session", "completed", &label, "vnc", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "connectionId": connection.id, "durationMs": started.elapsed().as_millis()}).to_string()),
        Err(error) => crate::oplog::log("ERROR", "proxmox_vnc_start_session", "failed", &label, "vnc", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "vnc_start", "error": error}).to_string()),
    }
    result
}

async fn start_session_inner(entry: VncEntry, session_id: String) -> Result<VncConnection, String> {
    if entry.guest_type != "qemu" && entry.guest_type != "lxc" {
        return Err("Proxmox guest type must be qemu or lxc".to_string());
    }
    let vmid = entry
        .vmid
        .filter(|value| *value > 0)
        .ok_or_else(|| "Proxmox node and VMID are required".to_string())?;
    if entry.node.trim().is_empty() {
        return Err("Proxmox node and VMID are required".to_string());
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let auth = session(&session_id).await?;
    let ticket = auth.ticket.clone();
    let csrf_token = auth.csrf_token.clone();
    let base = normalized_url(&entry.base_url)?;
    let label = endpoint_label(&entry);
    let guest_path = format!("{}/{}/vncproxy", entry.guest_type, vmid);
    let response = auth
        .client
        .post(api_url(
            &base,
            &format!("api2/json/nodes/{}/{guest_path}", entry.node),
        )?)
        .header("Cookie", format!("PVEAuthCookie={ticket}"))
        .header("CSRFPreventionToken", csrf_token)
        .form(&[("websocket", "1"), ("generate-password", "1")])
        .send()
        .await
        .map_err(|error| format!("Unable to reach Proxmox VNC proxy endpoint: {error}"))?;
    if !response.status().is_success() {
        let message = api_error("VNC proxy", response).await;
        crate::oplog::log(
            "ERROR",
            "proxmox_vnc",
            "vnc_proxy_failed",
            &label,
            "proxmox",
            &message,
        );
        return Err(message);
    }
    let data: ApiEnvelope<ProxyData> = decode_api("VNC proxy", response).await?;
    let password = data
        .data
        .password
        .ok_or_else(|| "Proxmox VNC proxy did not return a VNC password".to_string())?;
    let mut websocket_url = api_url(
        &base,
        &format!(
            "api2/json/nodes/{}/{}/{}/vncwebsocket?port={}&vncticket={}",
            entry.node,
            entry.guest_type,
            vmid,
            data.data.port,
            urlencoding::encode(&data.data.ticket)
        ),
    )?;
    websocket_url
        .set_scheme("wss")
        .map_err(|_| "Proxmox WebSocket URL is invalid".to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let relay_token = uuid::Uuid::new_v4().to_string();
    let listener = TcpListener::bind("localhost:0")
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    pending().lock().await.insert(
        id.clone(),
        PendingConnection {
            operation_id: operation_id.clone(),
            cookie: ticket,
            websocket_url: websocket_url.to_string(),
            ignore_tls_errors: entry.ignore_tls_errors,
            relay_token: relay_token.clone(),
        },
    );
    let connection_id = id.clone();
    let task_connection_id = connection_id.clone();
    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            if let Some(pending_connection) = pending().lock().await.remove(&task_connection_id) {
                let _ = relay(stream, task_connection_id, pending_connection).await;
            }
        }
    });
    crate::oplog::log(
        "INFO",
        "proxmox_vnc",
        "vnc_proxy_succeeded",
        &label,
        "vnc",
        &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "connectionId": id}).to_string(),
    );
    Ok(VncConnection {
        id,
        websocket_url: format!(
            "ws://localhost:{}/vnc/{}?token={relay_token}",
            address.port(),
            connection_id
        ),
        password,
    })
}

#[allow(clippy::result_large_err)]
async fn relay(
    stream: tokio::net::TcpStream,
    connection_id: String,
    connection: PendingConnection,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    crate::oplog::log(
        "DEBUG",
        "proxmox_vnc",
        "relay_started",
        "vnc",
        "",
        &serde_json::json!({"operationId": connection.operation_id.clone(), "connectionId": connection_id}).to_string(),
    );
    let expected_path = format!("/vnc/{connection_id}");
    let expected_token = connection.relay_token.clone();
    let browser: WebSocketStream<tokio::net::TcpStream> =
        accept_hdr_async(stream, move |request: &Request, response: Response| {
            if valid_relay_request(request.uri(), &expected_path, &expected_token) {
                Ok(response)
            } else {
                let error: ErrorResponse = http::Response::builder()
                    .status(http::StatusCode::NOT_FOUND)
                    .body(Some("Not found".to_string()))
                    .expect("static WebSocket rejection response should build");
                Err(error)
            }
        })
        .await
        .map_err(|error| error.to_string())?;
    let request = http::Request::builder()
        .uri(&connection.websocket_url)
        .header(
            "Host",
            http::Uri::try_from(&connection.websocket_url)
                .ok()
                .and_then(|uri| uri.authority().map(|value| value.as_str().to_string()))
                .unwrap_or_default(),
        )
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Cookie", format!("PVEAuthCookie={}", connection.cookie))
        .header("Sec-WebSocket-Protocol", "binary")
        .body(())
        .map_err(|error| error.to_string())?;
    let connector = if connection.ignore_tls_errors {
        let config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate))
            .with_no_client_auth();
        Some(Connector::Rustls(Arc::new(config)))
    } else {
        None
    };
    let (pve, _) =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector)
            .await
            .map_err(|error| {
                let message = format!("Unable to connect to Proxmox VNC WebSocket: {error}");
                crate::oplog::log(
                    "ERROR",
                    "proxmox_vnc",
                    "websocket_failed",
                    "proxmox",
                    "vnc",
                    &serde_json::json!({"operationId": connection.operation_id.clone(), "connectionId": connection_id, "failureType": "websocket", "error": message}).to_string(),
                );
                message
            })?;
    crate::oplog::log(
        "INFO",
        "proxmox_vnc",
        "websocket_connected",
        "proxmox",
        "vnc",
        &serde_json::json!({"operationId": connection.operation_id.clone(), "connectionId": connection_id}).to_string(),
    );
    let (mut browser_write, mut browser_read) = browser.split();
    let (mut pve_write, mut pve_read) = pve.split();
    let relay_result = tokio::select! {
        result = async {
            while let Some(message) = browser_read.next().await {
                let message = message.map_err(|error| error.to_string())?;
                pve_write.send(message).await.map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        } => result,
        result = async {
            while let Some(message) = pve_read.next().await {
                let message = message.map_err(|error| error.to_string())?;
                browser_write.send(message).await.map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        } => result,
    };
    crate::oplog::log(
        if relay_result.is_ok() { "INFO" } else { "ERROR" },
        "proxmox_vnc",
        if relay_result.is_ok() { "relay_closed" } else { "relay_failed" },
        "vnc",
        "",
        &serde_json::json!({"operationId": connection.operation_id, "connectionId": connection_id, "durationMs": started.elapsed().as_millis(), "failureType": if relay_result.is_ok() { serde_json::Value::Null } else { serde_json::Value::String("relay".to_string()) }, "error": relay_result.as_ref().err()}).to_string(),
    );
    relay_result
}

fn valid_relay_request(uri: &http::Uri, expected_path: &str, expected_token: &str) -> bool {
    uri.path() == expected_path
        && uri
            .query()
            .unwrap_or_default()
            .split('&')
            .filter_map(|part| part.split_once('='))
            .any(|(name, value)| name == "token" && value == expected_token)
}

// ---------------------------------------------------------------------------
// QEMU Guest Agent file transfer (VNC-P02)
//
// This talks to Proxmox's `qemu/{vmid}/agent/*` REST endpoints, which relay
// commands to the QEMU Guest Agent daemon running inside the VM over the
// virtio-serial channel (no VM network reachability required). Only QEMU
// guests expose this API -- LXC containers have no equivalent. It is used
// as the last-resort file transfer path when neither a direct nor a
// jump-host SFTP route to the VM is reachable from this client (see
// `netcheck::is_port_reachable` and the frontend's `detectTransferMode`).
//
// Two hard limits are inherent to the underlying Proxmox API (confirmed
// against the `qemu-server` PVE::API2::Qemu::Agent source):
//   - `file-read` is capped at 16 MiB per call, but supports `offset`/`count`
//     so a large file can be read in a client-driven loop.
//   - `file-write` always reopens the target with `mode: "wb"` (truncate),
//     so *the API itself cannot append*. To upload a file larger than one
//     ~60KB request, each chunk is written to its own small staging file
//     inside the guest and then concatenated together inside the guest
//     (Linux/Unix: `cat` via `agent_exec`; Windows: a PowerShell script --
//     see `agent_detect_os` below) -- see `agent_upload_file` below.
// ---------------------------------------------------------------------------

/// Maximum bytes read from the guest per `file-read` call. Kept well under
/// the server's 16 MiB cap so download progress updates smoothly.
const AGENT_READ_CHUNK_BYTES: u64 = 1024 * 1024;

/// Maximum *raw* (pre-base64) bytes written per `file-write` call. Proxmox
/// caps the `content` field at 60 KiB; base64 inflates by 4/3, so 44 KiB raw
/// stays safely under that cap (44 * 1024 * 4 / 3 ~= 58.7 KiB).
const AGENT_WRITE_CHUNK_BYTES: usize = 44 * 1024;

/// Default guest-agent upload size threshold: uploads larger than this are
/// rejected up front with a message steering the user toward a reachable
/// SFTP/jump-host route instead, because chunked guest-agent uploads need
/// one HTTP round-trip per ~44 KiB and become impractically slow well
/// before this size.
pub const AGENT_UPLOAD_DEFAULT_LIMIT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GuestIpAddress {
    pub address: String,
    pub ip_type: String,
    pub prefix: u8,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GuestNetInterface {
    pub name: String,
    pub mac_address: Option<String>,
    pub ip_addresses: Vec<GuestIpAddress>,
}

#[derive(Deserialize)]
struct RawGuestIpAddress {
    #[serde(rename = "ip-address")]
    ip_address: String,
    #[serde(rename = "ip-address-type", default)]
    ip_address_type: Option<String>,
    #[serde(default)]
    prefix: Option<u8>,
}

#[derive(Deserialize)]
struct RawGuestNetInterface {
    name: String,
    #[serde(rename = "hardware-address", default)]
    hardware_address: Option<String>,
    #[serde(rename = "ip-addresses", default)]
    ip_addresses: Option<Vec<RawGuestIpAddress>>,
}

#[derive(Deserialize)]
struct NetworkInterfacesResult {
    result: Vec<RawGuestNetInterface>,
}

#[derive(Deserialize)]
struct AgentPidResponse {
    pid: i64,
}

/// Proxmox's Perl API proxies the QEMU Guest Agent's raw JSON response
/// as-is. When a boolean value is still an unblessed Perl scalar `0`/`1`
/// (which happens for `false` far more often than for `true`) it gets
/// re-serialized as a bare JSON integer instead of `true`/`false`. Accept
/// either shape here so a guest command that is merely still running
/// (`"exited":0`) doesn't get misreported as a deserialization failure.
fn deserialize_lenient_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum BoolLike {
        Bool(bool),
        Int(i64),
    }

    match BoolLike::deserialize(deserializer)? {
        BoolLike::Bool(value) => Ok(value),
        BoolLike::Int(value) => Ok(value != 0),
    }
}

#[derive(Deserialize)]
struct AgentExecStatusRaw {
    #[serde(default, deserialize_with = "deserialize_lenient_bool")]
    exited: bool,
    #[serde(default)]
    exitcode: Option<i64>,
    #[serde(default)]
    signal: Option<i64>,
    #[serde(rename = "out-data", default)]
    out_data: Option<String>,
    #[serde(rename = "err-data", default)]
    err_data: Option<String>,
}

#[derive(Deserialize)]
struct AgentFileReadResponse {
    content: String,
    #[serde(default, deserialize_with = "deserialize_lenient_bool")]
    truncated: bool,
}

struct AgentExecResult {
    exit_code: Option<i64>,
    #[allow(dead_code)]
    signal: Option<i64>,
    stdout: String,
    stderr: String,
}

/// Resolve `(vmid, "qemu/{vmid}/agent")`, rejecting non-qemu guests: the
/// Guest Agent REST API only exists under `nodes/{node}/qemu/{vmid}/agent/*`
/// (LXC has no equivalent endpoint).
fn agent_base(entry: &VncEntry) -> Result<(u64, String), String> {
    if entry.guest_type != "qemu" {
        return Err(
            "QEMU Guest Agent file transfer is only available for qemu guests".to_string(),
        );
    }
    let vmid = entry
        .vmid
        .filter(|value| *value > 0)
        .ok_or_else(|| "Proxmox node and VMID are required".to_string())?;
    if entry.node.trim().is_empty() {
        return Err("Proxmox node and VMID are required".to_string());
    }
    Ok((vmid, format!("qemu/{vmid}/agent")))
}

async fn agent_request<T: DeserializeOwned>(
    entry: &VncEntry,
    session_id: &str,
    method: reqwest::Method,
    agent_command: &str,
    query: Option<&str>,
    json_payload: Option<serde_json::Value>,
) -> Result<T, String> {
    let (_, agent_path) = agent_base(entry)?;
    let auth = session(session_id).await?;
    let base = normalized_url(&entry.base_url)?;
    let mut path = format!(
        "api2/json/nodes/{}/{agent_path}/{agent_command}",
        entry.node
    );
    if let Some(query) = query {
        path.push('?');
        path.push_str(query);
    }
    let mut request = match method {
        reqwest::Method::GET => auth.client.get(api_url(&base, &path)?),
        reqwest::Method::POST => auth.client.post(api_url(&base, &path)?),
        other => return Err(format!("Unsupported guest agent HTTP method: {other}")),
    };
    request = request
        .header("Cookie", format!("PVEAuthCookie={}", auth.ticket))
        .header("CSRFPreventionToken", auth.csrf_token.clone());
    if let Some(json_payload) = json_payload {
        request = request.json(&json_payload);
    }
    let response = request.send().await.map_err(|error| {
        format!("Unable to reach the Proxmox Guest Agent endpoint \"{agent_command}\": {error}")
    })?;
    if !response.status().is_success() {
        return Err(api_error(&format!("guest agent {agent_command}"), response).await);
    }
    let data: ApiEnvelope<T> =
        decode_api(&format!("guest agent {agent_command}"), response).await?;
    Ok(data.data)
}

/// Confirm the QEMU Guest Agent inside the VM is running and responding.
pub async fn agent_ping(entry: VncEntry, session_id: String) -> Result<(), String> {
    let label = endpoint_label(&entry);
    let result = agent_request::<serde_json::Value>(
        &entry,
        &session_id,
        reqwest::Method::POST,
        "ping",
        None,
        None,
    )
    .await;
    match &result {
        Ok(_) => crate::oplog::log(
            "DEBUG",
            "proxmox_agent",
            "ping_succeeded",
            &label,
            "agent",
            "",
        ),
        Err(error) => {
            crate::oplog::log("WARN", "proxmox_agent", "ping_failed", &label, "agent", error)
        }
    }
    result.map(|_| ())
}

/// List the VM's network interfaces via the Guest Agent, returning only
/// usable candidate IPv4 addresses (excludes loopback and link-local
/// ranges, which are never useful as a direct/jump SFTP connection target).
pub async fn agent_network_interfaces(
    entry: VncEntry,
    session_id: String,
) -> Result<Vec<String>, String> {
    let raw: NetworkInterfacesResult = agent_request(
        &entry,
        &session_id,
        reqwest::Method::GET,
        "network-get-interfaces",
        None,
        None,
    )
    .await?;
    let interfaces: Vec<GuestNetInterface> = raw
        .result
        .into_iter()
        .map(|interface| GuestNetInterface {
            name: interface.name,
            mac_address: interface.hardware_address,
            ip_addresses: interface
                .ip_addresses
                .unwrap_or_default()
                .into_iter()
                .map(|address| GuestIpAddress {
                    address: address.ip_address,
                    ip_type: address
                        .ip_address_type
                        .unwrap_or_else(|| "unknown".to_string()),
                    prefix: address.prefix.unwrap_or(0),
                })
                .collect(),
        })
        .collect();
    Ok(usable_guest_ipv4_addresses(&interfaces))
}

/// Candidate usable IPv4 addresses for direct/jump SFTP reachability
/// probing: excludes loopback (127.0.0.0/8) and link-local (169.254.0.0/16)
/// ranges, which are never useful as a connection target from the client.
fn usable_guest_ipv4_addresses(interfaces: &[GuestNetInterface]) -> Vec<String> {
    interfaces
        .iter()
        .flat_map(|interface| interface.ip_addresses.iter())
        .filter(|address| address.ip_type.eq_ignore_ascii_case("ipv4"))
        .map(|address| address.address.clone())
        .filter(|address| !address.starts_with("127.") && !address.starts_with("169.254."))
        .collect()
}

// ---------------------------------------------------------------------------
// Guest OS detection (VNC-P03)
//
// The Guest Agent fallback below has to run different guest-side commands
// for Windows guests (PowerShell, no POSIX shell/`find`/`cat`) than for
// Linux/Unix guests (`find`, `sh -c`, `cat`, `rm -rf`). `guest-get-osinfo` is
// answered by the QEMU Guest Agent itself on every supported guest OS (it's
// not an `exec`-based probe), and the Windows build of qemu-ga always
// reports `id: "mswindows"` for that field -- this is the same field/value
// Proxmox's own web UI and `qm guest cmd <vmid> get-osinfo` rely on, so it's
// a stable signal rather than a heuristic guess.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum GuestOsKind {
    Windows,
    Other,
}

#[derive(Deserialize, Default)]
struct RawGuestOsInfo {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
struct GuestOsInfoResult {
    #[serde(default)]
    result: RawGuestOsInfo,
}

static GUEST_OS_CACHE: OnceLock<Arc<Mutex<HashMap<String, GuestOsKind>>>> = OnceLock::new();

fn guest_os_cache() -> &'static Arc<Mutex<HashMap<String, GuestOsKind>>> {
    GUEST_OS_CACHE.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Detect whether the guest is Windows, caching the result per Proxmox
/// session + node + vmid so every list/upload/download call after the first
/// one skips the extra `get-osinfo` round-trip. A detection failure (older
/// qemu-ga without `get-osinfo`, or a transient error) falls back to
/// treating the guest as non-Windows -- the existing Linux/Unix commands
/// will then simply fail with a clear guest-side error instead of silently
/// picking the wrong OS branch.
async fn agent_detect_os(entry: &VncEntry, session_id: &str) -> GuestOsKind {
    let (vmid, _) = match agent_base(entry) {
        Ok(value) => value,
        Err(_) => return GuestOsKind::Other,
    };
    let cache_key = format!("{session_id}:{}:{vmid}", entry.node);
    if let Some(kind) = guest_os_cache().lock().await.get(&cache_key) {
        return *kind;
    }
    let detected: Result<GuestOsInfoResult, String> = agent_request(
        entry,
        session_id,
        reqwest::Method::GET,
        "get-osinfo",
        None,
        None,
    )
    .await;
    let kind = match detected {
        Ok(info) if info.result.id.as_deref() == Some("mswindows") => GuestOsKind::Windows,
        _ => GuestOsKind::Other,
    };
    guest_os_cache().lock().await.insert(cache_key, kind);
    kind
}

/// Convert an app-internal, always-`/`-delimited guest path (the only form
/// ever shown in the frontend's file browser -- see `proxmox-vnc.tsx`) into
/// the native Windows form PowerShell/Win32 expect. A bare drive letter like
/// `C:` (as returned by the synthetic drive-list "root" -- see
/// `agent_list_directory`) means "root of that drive" and must become
/// `C:\`, not `C:` alone, which Windows would otherwise resolve as "the
/// current directory on drive C" instead of its root.
fn windows_native_path(path: &str) -> String {
    let mut native = path.replace('/', "\\");
    if native.len() == 2 && native.as_bytes()[1] == b':' {
        native.push('\\');
    }
    native
}

/// True if `path` is rooted at an actual Windows drive (e.g. `C:` or
/// `C:/Users`), as opposed to the synthetic multi-drive listing root `/`
/// this module presents as "This PC" for Windows guests. There is no real
/// guest-side folder behind `/` on Windows, so any operation that would
/// need to write into it (uploads) must be rejected before it reaches the
/// guest.
fn is_windows_drive_rooted(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Escape a value for safe embedding inside a PowerShell single-quoted
/// string literal -- the only character that needs escaping in that context
/// is `'` itself, escaped by doubling it.
fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Encode a PowerShell script for `-EncodedCommand` (UTF-16LE bytes,
/// base64). This is the standard technique for scripted PowerShell
/// invocation because it sidesteps every command-line quoting/escaping
/// pitfall of building a single `-Command "..."` string by hand -- the
/// guest never has to re-parse a quoted argument at all.
fn powershell_encoded_command(script: &str) -> String {
    let utf16_bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    BASE64.encode(utf16_bytes)
}

/// Build the `agent_exec` command vector to run a PowerShell script via
/// `-EncodedCommand`.
fn powershell_command(script: &str) -> Vec<String> {
    vec![
        "powershell.exe".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-EncodedCommand".to_string(),
        powershell_encoded_command(script),
    ]
}

/// Start a command inside the guest, returning its pid.
async fn agent_exec(
    entry: &VncEntry,
    session_id: &str,
    command: Vec<String>,
) -> Result<i64, String> {
    let response: AgentPidResponse = agent_request(
        entry,
        session_id,
        reqwest::Method::POST,
        "exec",
        None,
        Some(serde_json::json!({ "command": command })),
    )
    .await?;
    Ok(response.pid)
}

/// Poll `exec-status` until the command started by `agent_exec` finishes (or
/// `timeout_secs` elapses), decoding the base64 stdout/stderr the Guest
/// Agent returns.
async fn agent_exec_wait(
    entry: &VncEntry,
    session_id: &str,
    pid: i64,
    timeout_secs: u64,
) -> Result<AgentExecResult, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs.max(1));
    loop {
        let raw: AgentExecStatusRaw = agent_request(
            entry,
            session_id,
            reqwest::Method::GET,
            "exec-status",
            Some(&format!("pid={pid}")),
            None,
        )
        .await?;
        if raw.exited {
            let decode = |value: Option<String>| -> String {
                value
                    .and_then(|text| BASE64.decode(text).ok())
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default()
            };
            return Ok(AgentExecResult {
                exit_code: raw.exitcode,
                signal: raw.signal,
                stdout: decode(raw.out_data),
                stderr: decode(raw.err_data),
            });
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "Guest command (pid {pid}) did not finish within {timeout_secs} seconds"
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Run a command inside the guest to completion and return its result.
async fn agent_run_command(
    entry: &VncEntry,
    session_id: &str,
    command: Vec<String>,
    timeout_secs: u64,
) -> Result<AgentExecResult, String> {
    let pid = agent_exec(entry, session_id, command).await?;
    agent_exec_wait(entry, session_id, pid, timeout_secs).await
}

/// Best-effort cleanup of the per-transfer staging directory used by
/// `agent_upload_file`. Failures are swallowed (logged elsewhere already, or
/// simply not worth surfacing) since this only runs on an already-failing or
/// already-completed path.
async fn agent_cleanup_staging(
    entry: &VncEntry,
    session_id: &str,
    staging_dir: &str,
    os_kind: GuestOsKind,
) {
    let command = match os_kind {
        GuestOsKind::Windows => powershell_command(&format!(
            "Remove-Item -LiteralPath {} -Recurse -Force -ErrorAction SilentlyContinue",
            powershell_single_quote(staging_dir),
        )),
        GuestOsKind::Other => vec!["rm".to_string(), "-rf".to_string(), staging_dir.to_string()],
    };
    let _ = agent_run_command(entry, session_id, command, 10).await;
}

/// Single-quote a value for safe use as one argument in a POSIX shell
/// command line (handles embedded `'` by closing/reopening the quote).
fn agent_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// List a directory inside the guest. There is no native Guest Agent "list
/// directory" API, so this drives the guest's own shell:
///   - Linux/Unix guests: `find <path> -mindepth 1 -maxdepth 1 -printf ...`.
///   - Windows guests: PowerShell `Get-ChildItem` (see
///     `agent_list_directory_windows`), with the synthetic path `/` listing
///     the guest's drives instead (see `agent_list_drives_windows`) since
///     Windows has no single filesystem root.
pub async fn agent_list_directory(
    entry: VncEntry,
    session_id: String,
    path: String,
) -> Result<crate::LocalDirectory, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = endpoint_label(&entry);
    let normalized_path = if path.trim().is_empty() {
        "/".to_string()
    } else {
        path
    };
    crate::oplog::log(
        "DEBUG",
        "proxmox_agent_list",
        "started",
        &label,
        &normalized_path,
        &serde_json::json!({"operationId": operation_id}).to_string(),
    );
    let os_kind = agent_detect_os(&entry, &session_id).await;
    let result = match (os_kind, normalized_path.as_str()) {
        (GuestOsKind::Windows, "/") => agent_list_drives_windows(&entry, &session_id).await,
        (GuestOsKind::Windows, _) => {
            agent_list_directory_windows(&entry, &session_id, &normalized_path).await
        }
        (GuestOsKind::Other, _) => {
            agent_list_directory_unix(&entry, &session_id, &normalized_path).await
        }
    };
    let files = match result {
        Ok(files) => files,
        Err(error) => {
            crate::oplog::log(
                "ERROR",
                "proxmox_agent_list",
                "failed",
                &label,
                &normalized_path,
                &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "error": error}).to_string(),
            );
            return Err(error);
        }
    };
    crate::oplog::log(
        "INFO",
        "proxmox_agent_list",
        "completed",
        &label,
        &normalized_path,
        &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "fileCount": files.len()}).to_string(),
    );
    Ok(crate::LocalDirectory {
        path: normalized_path,
        files,
    })
}

/// Linux/Unix directory listing via `find <path> -mindepth 1 -maxdepth 1
/// -printf '%y\t%s\t%T@\t%f\n'`.
async fn agent_list_directory_unix(
    entry: &VncEntry,
    session_id: &str,
    path: &str,
) -> Result<Vec<crate::LocalFile>, String> {
    let command = vec![
        "find".to_string(),
        path.to_string(),
        "-mindepth".to_string(),
        "1".to_string(),
        "-maxdepth".to_string(),
        "1".to_string(),
        "-printf".to_string(),
        "%y\t%s\t%T@\t%f\n".to_string(),
    ];
    let result = agent_run_command(entry, session_id, command, 20).await?;
    if result.exit_code != Some(0) {
        return Err(format!(
            "Unable to list \"{path}\": {}",
            if result.stderr.trim().is_empty() {
                "the guest command failed"
            } else {
                result.stderr.trim()
            }
        ));
    }
    Ok(parse_unix_find_output(&result.stdout, path))
}

/// Parse the `find -printf '%y\t%s\t%T@\t%f\n'` output produced by
/// `agent_list_directory_unix` into sorted `LocalFile` entries. Pulled out
/// as a pure function so the line format can be unit-tested without a live
/// guest connection.
fn parse_unix_find_output(stdout: &str, path: &str) -> Vec<crate::LocalFile> {
    let mut files = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(4, '\t');
        let (Some(kind), Some(size_text), Some(mtime_text), Some(name)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let is_directory = kind == "d";
        let size: u64 = size_text.parse().unwrap_or(0);
        let modified: u128 = mtime_text
            .parse::<f64>()
            .map(|seconds| (seconds * 1000.0).max(0.0) as u128)
            .unwrap_or(0);
        let child_path = format!("{}/{}", path.trim_end_matches('/'), name);
        files.push(crate::LocalFile {
            name: name.to_string(),
            path: child_path,
            is_directory,
            size,
            modified,
        });
    }
    files.sort_by(|left: &crate::LocalFile, right: &crate::LocalFile| {
        left.name.to_lowercase().cmp(&right.name.to_lowercase())
    });
    files
}

/// Synthetic "root" listing for a Windows guest: since Windows has no
/// single filesystem root the way Linux/Unix does, the app-internal path
/// `/` is presented as a "This PC" style listing of the guest's filesystem
/// drives (`Get-PSDrive -PSProvider FileSystem`), each exposed as a
/// navigable "folder" named after its bare drive letter (e.g. `C:`) --
/// which `windows_native_path` then expands back to `C:\` when the guest
/// actually needs to touch that path.
async fn agent_list_drives_windows(
    entry: &VncEntry,
    session_id: &str,
) -> Result<Vec<crate::LocalFile>, String> {
    let script = "Get-PSDrive -PSProvider FileSystem | ForEach-Object { \"$($_.Name):\" }";
    let result = agent_run_command(entry, session_id, powershell_command(script), 20).await?;
    if result.exit_code != Some(0) {
        return Err(format!(
            "Unable to list drives: {}",
            if result.stderr.trim().is_empty() {
                "the guest command failed"
            } else {
                result.stderr.trim()
            }
        ));
    }
    Ok(parse_windows_drive_output(&result.stdout))
}

/// Parse the one-drive-letter-per-line output of `agent_list_drives_windows`
/// into sorted `LocalFile` entries. Pure function, unit-tested separately.
fn parse_windows_drive_output(stdout: &str) -> Vec<crate::LocalFile> {
    let mut files: Vec<crate::LocalFile> = stdout
        .lines()
        .map(|line| line.trim_end_matches('\r').trim())
        .filter(|line| !line.is_empty())
        .map(|drive| crate::LocalFile {
            name: drive.to_string(),
            path: drive.to_string(),
            is_directory: true,
            size: 0,
            modified: 0,
        })
        .collect();
    files.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    files
}

/// Windows directory listing (any path other than the synthetic `/` root)
/// via PowerShell `Get-ChildItem`, run through `-EncodedCommand` so the
/// path never has to survive a hand-built quoted command line.
async fn agent_list_directory_windows(
    entry: &VncEntry,
    session_id: &str,
    path: &str,
) -> Result<Vec<crate::LocalFile>, String> {
    let native_path = windows_native_path(path);
    let script = format!(
        "Get-ChildItem -LiteralPath {path} -Force -ErrorAction Stop | ForEach-Object {{ \
$kind = if ($_.PSIsContainer) {{ 'd' }} else {{ 'f' }}; \
$size = if ($_.PSIsContainer) {{ 0 }} else {{ $_.Length }}; \
$modified = [long]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds(); \
\"$kind`t$size`t$modified`t$($_.Name)\" }}",
        path = powershell_single_quote(&native_path),
    );
    let result = agent_run_command(entry, session_id, powershell_command(&script), 30).await?;
    if result.exit_code != Some(0) {
        return Err(format!(
            "Unable to list \"{path}\": {}",
            if result.stderr.trim().is_empty() {
                "the guest command failed"
            } else {
                result.stderr.trim()
            }
        ));
    }
    Ok(parse_windows_listing_output(&result.stdout, path))
}

/// Parse the `$kind`t`$size`t`$modified`t`$name` output produced by the
/// `Get-ChildItem`-based PowerShell script in `agent_list_directory_windows`
/// into sorted `LocalFile` entries. Pure function, unit-tested separately.
fn parse_windows_listing_output(stdout: &str, path: &str) -> Vec<crate::LocalFile> {
    let mut files = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        let mut parts = line.splitn(4, '\t');
        let (Some(kind), Some(size_text), Some(modified_text), Some(name)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let is_directory = kind == "d";
        let size: u64 = size_text.parse().unwrap_or(0);
        let modified: u128 = modified_text.parse().unwrap_or(0);
        let child_path = format!("{}/{}", path.trim_end_matches('/'), name);
        files.push(crate::LocalFile {
            name: name.to_string(),
            path: child_path,
            is_directory,
            size,
            modified,
        });
    }
    files.sort_by(|left: &crate::LocalFile, right: &crate::LocalFile| {
        left.name.to_lowercase().cmp(&right.name.to_lowercase())
    });
    files
}

/// Download a file from the guest via chunked `file-read` calls (the server
/// caps each call at 16 MiB; this client loops with a smaller chunk size so
/// download progress updates smoothly). EOF is detected the same way the
/// Proxmox API itself signals it: once `truncated` is absent/false in a
/// response, the actual end of the file has been reached even if the
/// requested `count` was not fully satisfied.
pub async fn agent_download_file(
    app: tauri::AppHandle,
    entry: VncEntry,
    session_id: String,
    transfer_id: String,
    remote_path: String,
    destination_folder: String,
) -> Result<String, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = endpoint_label(&entry);
    crate::reset_transfer_cancellation(&transfer_id);
    if crate::is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    let file_name = remote_path
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid remote path".to_string())?
        .to_string();
    let destination_root = crate::resolve_local_download_destination(&destination_folder)?;
    let requested_destination = destination_root.join(&file_name);
    let (destination, temporary, mut file) =
        crate::create_unique_download_file(&requested_destination)?;
    let mut offset: u64 = 0;
    let mut last_emit = std::time::Instant::now() - Duration::from_secs(1);
    loop {
        if crate::is_transfer_cancelled(&transfer_id) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err("Transfer cancelled".to_string());
        }
        let query = format!(
            "file={}&offset={offset}&count={AGENT_READ_CHUNK_BYTES}&decode=0",
            urlencoding::encode(&remote_path)
        );
        let response: AgentFileReadResponse = match agent_request(
            &entry,
            &session_id,
            reqwest::Method::GET,
            "file-read",
            Some(&query),
            None,
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                drop(file);
                let _ = std::fs::remove_file(&temporary);
                crate::oplog::log(
                    "ERROR",
                    "proxmox_agent_download",
                    "failed",
                    &label,
                    &remote_path,
                    &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "error": error}).to_string(),
                );
                return Err(error);
            }
        };
        let chunk = match BASE64.decode(response.content.as_bytes()) {
            Ok(chunk) => chunk,
            Err(error) => {
                drop(file);
                let _ = std::fs::remove_file(&temporary);
                return Err(format!("Invalid guest agent file-read response: {error}"));
            }
        };
        let chunk_len = chunk.len() as u64;
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        offset += chunk_len;
        if last_emit.elapsed().as_millis() >= 200 {
            let _ = app.emit(
                "proxmox-agent-download-progress",
                crate::DownloadProgressEvent {
                    transfer_id: transfer_id.clone(),
                    bytes_completed: offset,
                    bytes_total: None,
                },
            );
            last_emit = std::time::Instant::now();
        }
        if !response.truncated || chunk_len == 0 {
            break;
        }
    }
    drop(file);
    std::fs::rename(&temporary, &destination).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })?;
    let _ = app.emit(
        "proxmox-agent-download-progress",
        crate::DownloadProgressEvent {
            transfer_id,
            bytes_completed: offset,
            bytes_total: Some(offset),
        },
    );
    crate::oplog::log(
        "INFO",
        "proxmox_agent_download",
        "completed",
        &label,
        &remote_path,
        &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "bytes": offset}).to_string(),
    );
    Ok(destination.display().to_string())
}

/// Upload a local file into the guest. Because the Proxmox `file-write` API
/// always truncates on open (there is no append mode), each ~44 KiB chunk is
/// written to its own small staging file under a per-transfer temp
/// directory inside the guest, then concatenated together inside the guest
/// (Linux/Unix: `cat` via a single `agent_exec` call; Windows: a PowerShell
/// script reading each chunk and writing it into the destination file
/// stream) and the staging directory is removed -- all inside the guest, so
/// nothing partial is ever re-downloaded.
pub async fn agent_upload_file(
    app: tauri::AppHandle,
    entry: VncEntry,
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    size_limit_bytes: u64,
) -> Result<(), String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = endpoint_label(&entry);
    crate::reset_transfer_cancellation(&transfer_id);
    if crate::is_transfer_cancelled(&transfer_id) {
        return Err("Transfer cancelled".to_string());
    }
    let local = std::path::Path::new(&local_path);
    let metadata = std::fs::metadata(local).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Local source file does not exist".to_string());
    }
    let total_size = metadata.len();
    let limit = if size_limit_bytes == 0 {
        AGENT_UPLOAD_DEFAULT_LIMIT_BYTES
    } else {
        size_limit_bytes
    };
    if total_size > limit {
        return Err(format!(
            "This file is {} MB, which is above the {} MB Guest Agent upload limit. The Proxmox file-write API has no append mode, so large uploads need one HTTP round-trip per ~44 KB chunk and become impractically slow. Use a reachable direct or jump-host SFTP connection instead.",
            total_size / (1024 * 1024),
            limit / (1024 * 1024),
        ));
    }
    let os_kind = agent_detect_os(&entry, &session_id).await;
    if os_kind == GuestOsKind::Windows && !is_windows_drive_rooted(&remote_path) {
        return Err(
            "Select a drive (e.g. C:) before uploading files -- \"/\" is a synthetic listing of this Windows guest's drives, not a real folder.".to_string(),
        );
    }
    let sanitized_transfer_id: String = transfer_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect();
    let staging_dir = match os_kind {
        GuestOsKind::Windows => {
            format!("C:\\Windows\\Temp\\.fileapi-agent-upload-{sanitized_transfer_id}")
        }
        GuestOsKind::Other => format!("/tmp/.fileapi-agent-upload-{sanitized_transfer_id}"),
    };
    let mkdir_command = match os_kind {
        GuestOsKind::Windows => powershell_command(&format!(
            "New-Item -ItemType Directory -Force -Path {} | Out-Null",
            powershell_single_quote(&staging_dir),
        )),
        GuestOsKind::Other => vec!["mkdir".to_string(), "-p".to_string(), staging_dir.clone()],
    };
    let mkdir_result = agent_run_command(&entry, &session_id, mkdir_command, 10).await?;
    if mkdir_result.exit_code != Some(0) {
        return Err(format!(
            "Unable to create a staging directory inside the guest: {}",
            mkdir_result.stderr.trim()
        ));
    }
    let chunk_separator = if os_kind == GuestOsKind::Windows { '\\' } else { '/' };
    let mut file = std::fs::File::open(local).map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; AGENT_WRITE_CHUNK_BYTES];
    let mut sent: u64 = 0;
    let mut chunk_index: u32 = 0;
    let mut last_emit = std::time::Instant::now() - Duration::from_secs(1);
    loop {
        if crate::is_transfer_cancelled(&transfer_id) {
            agent_cleanup_staging(&entry, &session_id, &staging_dir, os_kind).await;
            return Err("Transfer cancelled".to_string());
        }
        let read = match file.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => {
                agent_cleanup_staging(&entry, &session_id, &staging_dir, os_kind).await;
                return Err(error.to_string());
            }
        };
        if read == 0 {
            break;
        }
        let chunk_path = format!("{staging_dir}{chunk_separator}chunk-{chunk_index:08}");
        let encoded = BASE64.encode(&buffer[..read]);
        let write_result: Result<serde_json::Value, String> = agent_request(
            &entry,
            &session_id,
            reqwest::Method::POST,
            "file-write",
            None,
            Some(serde_json::json!({
                "file": chunk_path,
                "content": encoded,
                "encode": false,
            })),
        )
        .await;
        if let Err(error) = write_result {
            agent_cleanup_staging(&entry, &session_id, &staging_dir, os_kind).await;
            crate::oplog::log(
                "ERROR",
                "proxmox_agent_upload",
                "failed",
                &label,
                &remote_path,
                &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "error": error}).to_string(),
            );
            return Err(error);
        }
        sent += read as u64;
        chunk_index += 1;
        if last_emit.elapsed().as_millis() >= 200 {
            let _ = app.emit(
                "proxmox-agent-upload-progress",
                crate::UploadProgressEvent {
                    transfer_id: transfer_id.clone(),
                    bytes_completed: sent,
                    bytes_total: total_size,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    if crate::is_transfer_cancelled(&transfer_id) {
        agent_cleanup_staging(&entry, &session_id, &staging_dir, os_kind).await;
        return Err("Transfer cancelled".to_string());
    }
    let merge_command = match os_kind {
        GuestOsKind::Windows => {
            let native_remote = windows_native_path(&remote_path);
            powershell_command(&format!(
                "$out = [System.IO.File]::Open({remote}, [System.IO.FileMode]::Create); \
try {{ Get-ChildItem -LiteralPath {staging} -Filter 'chunk-*' | Sort-Object Name | ForEach-Object {{ \
$bytes = [System.IO.File]::ReadAllBytes($_.FullName); $out.Write($bytes, 0, $bytes.Length) }} }} \
finally {{ $out.Close() }}; \
Remove-Item -LiteralPath {staging} -Recurse -Force",
                remote = powershell_single_quote(&native_remote),
                staging = powershell_single_quote(&staging_dir),
            ))
        }
        GuestOsKind::Other => vec![
            "sh".to_string(),
            "-c".to_string(),
            format!(
                "cat {staging_dir}/chunk-* > {remote} && rm -rf {staging_dir}",
                staging_dir = agent_shell_quote(&staging_dir),
                remote = agent_shell_quote(&remote_path),
            ),
        ],
    };
    let merge_result = match agent_run_command(&entry, &session_id, merge_command, 60).await {
        Ok(result) => result,
        Err(error) => {
            agent_cleanup_staging(&entry, &session_id, &staging_dir, os_kind).await;
            return Err(error);
        }
    };
    if merge_result.exit_code != Some(0) {
        agent_cleanup_staging(&entry, &session_id, &staging_dir, os_kind).await;
        let message = format!(
            "Unable to assemble the uploaded file inside the guest: {}",
            merge_result.stderr.trim()
        );
        crate::oplog::log(
            "ERROR",
            "proxmox_agent_upload",
            "failed",
            &label,
            &remote_path,
            &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "error": message}).to_string(),
        );
        return Err(message);
    }
    let _ = app.emit(
        "proxmox-agent-upload-progress",
        crate::UploadProgressEvent {
            transfer_id,
            bytes_completed: total_size,
            bytes_total: total_size,
        },
    );
    crate::oplog::log(
        "INFO",
        "proxmox_agent_upload",
        "completed",
        &label,
        &remote_path,
        &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "bytes": total_size}).to_string(),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        api_url, normalized_url, valid_relay_request, AgentExecStatusRaw, AgentFileReadResponse,
        BASE64,
    };
    use base64::Engine as _;

    #[test]
    fn api_url_never_adds_a_second_slash() {
        for base in ["https://pve.example:8006", "https://pve.example:8006/"] {
            let base = normalized_url(base).expect("base URL should be valid");
            let url = api_url(&base, "/api2/json/access/ticket").expect("API URL should be valid");
            assert_eq!(
                url.as_str(),
                "https://pve.example:8006/api2/json/access/ticket"
            );
        }
    }

    #[test]
    fn exec_status_exited_accepts_json_bool_and_integer_zero_or_one() {
        for (body, expected) in [
            (r#"{"exited":false}"#, false),
            (r#"{"exited":true}"#, true),
            (r#"{"exited":0}"#, false),
            (r#"{"exited":1}"#, true),
            (r#"{"exited":2}"#, true),
            (r#"{}"#, false),
        ] {
            let status: AgentExecStatusRaw =
                serde_json::from_str(body).expect("exec-status response should decode");
            assert_eq!(status.exited, expected, "body was {body}");
        }
    }

    #[test]
    fn file_read_truncated_accepts_json_bool_and_integer_zero_or_one() {
        for (body, expected) in [
            (r#"{"content":"","truncated":false}"#, false),
            (r#"{"content":"","truncated":true}"#, true),
            (r#"{"content":"","truncated":0}"#, false),
            (r#"{"content":"","truncated":1}"#, true),
            (r#"{"content":""}"#, false),
        ] {
            let response: AgentFileReadResponse =
                serde_json::from_str(body).expect("file-read response should decode");
            assert_eq!(response.truncated, expected, "body was {body}");
        }
    }

    #[test]
    fn proxy_port_accepts_number_and_numeric_string() {
        for body in [
            r#"{"port":5900,"ticket":"ticket","password":"password"}"#,
            r#"{"port":"5900","ticket":"ticket","password":"password"}"#,
        ] {
            let proxy: super::ProxyData =
                serde_json::from_str(body).expect("proxy response should decode");
            assert_eq!(proxy.port, 5900);
        }
    }

    #[test]
    fn relay_requires_the_exact_path_and_one_time_token() {
        let valid: http::Uri = "/vnc/connection-1?token=secret-1".parse().unwrap();
        let wrong_path: http::Uri = "/vnc/connection-2?token=secret-1".parse().unwrap();
        let wrong_token: http::Uri = "/vnc/connection-1?token=secret-2".parse().unwrap();
        assert!(valid_relay_request(&valid, "/vnc/connection-1", "secret-1"));
        assert!(!valid_relay_request(
            &wrong_path,
            "/vnc/connection-1",
            "secret-1"
        ));
        assert!(!valid_relay_request(
            &wrong_token,
            "/vnc/connection-1",
            "secret-1"
        ));
    }

    #[test]
    fn usable_guest_ipv4_addresses_excludes_loopback_and_link_local() {
        let interfaces = vec![
            super::GuestNetInterface {
                name: "lo".to_string(),
                mac_address: None,
                ip_addresses: vec![super::GuestIpAddress {
                    address: "127.0.0.1".to_string(),
                    ip_type: "ipv4".to_string(),
                    prefix: 8,
                }],
            },
            super::GuestNetInterface {
                name: "eth0".to_string(),
                mac_address: Some("aa:bb:cc:dd:ee:ff".to_string()),
                ip_addresses: vec![
                    super::GuestIpAddress {
                        address: "169.254.1.5".to_string(),
                        ip_type: "ipv4".to_string(),
                        prefix: 16,
                    },
                    super::GuestIpAddress {
                        address: "192.168.10.20".to_string(),
                        ip_type: "ipv4".to_string(),
                        prefix: 24,
                    },
                    super::GuestIpAddress {
                        address: "fe80::1".to_string(),
                        ip_type: "ipv6".to_string(),
                        prefix: 64,
                    },
                ],
            },
        ];
        assert_eq!(
            super::usable_guest_ipv4_addresses(&interfaces),
            vec!["192.168.10.20".to_string()],
        );
    }

    #[test]
    fn windows_native_path_converts_slashes_and_expands_bare_drive_letters() {
        // A bare drive letter (the synthetic drive-list "root" entry) must
        // become "C:\", not "C:" -- Windows treats "C:" as "the current
        // directory on drive C", not that drive's root.
        assert_eq!(super::windows_native_path("C:"), "C:\\");
        assert_eq!(super::windows_native_path("C:/Users"), "C:\\Users");
        assert_eq!(
            super::windows_native_path("C:/Users/Alice/Documents"),
            "C:\\Users\\Alice\\Documents"
        );
    }

    #[test]
    fn is_windows_drive_rooted_accepts_drive_paths_and_rejects_the_synthetic_root() {
        assert!(super::is_windows_drive_rooted("C:"));
        assert!(super::is_windows_drive_rooted("C:/Users"));
        assert!(super::is_windows_drive_rooted("d:/data"));
        assert!(!super::is_windows_drive_rooted("/"));
        assert!(!super::is_windows_drive_rooted(""));
        assert!(!super::is_windows_drive_rooted("Users"));
    }

    #[test]
    fn powershell_single_quote_doubles_embedded_quotes() {
        assert_eq!(super::powershell_single_quote("C:\\temp"), "'C:\\temp'");
        assert_eq!(
            super::powershell_single_quote("O'Brien's File"),
            "'O''Brien''s File'"
        );
    }

    #[test]
    fn powershell_encoded_command_round_trips_via_utf16le_base64() {
        let script = "Get-ChildItem -LiteralPath 'C:\\'";
        let encoded = super::powershell_encoded_command(script);
        let raw = BASE64
            .decode(encoded)
            .expect("encoded command should be valid base64");
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), script);
    }

    #[test]
    fn parse_unix_find_output_builds_sorted_entries_with_child_paths() {
        let stdout = "d\t0\t1700000000.5\tbeta\nf\t1234\t1700000100.25\talpha.txt\n";
        let files = super::parse_unix_find_output(stdout, "/srv");
        assert_eq!(files.len(), 2);
        // Sorted case-insensitively by name: "alpha.txt" before "beta".
        assert_eq!(files[0].name, "alpha.txt");
        assert!(!files[0].is_directory);
        assert_eq!(files[0].size, 1234);
        assert_eq!(files[0].path, "/srv/alpha.txt");
        assert_eq!(files[0].modified, 1700000100250);
        assert_eq!(files[1].name, "beta");
        assert!(files[1].is_directory);
        assert_eq!(files[1].path, "/srv/beta");
    }

    #[test]
    fn parse_windows_drive_output_trims_and_sorts_drive_letters() {
        let files = super::parse_windows_drive_output("D:\r\nC:\r\n\r\n");
        assert_eq!(
            files.iter().map(|file| file.name.clone()).collect::<Vec<_>>(),
            vec!["C:".to_string(), "D:".to_string()],
        );
        assert!(files.iter().all(|file| file.is_directory));
    }

    #[test]
    fn parse_windows_listing_output_builds_sorted_entries_with_child_paths() {
        let stdout = "d\t0\t1700000000000\tSubfolder\r\nf\t42\t1700000050000\treport.docx\r\n";
        let files = super::parse_windows_listing_output(stdout, "C:/Users/Alice");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "report.docx");
        assert!(!files[0].is_directory);
        assert_eq!(files[0].size, 42);
        assert_eq!(files[0].path, "C:/Users/Alice/report.docx");
        assert_eq!(files[0].modified, 1700000050000);
        assert_eq!(files[1].name, "Subfolder");
        assert!(files[1].is_directory);
        assert_eq!(files[1].path, "C:/Users/Alice/Subfolder");
    }
}
