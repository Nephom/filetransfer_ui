// SFTP-backed remote directory browsing for an SSH Session entry. This is a
// separate SSH connection from the interactive terminal (it shares the same
// profile/credentials, but the terminal's shell channel and the file browser
// are independent so that browsing does not interfere with an active shell,
// and so the file browser can be opened before or after connecting a
// terminal tab for the same entry).

use super::{authenticate, default_config, ClientHandler, SshProfile};
use russh::client;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

struct SftpConnection {
    handle: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

static SFTP_SESSIONS: OnceLock<Arc<AsyncMutex<HashMap<String, SftpConnection>>>> = OnceLock::new();

fn sftp_sessions() -> &'static Arc<AsyncMutex<HashMap<String, SftpConnection>>> {
    SFTP_SESSIONS.get_or_init(|| Arc::new(AsyncMutex::new(HashMap::new())))
}

async fn open_connection(profile: &SshProfile) -> Result<SftpConnection, String> {
    let handler = ClientHandler {
        host: profile.host.clone(),
        port: profile.port,
    };
    let addr = format!("{}:{}", profile.host, profile.port);
    let mut handle = client::connect(default_config(), addr, handler)
        .await
        .map_err(|error| format!("Unable to connect: {error}"))?;
    authenticate(&mut handle, profile).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| error.to_string())?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| error.to_string())?;
    Ok(SftpConnection { handle, sftp })
}

/// Ensure an SFTP connection for this profile is open, reusing an existing
/// one when possible so repeated directory navigation does not pay the cost
/// of a fresh SSH handshake every time.
pub async fn ensure_connected(profile: &SshProfile) -> Result<(), String> {
    let mut sessions = sftp_sessions().lock().await;
    if let Some(existing) = sessions.get(&profile.id) {
        if !existing.handle.is_closed() {
            return Ok(());
        }
        sessions.remove(&profile.id);
    }
    let connection = open_connection(profile).await?;
    sessions.insert(profile.id.clone(), connection);
    Ok(())
}

pub async fn list_directory(profile: SshProfile, path: String) -> Result<crate::LocalDirectory, String> {
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;

    let remote_path = if path.trim().is_empty() {
        connection
            .sftp
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| ".".to_string())
    } else {
        path.clone()
    };

    let entries = connection
        .sftp
        .read_dir(&remote_path)
        .await
        .map_err(|error| error.to_string())?;

    let mut files = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let metadata = entry.metadata();
        let is_directory = metadata.is_dir();
        let size = metadata.size.unwrap_or(0);
        let modified = metadata
            .mtime
            .map(|seconds| (seconds as u128) * 1000)
            .unwrap_or(0);
        let child_path = format!("{}/{}", remote_path.trim_end_matches('/'), name);
        files.push(crate::LocalFile {
            name,
            path: child_path,
            is_directory,
            size,
            modified,
        });
    }
    files.sort_by(|left: &crate::LocalFile, right: &crate::LocalFile| {
        left.name.to_lowercase().cmp(&right.name.to_lowercase())
    });

    Ok(crate::LocalDirectory {
        path: remote_path,
        files,
    })
}

pub async fn disconnect(entry_id: String) -> Result<(), String> {
    if let Some(connection) = sftp_sessions().lock().await.remove(&entry_id) {
        let _ = connection.sftp.close().await;
        let _ = connection
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    Ok(())
}

/// Standard `scp`-style transfer primitives, restricted to LOCAL <-> SSH
/// REMOTE only (never the API Remote model). Whole-file read/write is used
/// rather than streaming, which is adequate for the config/log-sized files
/// this is intended for; large multi-gigabyte transfers should still go
/// through the API Remote upload/download paths instead.
pub async fn download_file(
    profile: SshProfile,
    remote_path: String,
    local_path: String,
) -> Result<String, String> {
    let local = std::path::Path::new(&local_path);
    if !local.is_absolute()
        || local
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Local destination path must be an absolute path without '..'".to_string());
    }
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    let data = connection
        .sftp
        .read(remote_path.clone())
        .await
        .map_err(|error| error.to_string())?;
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(local, data).map_err(|error| error.to_string())?;
    Ok(local.display().to_string())
}

pub async fn upload_file(
    profile: SshProfile,
    local_path: String,
    remote_path: String,
) -> Result<String, String> {
    let local = std::path::Path::new(&local_path);
    if !local.is_file() {
        return Err("Local source file does not exist".to_string());
    }
    let data = std::fs::read(local).map_err(|error| error.to_string())?;
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    connection
        .sftp
        .write(remote_path.clone(), &data)
        .await
        .map_err(|error| error.to_string())?;
    Ok(remote_path)
}
