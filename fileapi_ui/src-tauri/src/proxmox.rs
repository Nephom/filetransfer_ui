use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::de::{DeserializeOwned, Deserializer, Error as DeError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
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

#[cfg(test)]
mod tests {
    use super::{api_url, normalized_url, valid_relay_request};

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
}
