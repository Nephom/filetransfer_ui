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
#[cfg(unix)]
use russh::keys::agent::client::{AgentClient, AgentStream};
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
    /// Jump host (SSH `ProxyJump`-equivalent). When set, `connect_transport`
    /// first opens and authenticates its own SSH session to
    /// `jump_host:jump_port`, then asks it for a `direct-tcpip` forwarding
    /// channel to this profile's `host:port` and layers a second SSH
    /// session on top of that tunneled channel -- entirely through
    /// `russh`'s own SSH-protocol-level channel API, never by shelling out
    /// to a system `ssh -J`/`plink -J`.
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_username: Option<String>,
    #[serde(default)]
    pub jump_private_key_path: Option<String>,
    /// Profile id used to look up (and, from "Install SSH key", write) the
    /// jump host's own stored password/identity in the OS keyring, kept
    /// separate from this profile's own `id` so the jump host and the
    /// target it tunnels to can each have an independently stored password
    /// without colliding. Falls back to `"{id}::jump"` when not given.
    #[serde(default)]
    pub jump_profile_id: Option<String>,
}

/// Incrementally decodes SSH channel bytes to UTF-8, buffering a trailing
/// incomplete multi-byte sequence in `carry` across calls instead of
/// replacing it with `U+FFFD` the way `String::from_utf8_lossy` does when
/// applied to a single chunk in isolation. Genuinely invalid byte sequences
/// (not just "incomplete because more is coming") are still replaced with
/// `U+FFFD`, matching `from_utf8_lossy`'s own behavior -- only sequences
/// that are valid *so far* and could be completed by the next chunk are
/// held back. ASCII bytes (0x00-0x7F), which is every byte of every ANSI/
/// VT escape and control sequence, are single-byte in UTF-8 and are never
/// affected by this either way.
fn decode_ssh_chunk(carry: &mut Vec<u8>, data: &[u8]) -> String {
    carry.extend_from_slice(data);
    let mut output = String::new();
    let mut offset = 0usize;
    loop {
        match std::str::from_utf8(&carry[offset..]) {
            Ok(text) => {
                output.push_str(text);
                offset = carry.len();
                break;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                output.push_str(
                    std::str::from_utf8(&carry[offset..offset + valid_up_to])
                        .expect("bytes up to valid_up_to are guaranteed valid UTF-8"),
                );
                offset += valid_up_to;
                match error.error_len() {
                    // Incomplete tail: might be completed by the next
                    // chunk, so stop here and keep it buffered.
                    None => break,
                    // Genuinely invalid (not just incomplete): nothing to
                    // wait for, so drop it like `from_utf8_lossy` would and
                    // keep decoding whatever follows in this same chunk.
                    Some(len) => {
                        output.push('\u{FFFD}');
                        offset += len;
                    }
                }
            }
        }
    }
    carry.drain(..offset);
    output
}

#[cfg(test)]
mod chunk_decoding_tests {
    use super::decode_ssh_chunk;

    #[test]
    fn passes_through_ascii_and_ansi_escapes_unchanged() {
        let mut carry = Vec::new();
        let input = b"\x1b[31mHello\x1b[0m\r\n\x1b]0;title\x07";
        let out = decode_ssh_chunk(&mut carry, input);
        assert_eq!(out, String::from_utf8(input.to_vec()).unwrap());
        assert!(carry.is_empty());
    }

    #[test]
    fn reassembles_a_multibyte_character_split_across_chunks() {
        // "─" (U+2500, box drawing) is E2 94 80 in UTF-8.
        let full = "─".as_bytes().to_vec();
        assert_eq!(full.len(), 3);
        let mut carry = Vec::new();
        let first = decode_ssh_chunk(&mut carry, &full[..1]);
        assert_eq!(first, "", "an incomplete sequence must not be emitted yet");
        assert_eq!(carry.len(), 1);
        let second = decode_ssh_chunk(&mut carry, &full[1..2]);
        assert_eq!(second, "");
        assert_eq!(carry.len(), 2);
        let third = decode_ssh_chunk(&mut carry, &full[2..3]);
        assert_eq!(third, "─");
        assert!(carry.is_empty());
    }

    #[test]
    fn reassembles_a_split_character_surrounded_by_ansi_and_ascii() {
        let mut input = Vec::new();
        input.extend_from_slice(b"\x1b[1mfoo ");
        input.extend_from_slice("─".as_bytes());
        input.extend_from_slice(b" bar\x1b[0m");
        // Split right inside the 3-byte "─" sequence.
        let split_at = input.len() - 5;
        let mut carry = Vec::new();
        let mut out = decode_ssh_chunk(&mut carry, &input[..split_at]);
        out.push_str(&decode_ssh_chunk(&mut carry, &input[split_at..]));
        assert_eq!(out, String::from_utf8(input).unwrap());
        assert!(carry.is_empty());
    }

    #[test]
    fn replaces_genuinely_invalid_bytes_without_blocking_later_valid_text() {
        let mut carry = Vec::new();
        // 0xFF is never valid as a UTF-8 lead byte.
        let input = [b'a', 0xFF, b'b'];
        let out = decode_ssh_chunk(&mut carry, &input);
        assert_eq!(out, "a\u{FFFD}b");
        assert!(carry.is_empty());
    }

    #[test]
    fn multiple_chunks_of_plain_ascii_never_buffer_anything() {
        let mut carry = Vec::new();
        for chunk in [
            b"first ".as_slice(),
            b"second ".as_slice(),
            b"third".as_slice(),
        ] {
            let out = decode_ssh_chunk(&mut carry, chunk);
            assert_eq!(out.as_bytes(), chunk);
            assert!(carry.is_empty());
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshEvent {
    pub session_id: String,
    pub data: String,
    /// Echoes back the frontend-generated id of the connection attempt this
    /// event belongs to (see `connect`'s `request_id` parameter). The
    /// frontend uses this to bind an `ssh-output`/`ssh-exit` event to the
    /// terminal tab that initiated the connection *before* the `ssh_connect`
    /// invoke() call resolves with the real `session_id` -- output can start
    /// streaming immediately once the shell is ready, which is before the
    /// frontend has any other way to know which tab a given `session_id`
    /// belongs to. Relying on invocation order instead (e.g. a FIFO of
    /// "pending" tabs) is unsound: when several SSH entries connect close
    /// together, event arrival order is not guaranteed to match the order
    /// `ssh_connect` was invoked in, which cross-wires tabs (one tab's
    /// output/session state overwrites another's).
    pub request_id: String,
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
    handle: ClientSession,
    write: russh::ChannelWriteHalf<client::Msg>,
}

/// A connected (and, once returned by `open_client_session`, authenticated)
/// SSH client handle to `SshProfile.host:port`. When the profile configures
/// a `jump_host`, this bundles the otherwise-unused-by-callers jump-host
/// handle alongside the inner handle to the real target, so the jump
/// connection -- and therefore the tunneled channel the inner handle's
/// traffic actually flows over -- is kept alive for exactly as long as
/// `handle` is. `Deref`/`DerefMut` to the inner `client::Handle` let every
/// existing call site (`channel_open_session()`, `is_closed()`,
/// `disconnect()`, ...) keep working unchanged.
pub(crate) struct ClientSession {
    handle: client::Handle<ClientHandler>,
    jump_handle: Option<client::Handle<ClientHandler>>,
}

impl std::ops::Deref for ClientSession {
    type Target = client::Handle<ClientHandler>;
    fn deref(&self) -> &Self::Target {
        &self.handle
    }
}

impl std::ops::DerefMut for ClientSession {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.handle
    }
}

impl ClientSession {
    /// Best-effort disconnect of both the target handle and (if this
    /// session was tunneled) the jump-host handle it depends on.
    async fn disconnect_all(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        if let Some(jump_handle) = &self.jump_handle {
            let _ = jump_handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
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
    if let Some(jump_host) = profile.jump_host.as_deref().map(str::trim) {
        if !jump_host.is_empty() {
            if jump_host.chars().any(char::is_whitespace) {
                return Err("SSH jump host must not contain whitespace".to_string());
            }
            if profile.jump_username.as_deref().unwrap_or("").trim().is_empty() {
                return Err("SSH jump host username is required".to_string());
            }
            if profile
                .jump_username
                .as_deref()
                .unwrap_or("")
                .chars()
                .any(char::is_whitespace)
            {
                return Err("SSH jump host username must not contain whitespace".to_string());
            }
            if profile.jump_port.map(|port| port == 0).unwrap_or(false) {
                return Err("SSH jump host port must be between 1 and 65535".to_string());
            }
        }
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
                    "SSH private key path must be an absolute path without '..'".to_string()
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

/// A short, non-secret label identifying this connection attempt in log
/// entries (`user@host:port`).
fn profile_label(profile: &SshProfile) -> String {
    format!("{}@{}:{}", profile.username, profile.host, profile.port)
}

/// Try every identity held by an already-connected agent client. Shared by
/// every platform's `try_agent_auth` below -- only *connecting* to an agent
/// differs by platform (Unix domain socket vs. Windows Pageant/named pipe);
/// listing identities and attempting each one is identical everywhere.
/// Returns `true` on success.
#[cfg(unix)]
async fn try_agent_identities<S>(
    handle: &mut client::Handle<ClientHandler>,
    profile: &SshProfile,
    mut agent: AgentClient<S>,
) -> bool
where
    S: AgentStream + Send + Unpin,
{
    let label = profile_label(profile);
    let identities = match agent.request_identities().await {
        Ok(identities) => identities,
        Err(error) => {
            crate::oplog::log(
                "DEBUG",
                "ssh_auth",
                "skipped",
                &label,
                "agent",
                &format!("Unable to list SSH agent identities: {error}"),
            );
            return false;
        }
    };
    if identities.is_empty() {
        crate::oplog::log(
            "DEBUG",
            "ssh_auth",
            "skipped",
            &label,
            "agent",
            "SSH agent is running but holds no identities.",
        );
        return false;
    }
    for identity in identities {
        let comment = identity.comment().to_string();
        let public_key = identity.public_key().into_owned();
        crate::oplog::log(
            "DEBUG",
            "ssh_auth",
            "attempting",
            &label,
            "agent",
            &format!("Trying agent identity \"{comment}\"."),
        );
        let result = handle
            .authenticate_publickey_with(
                profile.username.clone(),
                public_key,
                Some(HashAlg::Sha256),
                &mut agent,
            )
            .await;
        match result {
            Ok(AuthResult::Success) => {
                crate::oplog::log(
                    "INFO",
                    "ssh_auth",
                    "succeeded",
                    &label,
                    "agent",
                    &format!("Authenticated using agent identity \"{comment}\"."),
                );
                return true;
            }
            Ok(AuthResult::Failure { .. }) => {
                crate::oplog::log(
                    "DEBUG",
                    "ssh_auth",
                    "failed",
                    &label,
                    "agent",
                    &format!("Server rejected agent identity \"{comment}\"."),
                );
            }
            Err(error) => {
                crate::oplog::log(
                    "DEBUG",
                    "ssh_auth",
                    "failed",
                    &label,
                    "agent",
                    &format!("Agent identity \"{comment}\" errored: {error}"),
                );
            }
        }
    }
    false
}

/// Try every identity the running SSH agent currently holds. Returns
/// `true` on success, `false` if no identity worked (or no agent is
/// running), and never treats "agent unavailable" as a hard error -- that
/// is an expected, common case (no agent running at all) that should just
/// fall through to the next auth method.
///
/// Unix (including macOS): connects via the OpenSSH agent protocol over
/// the `SSH_AUTH_SOCK` Unix-domain socket, exactly like a normal `ssh`
/// client.
#[cfg(unix)]
async fn try_agent_auth(handle: &mut client::Handle<ClientHandler>, profile: &SshProfile) -> bool {
    let label = profile_label(profile);
    let agent = match AgentClient::connect_env().await {
        Ok(agent) => agent,
        Err(error) => {
            crate::oplog::log(
                "DEBUG",
                "ssh_auth",
                "skipped",
                &label,
                "agent",
                &format!("No SSH agent available: {error}"),
            );
            return false;
        }
    };
    try_agent_identities(handle, profile, agent).await
}

/// Windows authentication is intentionally self-contained. Do not probe
/// Pageant or the optional OpenSSH Authentication Agent service: the app uses
/// its managed `.ssh` directory (or the user's fallback directory) directly.
#[cfg(windows)]
async fn try_agent_auth(
    _handle: &mut client::Handle<ClientHandler>,
    _profile: &SshProfile,
) -> bool {
    false
}

/// No known agent transport on any other target; fall straight through to
/// the next auth method.
#[cfg(not(any(unix, windows)))]
async fn try_agent_auth(
    _handle: &mut client::Handle<ClientHandler>,
    _profile: &SshProfile,
) -> bool {
    false
}

/// Try public-key authentication against a single key file on disk (an
/// explicitly-configured `private_key_path`, or one of the default identity
/// files below). `source_tag` distinguishes the two in the log
/// (`identity_file` vs `configured_key`).
async fn try_key_file(
    handle: &mut client::Handle<ClientHandler>,
    profile: &SshProfile,
    path: &Path,
    passphrase: Option<&str>,
    source_tag: &str,
) -> Result<bool, String> {
    let label = profile_label(profile);
    crate::oplog::log(
        "DEBUG",
        "ssh_auth",
        "attempting",
        &label,
        source_tag,
        &format!("Trying key file {}.", path.display()),
    );
    let key = russh::keys::load_secret_key(path, passphrase).map_err(|error| error.to_string())?;
    let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256));
    let result = handle
        .authenticate_publickey(profile.username.clone(), key_with_hash)
        .await
        .map_err(|error| error.to_string())?;
    if matches!(result, AuthResult::Success) {
        crate::oplog::log(
            "INFO",
            "ssh_auth",
            "succeeded",
            &label,
            source_tag,
            &format!("Authenticated using key file {}.", path.display()),
        );
        Ok(true)
    } else {
        crate::oplog::log(
            "DEBUG",
            "ssh_auth",
            "failed",
            &label,
            source_tag,
            &format!("Server rejected key file {}.", path.display()),
        );
        Ok(false)
    }
}

/// Try each default OpenSSH identity file (`~/.ssh/id_ed25519`,
/// `id_ecdsa`, `id_rsa`, in that order) that actually exists on disk. This
/// mirrors what a normal `ssh` client tries automatically when no identity
/// file is specified with `-i`, which is why a host that a plain `ssh`
/// command can already reach password-lessly was previously unreachable
/// from this app (it only ever tried an *explicitly configured* key path).
async fn try_default_identity_files(
    handle: &mut client::Handle<ClientHandler>,
    profile: &SshProfile,
    passphrase: Option<&str>,
) -> bool {
    let label = profile_label(profile);
    let Ok(ssh_dir) = crate::ssh_storage_dir() else {
        return false;
    };
    for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
        let path = ssh_dir.join(name);
        if !path.is_file() {
            continue;
        }
        match try_key_file(handle, profile, &path, passphrase, "default_identity_file").await {
            Ok(true) => return true,
            Ok(false) => continue,
            Err(error) => {
                crate::oplog::log(
                    "DEBUG",
                    "ssh_auth",
                    "failed",
                    &label,
                    "default_identity_file",
                    &format!("Unable to use {}: {error}", path.display()),
                );
                continue;
            }
        }
    }
    false
}

/// Authenticate using, in order: (1) any identity already loaded into a
/// running SSH agent where the platform supports automatic discovery, (2) the
/// default identity files in the app's SSH storage directory, (3) the SSH
/// entry's explicitly-configured `private_key_path`, (4) the SSH entry's
/// stored password. Returns Ok(()) only once one of these methods succeeds;
/// every attempt (and its outcome) is written to the operation log so a
/// failure can be diagnosed without guesswork.
///
/// A blank/whitespace-only `private_key_path` (e.g. sent as `""` instead of
/// `null` by some callers) is treated as "no key configured" rather than an
/// attempt to load a key from an empty path.
async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    profile: &SshProfile,
) -> Result<(), String> {
    let label = profile_label(profile);
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    crate::oplog::log(
        "DEBUG",
        "ssh_auth",
        "started",
        &label,
        "",
        &serde_json::json!({"operationId": operation_id, "authMethod": "auto", "identitySource": "agent/default/configured/password", "attempt": 0, "identityLabel": label}).to_string(),
    );
    let stored_password = secrets::load_password(&profile.id)?;

    if try_agent_auth(handle, profile).await {
        return Ok(());
    }

    if try_default_identity_files(handle, profile, stored_password.as_deref()).await {
        return Ok(());
    }

    let mut key_error: Option<String> = None;
    let key_path = profile
        .private_key_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());

    if let Some(key_path) = key_path {
        match try_key_file(
            handle,
            profile,
            Path::new(key_path),
            stored_password.as_deref(),
            "configured_key",
        )
        .await
        {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) => {
                key_error = Some(format!("Unable to load private key: {error}"));
            }
        }
    }

    if let Some(password) = stored_password {
        crate::oplog::log(
            "DEBUG",
            "ssh_auth",
            "attempting",
            &label,
            "password",
            &serde_json::json!({"operationId": operation_id, "authMethod": "password", "identitySource": "stored_secret", "attempt": 1, "identityLabel": label, "safeDetail": "Trying the stored password."}).to_string(),
        );
        let result = handle
            .authenticate_password(profile.username.clone(), password)
            .await
            .map_err(|error| error.to_string())?;
        if matches!(result, AuthResult::Success) {
            crate::oplog::log(
                "INFO",
                "ssh_auth",
                "succeeded",
                &label,
                "password",
                &serde_json::json!({"operationId": operation_id, "authMethod": "password", "identitySource": "stored_secret", "attempt": 1, "identityLabel": label}).to_string(),
            );
            return Ok(());
        }
        crate::oplog::log(
            "WARN",
            "ssh_auth",
            "failed",
            &label,
            "password",
            &serde_json::json!({"operationId": operation_id, "authMethod": "password", "identitySource": "stored_secret", "attempt": 1, "identityLabel": label, "failureType": "rejected"}).to_string(),
        );
    }

    let message = key_error.unwrap_or_else(|| {
        "Authentication failed. Add a password or a private key to this SSH entry in the Session manager, then try again.".to_string()
    });
    crate::oplog::log("ERROR", "ssh_auth", "failed", &label, "", &serde_json::json!({"operationId": operation_id, "authMethod": "auto", "identitySource": "configured", "attempt": 1, "identityLabel": label, "durationMs": started.elapsed().as_millis(), "failureType": "authentication", "error": message}).to_string());
    Err(message)
}

/// Bound how long a connection attempt (TCP connect, key exchange, and
/// authentication) may take before giving up. Without this, an unreachable
/// or unresponsive host could hang the connect flow indefinitely with no way
/// for the UI to recover.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Open a raw (not yet authenticated) SSH transport directly to
/// `profile.host:profile.port`, ignoring any `jump_host` on `profile` --
/// used both for a plain direct connection and, when tunneling, for the
/// jump host's own leg of the trip.
async fn connect_direct(profile: &SshProfile) -> Result<client::Handle<ClientHandler>, String> {
    let handler = ClientHandler {
        host: profile.host.clone(),
        port: profile.port,
    };
    let addr = format!("{}:{}", profile.host, profile.port);
    match tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(default_config(), addr, handler),
    )
    .await
    {
        Ok(Ok(handle)) => Ok(handle),
        Ok(Err(error)) => Err(format!("Unable to connect: {error}")),
        Err(_) => Err(format!(
            "Connection to {}:{} timed out after {} seconds.",
            profile.host,
            profile.port,
            CONNECT_TIMEOUT.as_secs()
        )),
    }
}

/// Open a raw (not yet authenticated) SSH transport to `profile.host:port`,
/// tunneling through `profile.jump_host` first when configured. This is the
/// one place jump-host support lives: every caller (the interactive
/// terminal's `connect()`, the SFTP browser's `open_connection()`, and key
/// installation's `install_key_inner()`) goes through this function, so all
/// three automatically gain jump-host support from a single implementation.
///
/// The jump host's own handle is bundled into the returned `ClientSession`
/// (see its doc comment) rather than being dropped once the tunnel is
/// established, because dropping it would tear down the tunneled channel
/// the returned handle's traffic flows over.
async fn connect_transport(profile: &SshProfile) -> Result<ClientSession, String> {
    let jump_host = profile
        .jump_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(jump_host) = jump_host else {
        let handle = connect_direct(profile).await?;
        return Ok(ClientSession {
            handle,
            jump_handle: None,
        });
    };
    let jump_profile = SshProfile {
        id: profile
            .jump_profile_id
            .clone()
            .unwrap_or_else(|| format!("{}::jump", profile.id)),
        name: format!("{} (jump host)", profile.name),
        host: jump_host.to_string(),
        port: profile.jump_port.filter(|port| *port != 0).unwrap_or(22),
        username: profile.jump_username.clone().unwrap_or_default(),
        private_key_path: profile.jump_private_key_path.clone(),
        jump_host: None,
        jump_port: None,
        jump_username: None,
        jump_private_key_path: None,
        jump_profile_id: None,
    };
    let mut jump_handle = connect_direct(&jump_profile).await?;
    authenticate(&mut jump_handle, &jump_profile)
        .await
        .map_err(|error| format!("Jump host authentication failed: {error}"))?;
    let channel = jump_handle
        .channel_open_direct_tcpip(profile.host.clone(), profile.port as u32, "127.0.0.1", 0)
        .await
        .map_err(|error| {
            format!(
                "Unable to open a tunnel to {}:{} via jump host {}: {error}",
                profile.host, profile.port, jump_profile.host
            )
        })?;
    let stream = channel.into_stream();
    let handler = ClientHandler {
        host: profile.host.clone(),
        port: profile.port,
    };
    let handle = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect_stream(default_config(), stream, handler),
    )
    .await
    .map_err(|_| {
        format!(
            "Connection to {}:{} via jump host {} timed out.",
            profile.host, profile.port, jump_profile.host
        )
    })?
    .map_err(|error| {
        format!(
            "Unable to connect to {}:{} via jump host {}: {error}",
            profile.host, profile.port, jump_profile.host
        )
    })?;
    Ok(ClientSession {
        handle,
        jump_handle: Some(jump_handle),
    })
}

/// Open and fully authenticate an SSH transport to `profile` (transparently
/// tunneling through `profile.jump_host` when configured). `connect()` below
/// and `sftp::open_connection()` inline these same two steps themselves
/// (rather than calling this) so each can log its own "tcp_connected" vs.
/// "authenticated" milestones separately; `install_key_inner()` uses
/// `connect_transport()` directly instead of this, since it always
/// authenticates with the stored password specifically (never a key), even
/// for entries that already have a usable key configured. Kept as the
/// single obvious place to wire up a caller that doesn't need that
/// granularity.
#[allow(dead_code)]
async fn open_client_session(profile: &SshProfile) -> Result<ClientSession, String> {
    let mut session = connect_transport(profile).await?;
    authenticate(&mut session.handle, profile).await?;
    Ok(session)
}

/// Real reachability probe for a route this desktop client would actually
/// use for SFTP: unlike a raw TCP connect (which only proves *some* process
/// is listening on that port), this drives `connect_transport()` -- the
/// exact function `ssh_list_directory`/`ssh_upload_path`/`ssh_download_path`
/// use -- so it proves a live SSH server answers at `profile.host:port`,
/// and, when `profile.jump_host` is set, that the jump host's own stored
/// credentials actually authenticate and that it can open a `direct-tcpip`
/// channel through to that target.
///
/// This is what VNC file transfer's `detectTransferMode()` uses to decide
/// between `direct-sftp`/`jump-sftp`/`guest-agent`: probing the jump host's
/// *own* SSH port (which is always up -- it's the Proxmox hypervisor
/// itself) would say nothing about whether the VM behind it actually runs
/// SSH, which is exactly the false-positive this avoids. No credentials for
/// the tunneled *target* are needed or used here -- `connect_transport`
/// completes the SSH transport/key-exchange handshake but never
/// authenticates as a user against `profile.host`, only (when tunneling)
/// against the jump host.
///
/// Never returns `Err`: any failure (invalid profile, jump auth failure,
/// tunnel refused, target doesn't speak SSH, timeout) is logged and folded
/// into `false`, matching `netcheck::is_port_reachable`'s contract so the
/// frontend can treat this as a plain yes/no signal.
pub async fn check_transport_reachable(profile: SshProfile, timeout_ms: u64) -> bool {
    let label = profile_label(&profile);
    if let Err(error) = validate_profile(&profile) {
        crate::oplog::log(
            "DEBUG",
            "ssh_check_transport",
            "skipped",
            &label,
            "",
            &format!("Invalid probe profile: {error}"),
        );
        return false;
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.max(1));
    match tokio::time::timeout(timeout, connect_transport(&profile)).await {
        Ok(Ok(session)) => {
            session.disconnect_all().await;
            crate::oplog::log(
                "DEBUG",
                "ssh_check_transport",
                "reachable",
                &label,
                "",
                "",
            );
            true
        }
        Ok(Err(error)) => {
            crate::oplog::log(
                "DEBUG",
                "ssh_check_transport",
                "unreachable",
                &label,
                "",
                &error,
            );
            false
        }
        Err(_) => {
            crate::oplog::log(
                "DEBUG",
                "ssh_check_transport",
                "unreachable",
                &label,
                "",
                &format!("Probe timed out after {}ms", timeout_ms),
            );
            false
        }
    }
}

pub async fn connect(
    app: tauri::AppHandle,
    profile: SshProfile,
    request_id: String,
) -> Result<String, String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    if let Err(error) = validate_profile(&profile) {
        crate::oplog::log("ERROR", "ssh_connect", "failed", "SSH profile", "terminal", &serde_json::json!({"operationId": operation_id, "requestId": request_id, "durationMs": started.elapsed().as_millis(), "failureType": "validation", "error": error}).to_string());
        return Err(error);
    }
    let label = profile_label(&profile);
    let session_id = format!("ssh-{}", uuid::Uuid::new_v4());
    crate::oplog::log(
        "INFO",
        "ssh_connect",
        "started",
        &label,
        "terminal",
        &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "target": format!("{}:{}", profile.host, profile.port)}).to_string(),
    );
    let mut session = match connect_transport(&profile).await {
        Ok(session) => session,
        Err(message) => {
            crate::oplog::log(
                "ERROR",
                "ssh_connect",
                "failed",
                &label,
                "terminal",
                &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "network", "error": message}).to_string(),
            );
            return Err(message);
        }
    };
    crate::oplog::log(
        "DEBUG",
        "ssh_connect",
        "tcp_connected",
        &label,
        "terminal",
        &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "phase": "key_exchange"}).to_string(),
    );

    if let Err(error) =
        tokio::time::timeout(CONNECT_TIMEOUT, authenticate(&mut session.handle, &profile))
            .await
            .unwrap_or_else(|_| Err("Authentication timed out.".to_string()))
    {
        crate::oplog::log(
            "ERROR",
            "ssh_connect",
            "failed",
            &label,
            "terminal",
            &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "authentication", "error": error.to_string()}).to_string(),
        );
        return Err(error);
    }

    let channel = match session.channel_open_session().await {
        Ok(channel) => channel,
        Err(error) => {
            let message = error.to_string();
            crate::oplog::log("ERROR", "ssh_connect", "failed", &label, "terminal", &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "channel_open", "error": message}).to_string());
            return Err(message);
        }
    };
    if let Err(error) = channel.request_pty(false, "xterm-256color", 120, 32, 0, 0, &[]).await {
        let message = error.to_string();
        crate::oplog::log("ERROR", "ssh_connect", "failed", &label, "terminal", &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "pty_request", "error": message}).to_string());
        return Err(message);
    }
    if let Err(error) = channel.request_shell(true).await {
        let message = error.to_string();
        crate::oplog::log("ERROR", "ssh_connect", "failed", &label, "terminal", &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis(), "failureType": "shell_request", "error": message}).to_string());
        return Err(message);
    }
    let (mut read_half, write_half) = channel.split();

    sessions().lock().await.insert(
        session_id.clone(),
        SshSession {
            handle: session,
            write: write_half,
        },
    );
    crate::oplog::log(
        "INFO",
        "ssh_connect",
        "connected",
        &label,
        "terminal",
        &serde_json::json!({"operationId": operation_id, "requestId": request_id, "sessionId": session_id, "durationMs": started.elapsed().as_millis()}).to_string(),
    );

    let reader_session = session_id.clone();
    let reader_label = label.clone();
    let reader_request_id = request_id.clone();
    tokio::spawn(async move {
        // Bytes read from the SSH channel arrive in arbitrary TCP-sized
        // chunks, with no guarantee a chunk boundary lines up with a
        // character boundary. `String::from_utf8_lossy` applied
        // independently to *each* chunk (the previous behavior here) turns
        // any multi-byte UTF-8 character split across two reads (box-drawing
        // glyphs, many prompt icons, non-ASCII filenames, etc.) into a
        // `U+FFFD` replacement character on both sides of the split. `carry`
        // buffers a trailing incomplete sequence across reads so it decodes
        // correctly once the rest of it arrives. ASCII text and every ANSI/
        // VT escape/control sequence are unaffected either way -- their
        // bytes are always < 0x80 and therefore never span multiple bytes.
        let mut carry: Vec<u8> = Vec::new();
        let mut stderr_carry: Vec<u8> = Vec::new();
        loop {
            match read_half.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    let text = decode_ssh_chunk(&mut carry, &data);
                    if text.is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        "ssh-output",
                        SshEvent {
                            session_id: reader_session.clone(),
                            data: text,
                            request_id: reader_request_id.clone(),
                        },
                    );
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    // Stderr is a logically distinct byte stream from the
                    // main Data channel above, so it gets its own carry
                    // buffer -- a split multi-byte sequence on one stream
                    // has nothing to do with the other.
                    let text = decode_ssh_chunk(&mut stderr_carry, &data);
                    if text.is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        "ssh-output",
                        SshEvent {
                            session_id: reader_session.clone(),
                            data: text,
                            request_id: reader_request_id.clone(),
                        },
                    );
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                None => break,
                _ => {}
            }
        }
        // Flush any trailing incomplete sequence left in either buffer when
        // the connection ends (rather than silently dropping it) so the
        // very last bytes of a session are never lost -- there is no "next
        // chunk" coming to complete them, so this is the one place a lossy
        // decode of the remainder is correct.
        for leftover in [&carry, &stderr_carry] {
            if !leftover.is_empty() {
                let _ = app.emit(
                    "ssh-output",
                    SshEvent {
                        session_id: reader_session.clone(),
                        data: String::from_utf8_lossy(leftover).into_owned(),
                        request_id: reader_request_id.clone(),
                    },
                );
            }
        }
        let _ = app.emit(
            "ssh-exit",
            SshEvent {
                session_id: reader_session.clone(),
                data: "SSH process ended.".to_string(),
                request_id: reader_request_id.clone(),
            },
        );
        crate::oplog::log(
            "INFO",
            "ssh_connect",
            "ended",
            &reader_label,
            "terminal",
            &serde_json::json!({"operationId": operation_id, "requestId": reader_request_id, "sessionId": reader_session, "durationMs": started.elapsed().as_millis()}).to_string(),
        );
        sessions().lock().await.remove(&reader_session);
    });

    Ok(session_id)
}

pub async fn write(session_id: String, data: String) -> Result<(), String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let byte_count = data.len();
    crate::oplog::log("DEBUG", "ssh_write", "started", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "byteCount": byte_count}).to_string());
    let sessions = sessions().lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "SSH session is not connected".to_string());
    let session = match session {
        Ok(session) => session,
        Err(error) => {
            crate::oplog::log("ERROR", "ssh_write", "failed", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "byteCount": byte_count, "durationMs": started.elapsed().as_millis(), "failureType": "missing_session", "error": error}).to_string());
            return Err(error);
        }
    };
    match session
        .write
        .data(data.into_bytes().as_slice())
        .await
    {
        Ok(()) => {
            crate::oplog::log("INFO", "ssh_write", "completed", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "byteCount": byte_count, "durationMs": started.elapsed().as_millis()}).to_string());
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            crate::oplog::log("ERROR", "ssh_write", "failed", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "byteCount": byte_count, "durationMs": started.elapsed().as_millis(), "failureType": "channel_write", "error": message}).to_string());
            Err(message)
        }
    }
}

pub async fn resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    crate::oplog::log("DEBUG", "ssh_resize", "started", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "cols": cols, "rows": rows}).to_string());
    if cols == 0 || rows == 0 {
        crate::oplog::log("ERROR", "ssh_resize", "failed", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "cols": cols, "rows": rows, "durationMs": started.elapsed().as_millis(), "failureType": "validation", "error": "SSH terminal size must be greater than zero"}).to_string());
        return Err("SSH terminal size must be greater than zero".to_string());
    }
    let sessions = sessions().lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "SSH session is not connected".to_string());
    let session = match session {
        Ok(session) => session,
        Err(error) => {
            crate::oplog::log("ERROR", "ssh_resize", "failed", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "cols": cols, "rows": rows, "durationMs": started.elapsed().as_millis(), "failureType": "missing_session", "error": error}).to_string());
            return Err(error);
        }
    };
    match session
        .write
        .window_change(cols as u32, rows as u32, 0, 0)
        .await
    {
        Ok(()) => {
            crate::oplog::log("INFO", "ssh_resize", "completed", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "cols": cols, "rows": rows, "durationMs": started.elapsed().as_millis()}).to_string());
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            crate::oplog::log("ERROR", "ssh_resize", "failed", "terminal", "", &serde_json::json!({"operationId": operation_id, "sessionId": session_id, "cols": cols, "rows": rows, "durationMs": started.elapsed().as_millis(), "failureType": "channel_resize", "error": message}).to_string());
            Err(message)
        }
    }
}

pub async fn disconnect(session_id: String) -> Result<(), String> {
    if let Some(session) = sessions().lock().await.remove(&session_id) {
        let _ = session.write.close().await;
        session.handle.disconnect_all().await;
        crate::oplog::log(
            "INFO",
            "ssh_connect",
            "disconnected",
            "terminal",
            "",
            &format!("Shell session {session_id} was disconnected by the app."),
        );
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
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let label = profile_label(&profile);
    crate::oplog::log("DEBUG", "ssh_install_key", "started", &label, "authorized_keys", &serde_json::json!({"operationId": operation_id}).to_string());
    let result = install_key_inner(profile).await;
    match &result {
        Ok(path) => crate::oplog::log("INFO", "ssh_install_key", "completed", &label, path, &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis()}).to_string()),
        Err(error) => crate::oplog::log("ERROR", "ssh_install_key", "failed", &label, "authorized_keys", &serde_json::json!({"operationId": operation_id, "durationMs": started.elapsed().as_millis(), "failureType": "install", "error": error}).to_string()),
    }
    result
}

async fn install_key_inner(profile: SshProfile) -> Result<String, String> {
    validate_profile(&profile)?;
    let label = profile_label(&profile);
    crate::oplog::log(
        "INFO",
        "ssh_install_key",
        "started",
        &label,
        "authorized_keys",
        "Installing a local public key on the remote host.",
    );
    let ssh_dir = crate::ssh_storage_dir()?;
    let key_path = profile
        .private_key_path
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| ssh_dir.join("id_ed25519"));
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

    let mut session = connect_transport(&profile).await?;
    let result = session
        .handle
        .authenticate_password(profile.username.clone(), stored_password)
        .await
        .map_err(|error| error.to_string())?;
    if !matches!(result, AuthResult::Success) {
        let message = "Password authentication failed while installing the SSH key.".to_string();
        crate::oplog::log(
            "ERROR",
            "ssh_install_key",
            "failed",
            &label,
            "authorized_keys",
            &message,
        );
        return Err(message);
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    let remote_command = "umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF -- \"$(cat)\" ~/.ssh/authorized_keys || cat >> ~/.ssh/authorized_keys".to_string();
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
            Some(ChannelMsg::ExitStatus {
                exit_status: status,
            }) => {
                exit_status = Some(status);
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    session.disconnect_all().await;

    match exit_status {
        Some(0) => {
            let message = format!(
                "SSH key installed for {}@{}.",
                profile.username, profile.host
            );
            crate::oplog::log(
                "INFO",
                "ssh_install_key",
                "completed",
                &label,
                "authorized_keys",
                &message,
            );
            Ok(message)
        }
        Some(code) => {
            let message = format!("Key installation command exited with status {code}.");
            crate::oplog::log(
                "ERROR",
                "ssh_install_key",
                "failed",
                &label,
                "authorized_keys",
                &message,
            );
            Err(message)
        }
        None => {
            let message = "Key installation did not complete.".to_string();
            crate::oplog::log(
                "ERROR",
                "ssh_install_key",
                "failed",
                &label,
                "authorized_keys",
                &message,
            );
            Err(message)
        }
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

pub fn save_rest_secret(entry_id: String, kind: String, value: String) -> Result<(), String> {
    secrets::save_rest_secret(&entry_id, &kind, &value)
}

pub fn load_rest_secret(entry_id: String, kind: String) -> Result<Option<String>, String> {
    secrets::load_rest_secret(&entry_id, &kind)
}

pub fn forget_rest_secret(entry_id: String, kind: String) -> Result<(), String> {
    secrets::forget_rest_secret(&entry_id, &kind)
}

pub fn save_proxmox_secret(entry_id: &str, kind: &str, value: &str) -> Result<(), String> {
    secrets::save_proxmox_secret(entry_id, kind, value)
}

pub fn load_proxmox_secret(entry_id: &str, kind: &str) -> Result<Option<String>, String> {
    secrets::load_proxmox_secret(entry_id, kind)
}

pub fn forget_proxmox_secret(entry_id: &str, kind: &str) -> Result<(), String> {
    secrets::forget_proxmox_secret(entry_id, kind)
}

#[cfg(test)]
mod transport_reachability_tests {
    use super::{check_transport_reachable, SshProfile};

    fn blank_profile() -> SshProfile {
        SshProfile {
            id: "test".to_string(),
            name: "".to_string(),
            host: "".to_string(),
            port: 22,
            username: "".to_string(),
            private_key_path: None,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            jump_private_key_path: None,
            jump_profile_id: None,
        }
    }

    #[tokio::test]
    async fn invalid_profile_is_reported_unreachable_without_attempting_a_connection() {
        // An empty host/username fails `validate_profile` -- this must be
        // rejected immediately (false), never attempt a real TCP/SSH
        // connect, and never hang waiting on the timeout.
        let reachable = check_transport_reachable(blank_profile(), 5000).await;
        assert!(!reachable);
    }

    #[tokio::test]
    async fn unreachable_target_reports_false_within_the_timeout() {
        let profile = SshProfile {
            host: "192.0.2.1".to_string(), // TEST-NET-1, never routable.
            username: "probe".to_string(),
            name: "probe".to_string(),
            ..blank_profile()
        };
        let reachable = check_transport_reachable(profile, 300).await;
        assert!(!reachable);
    }
}
