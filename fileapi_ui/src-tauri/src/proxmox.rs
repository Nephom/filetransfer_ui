use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_tungstenite::{accept_async, Connector};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VncEntry {
    pub id: String,
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
    port: u16,
    ticket: String,
    password: Option<String>,
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
    cookie: String,
    websocket_url: String,
    ignore_tls_errors: bool,
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

fn pending() -> &'static Arc<Mutex<HashMap<String, PendingConnection>>> {
    PENDING.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
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

fn client(ignore_tls_errors: bool) -> Result<Client, String> {
    Client::builder()
        .danger_accept_invalid_certs(ignore_tls_errors)
        .build()
        .map_err(|error| error.to_string())
}

async fn login(entry: &VncEntry, password: &str) -> Result<(Client, String, String), String> {
    let base = normalized_url(&entry.base_url)?;
    let http = client(entry.ignore_tls_errors)?;
    let response = http
        .post(format!("{base}/api2/json/access/ticket"))
        .form(&[
            ("username", entry.username.as_str()),
            ("password", password),
        ])
        .send()
        .await
        .map_err(|error| format!("Unable to reach Proxmox: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Proxmox login failed ({})", response.status()));
    }
    let data: ApiEnvelope<LoginData> = response.json().await.map_err(|error| error.to_string())?;
    Ok((http, data.data.ticket, data.data.csrf_token))
}

pub async fn list_vms(entry: VncEntry, password: String) -> Result<Vec<VmSummary>, String> {
    let (http, ticket, _) = login(&entry, &password).await?;
    let base = normalized_url(&entry.base_url)?;
    let response = http
        .get(format!("{base}/api2/json/cluster/resources?type=vm"))
        .header("Cookie", format!("PVEAuthCookie={ticket}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to list Proxmox VMs ({})",
            response.status()
        ));
    }
    let data: ApiEnvelope<Vec<ClusterVm>> =
        response.json().await.map_err(|error| error.to_string())?;
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
    let (http, auth_ticket, csrf_token) = login(&entry, &password).await?;
    let base = normalized_url(&entry.base_url)?;
    let guest_path = format!("{}/{}/{}", entry.guest_type, vmid, "vncproxy");
    let response = http
        .post(format!(
            "{base}/api2/json/nodes/{}/{guest_path}",
            entry.node
        ))
        .header("Cookie", format!("PVEAuthCookie={auth_ticket}"))
        .header("CSRFPreventionToken", csrf_token)
        .form(&[("websocket", "1"), ("generate-password", "1")])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to create Proxmox VNC session ({})",
            response.status()
        ));
    }
    let data: ApiEnvelope<ProxyData> = response.json().await.map_err(|error| error.to_string())?;
    let password = data
        .data
        .password
        .ok_or_else(|| "Proxmox did not return a VNC password".to_string())?;
    let websocket_url = format!(
        "{base}/api2/json/nodes/{}/{}/vncwebsocket?port={}&vncticket={}",
        entry.node,
        format!("{}/{}", entry.guest_type, vmid),
        data.data.port,
        urlencoding::encode(&data.data.ticket),
    )
    .replace("https://", "wss://");
    let id = uuid::Uuid::new_v4().to_string();
    let listener = TcpListener::bind("localhost:0")
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    pending().lock().await.insert(
        id.clone(),
        PendingConnection {
            cookie: auth_ticket,
            websocket_url,
            ignore_tls_errors: entry.ignore_tls_errors,
        },
    );
    let connection_id = id.clone();
    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let pending_connection = pending().lock().await.remove(&connection_id);
            if let Some(pending_connection) = pending_connection {
                let _ = relay(stream, pending_connection).await;
            }
        }
    });
    Ok(VncConnection {
        id: id.clone(),
        websocket_url: format!("ws://localhost:{}/vnc/{}", address.port(), id),
        password,
    })
}

async fn relay(stream: tokio::net::TcpStream, connection: PendingConnection) -> Result<(), String> {
    let browser = accept_async(stream)
        .await
        .map_err(|error| error.to_string())?;
    let request = http::Request::builder()
        .uri(&connection.websocket_url)
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
            .map_err(|error| error.to_string())?;
    let (mut browser_write, mut browser_read) = browser.split();
    let (mut pve_write, mut pve_read) = pve.split();
    tokio::select! {
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
    }
}
