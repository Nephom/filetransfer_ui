// SSH backend built on `russh` (a pure-Rust SSH client implementation).
//
// This intentionally does NOT shell out to a system `ssh`/`ssh-copy-id`
// binary. Authentication (password or private key) is performed
// programmatically through russh's API, which is why the interactive
// terminal no longer needs to scrape "password:" text out of a PTY to know
// when to inject a stored credential, and why installing a key no longer
// depends on the Unix-only `ssh-copy-id` script being present (it isn't, on
// Windows). The same approach works identically on Linux, macOS and
// Windows.

pub mod known_hosts;
pub mod secrets;
pub mod sftp;

use russh::client::{self, AuthResult};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use tauri::Emitter;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshEvent {
    pub session_id: String,
    pub data: String,
}

pub struct ClientHandler {
    host: String,
    port: u16,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        match known_hosts::verify_and_learn(&self.host, self.port, server_public_key) {
            Ok(known_hosts::HostKeyDecision::TrustedExisting)
            | Ok(known_hosts::HostKeyDecision::TrustedNew) => Ok(true),
            Ok(known_hosts::HostKeyDecision::Mismatch) => Ok(false),
            Err(_) => Ok(false),
        }
    }
}

struct SshSession {
    handle: client::Handle<ClientHandler>,
    write: russh::ChannelWriteHalf<client::Msg>,
}

static SESSIONS: OnceLock<Arc<AsyncMutex<HashMap<String, SshSession>>>> = OnceLock::new();

fn sessions() -> &'static Arc<AsyncMutex<HashMap<String, SshSession>>> {
    SESSIONS.get_or_init(|| Arc::new(AsyncMutex::new(HashMap::new())))
}

fn validate_profile(profile: &SshProfile) -> Result<(), String> {
    if profile.name.trim().is_empty()
        || profile.host.trim().is_empty()
        || profile.username.trim().is_empty()
    {
        return Err("SSH profile name, host, and username are required".to_string());
    }
    if profile.host.chars().any(char::is_whitespace) {
        return Err("SSH host must not contain whitespace".to_string());
    }
    if profile.username.chars().any(char::is_whitespace) {
        return Err("SSH username must not contain whitespace".to_string());
    }
    if profile.port == 0 {
        return Err("SSH port must be between 1 and 65535".to_string());
    }
    if let Some(key_path) = profile.private_key_path.as_deref().map(str::trim) {
        if !key_path.is_empty() {
            let key = Path::new(key_path);
            if !key.is_absolute()
                || key
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err(
                    "SSH private key path must be an absolute path without '..'".to_string(),
                );
            }
            if !key.is_file() {
                return Err("SSH private key file does not exist".to_string());
            }
        }
    }
    Ok(())
}

fn default_config() -> Arc<client::Config> {
    Arc::new(client::Config::default())
}

/// Try public-key authentication (if a key path is configured) and then
/// stored-password authentication (if a password has been saved for this
/// entry). Returns Ok(()) only once one of these methods succeeds.
///
/// A blank/whitespace-only `private_key_path` (e.g. sent as `""` instead of
/// `null` by some callers) is treated as "no key configured" rather than an
/// attempt to load a key from an empty path — otherwise every SFTP browse
/// call for a password-only entry would hard-fail with "Unable to load
/// private key" and never even try the saved password. Likewise, if a real
/// key path IS configured but fails to load/authenticate, we still fall
/// through and try the saved password instead of aborting immediately.
async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    profile: &SshProfile,
) -> Result<(), String> {
    let stored_password = secrets::load_password(&profile.id)?;
    let mut key_error: Option<String> = None;

    let key_path = profile
        .private_key_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());

    if let Some(key_path) = key_path {
        let passphrase = stored_password.as_deref();
        match russh::keys::load_secret_key(key_path, passphrase) {
            Ok(key) => {
                let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256));
                let result = handle
                    .authenticate_publickey(profile.username.clone(), key_with_hash)
                    .await
                    .map_err(|error| error.to_string())?;
                if matches!(result, AuthResult::Success) {
                    return Ok(());
                }
            }
            Err(error) => {
                key_error = Some(format!("Unable to load private key: {error}"));
            }
        }
    }

    if let Some(password) = stored_password {
        let result = handle
            .authenticate_password(profile.username.clone(), password)
            .await
            .map_err(|error| error.to_string())?;
        if matches!(result, AuthResult::Success) {
            return Ok(());
        }
    }

    Err(key_error.unwrap_or_else(|| {
        "Authentication failed. Add a password or a private key to this SSH entry in the Session manager, then try again.".to_string()
    }))
}

/// Bound how long a connection attempt (TCP connect, key exchange, and
/// authentication) may take before giving up. Without this, an unreachable
/// or unresponsive host could hang the connect flow indefinitely with no way
/// for the UI to recover.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub async fn connect(app: tauri::AppHandle, profile: SshProfile) -> Result<String, String> {
    validate_profile(&profile)?;
    let session_id = format!("ssh-{}", uuid::Uuid::new_v4());
    let handler = ClientHandler {
        host: profile.host.clone(),
        port: profile.port,
    };
    let addr = format!("{}:{}", profile.host, profile.port);
    let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(default_config(), addr, handler))
        .await
        .map_err(|_| format!("Connection to {}:{} timed out after {} seconds.", profile.host, profile.port, CONNECT_TIMEOUT.as_secs()))?
        .map_err(|error| format!("Unable to connect: {error}"))?;

    tokio::time::timeout(CONNECT_TIMEOUT, authenticate(&mut handle, &profile))
        .await
        .map_err(|_| "Authentication timed out.".to_string())??;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    channel
        .request_pty(false, "xterm-256color", 120, 32, 0, 0, &[])
        .await
        .map_err(|error| error.to_string())?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| error.to_string())?;
    let (mut read_half, write_half) = channel.split();

    sessions().lock().await.insert(
        session_id.clone(),
        SshSession {
            handle,
            write: write_half,
        },
    );

    let reader_session = session_id.clone();
    tokio::spawn(async move {
        loop {
            match read_half.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    let _ = app.emit(
                        "ssh-output",
                        SshEvent {
                            session_id: reader_session.clone(),
                            data: text,
                        },
                    );
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    let _ = app.emit(
                        "ssh-output",
                        SshEvent {
                            session_id: reader_session.clone(),
                            data: text,
                        },
                    );
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                None => break,
                _ => {}
            }
        }
        let _ = app.emit(
            "ssh-exit",
            SshEvent {
                session_id: reader_session.clone(),
                data: "SSH process ended.".to_string(),
            },
        );
        sessions().lock().await.remove(&reader_session);
    });

    Ok(session_id)
}

pub async fn write(session_id: String, data: String) -> Result<(), String> {
    let sessions = sessions().lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "SSH session is not connected".to_string())?;
    session
        .write
        .data(data.into_bytes().as_slice())
        .await
        .map_err(|error| error.to_string())
}

pub async fn resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("SSH terminal size must be greater than zero".to_string());
    }
    let sessions = sessions().lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "SSH session is not connected".to_string())?;
    session
        .write
        .window_change(cols as u32, rows as u32, 0, 0)
        .await
        .map_err(|error| error.to_string())
}

pub async fn disconnect(session_id: String) -> Result<(), String> {
    if let Some(session) = sessions().lock().await.remove(&session_id) {
        let _ = session.write.close().await;
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    Ok(())
}

/// Check whether the SSH entry can already authenticate without a stored
/// password prompt, i.e. a usable private key is configured. Password-only
/// entries always report `false` here so the caller knows a stored password
/// (or one about to be typed into the Session manager) is required.
pub fn key_available(profile: &SshProfile) -> Result<bool, String> {
    validate_profile(profile)?;
    Ok(profile
        .private_key_path
        .as_ref()
        .map(|path| Path::new(path).is_file())
        .unwrap_or(false))
}

/// Install a public key on the remote host's `~/.ssh/authorized_keys`,
/// without depending on the external `ssh-copy-id` script (which does not
/// exist on Windows). Authenticates with the entry's stored password, then
/// runs the equivalent of what `ssh-copy-id` does over an exec channel.
pub async fn install_key(profile: SshProfile) -> Result<String, String> {
    validate_profile(&profile)?;
    let home = crate::local_home()?;
    let key_path = profile
        .private_key_path
        .clone()
        .map(std::path::PathBuf::from)
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
    let public_key_path = key_path.with_extension(match key_path.extension() {
        Some(extension) => format!("{}.pub", extension.to_string_lossy()),
        None => "pub".to_string(),
    });
    let public_key_content =
        std::fs::read_to_string(&public_key_path).map_err(|error| error.to_string())?;

    let stored_password = secrets::load_password(&profile.id)?.ok_or_else(|| {
        "Add a password for this SSH entry in the Session manager before installing a key."
            .to_string()
    })?;

    let handler = ClientHandler {
        host: profile.host.clone(),
        port: profile.port,
    };
    let addr = format!("{}:{}", profile.host, profile.port);
    let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(default_config(), addr, handler))
        .await
        .map_err(|_| format!("Connection to {}:{} timed out.", profile.host, profile.port))?
        .map_err(|error| format!("Unable to connect: {error}"))?;
    let result = handle
        .authenticate_password(profile.username.clone(), stored_password)
        .await
        .map_err(|error| error.to_string())?;
    if !matches!(result, AuthResult::Success) {
        return Err("Password authentication failed while installing the SSH key.".to_string());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    let remote_command = format!(
        "umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF -- \"$(cat)\" ~/.ssh/authorized_keys || cat >> ~/.ssh/authorized_keys",
    );
    channel
        .exec(true, remote_command.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    channel
        .data(public_key_content.trim_end().as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    channel.eof().await.map_err(|error| error.to_string())?;

    let mut exit_status: Option<u32> = None;
    let mut channel = channel;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExitStatus { exit_status: status }) => {
                exit_status = Some(status);
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    match exit_status {
        Some(0) => Ok(format!(
            "SSH key installed for {}@{}.",
            profile.username, profile.host
        )),
        Some(code) => Err(format!(
            "Key installation command exited with status {code}."
        )),
        None => Err("Key installation did not complete.".to_string()),
    }
}

pub fn save_password(entry_id: String, password: String) -> Result<(), String> {
    secrets::save_password(&entry_id, &password)
}

pub fn forget_password(entry_id: String) -> Result<(), String> {
    secrets::forget_password(&entry_id)
}

pub fn has_password(entry_id: String) -> Result<bool, String> {
    Ok(secrets::load_password(&entry_id)?.is_some())
}
