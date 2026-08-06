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
    let mut handle = tokio::time::timeout(super::CONNECT_TIMEOUT, client::connect(default_config(), addr, handler))
        .await
        .map_err(|_| format!("Connection to {}:{} timed out.", profile.host, profile.port))?
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

    let remote_path = if path.trim().is_empty() || path.trim() == "." {
        connection
            .sftp
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| ".".to_string())
    } else if path.trim() == "/" {
        "/".to_string()
    } else if path.starts_with('/') {
        path.clone()
    } else {
        format!("/{path}")
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

/// Create a new (possibly nested) directory on the remote host. Existing
/// parent segments are created best-effort; an already-existing leaf
/// directory is not treated as an error.
pub async fn create_directory(profile: SshProfile, path: String) -> Result<(), String> {
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    let mut built = String::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        built = if built.is_empty() {
            segment.to_string()
        } else {
            format!("{built}/{segment}")
        };
        let _ = connection.sftp.create_dir(built.clone()).await;
    }
    match connection.sftp.metadata(path.clone()).await {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!("{path} exists and is not a directory")),
        Err(error) => Err(error.to_string()),
    }
}

/// Recursively delete a remote file or directory. There is no remote Trash,
/// so this operation cannot be undone -- callers must warn the user before
/// invoking it (see the desktop UI's delete confirmation).
pub async fn delete_path(profile: SshProfile, path: String, is_directory: bool) -> Result<(), String> {
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    delete_recursive(&connection.sftp, &path, is_directory).await
}

async fn delete_recursive(sftp: &SftpSession, path: &str, is_directory: bool) -> Result<(), String> {
    if !is_directory {
        return sftp.remove_file(path).await.map_err(|error| error.to_string());
    }
    let entries = sftp.read_dir(path).await.map_err(|error| error.to_string())?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child_path = format!("{}/{}", path.trim_end_matches('/'), name);
        let child_is_dir = entry.metadata().is_dir();
        Box::pin(delete_recursive(sftp, &child_path, child_is_dir)).await?;
    }
    sftp.remove_dir(path).await.map_err(|error| error.to_string())
}

/// Rename/move a remote path. Used both for plain renames and for drag-drop
/// moves within the same SSH host (cross-source moves between SSH and API
/// Remote are not attempted -- those are upload/download operations).
pub async fn rename_path(profile: SshProfile, old_path: String, new_path: String) -> Result<(), String> {
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    connection
        .sftp
        .rename(old_path, new_path)
        .await
        .map_err(|error| error.to_string())
}

/// Upload a local file or an entire local directory tree into
/// `remote_destination_folder`, recreating the source's own name as the top
/// segment (mirrors how the API Remote upload path lands files under the
/// destination folder).
pub async fn upload_path(
    profile: SshProfile,
    local_path: String,
    remote_destination_folder: String,
) -> Result<String, String> {
    let local = std::path::Path::new(&local_path);
    let metadata = std::fs::symlink_metadata(local).map_err(|error| error.to_string())?;
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    let destination_root = remote_destination_folder.trim_end_matches('/');

    if metadata.is_dir() {
        let (files, directories) = crate::collect_upload_paths(std::slice::from_ref(&local_path))?;
        for directory in &directories {
            let remote_dir = format!("{destination_root}/{directory}");
            let _ = connection.sftp.create_dir(remote_dir).await;
        }
        for (local_file, relative) in &files {
            let data = std::fs::read(local_file).map_err(|error| error.to_string())?;
            let remote_file = format!("{destination_root}/{relative}");
            connection
                .sftp
                .write(remote_file, &data)
                .await
                .map_err(|error| error.to_string())?;
        }
    } else if metadata.is_file() {
        let name = local
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid local file name".to_string())?;
        let data = std::fs::read(local).map_err(|error| error.to_string())?;
        let remote_file = format!("{destination_root}/{name}");
        connection
            .sftp
            .write(remote_file, &data)
            .await
            .map_err(|error| error.to_string())?;
    } else {
        return Err("Unsupported local upload source".to_string());
    }
    Ok(destination_root.to_string())
}

/// Download a remote file or an entire remote directory tree into
/// `local_destination_folder`, recreating the source's own name as the top
/// segment.
pub async fn download_path(
    profile: SshProfile,
    remote_path: String,
    is_directory: bool,
    local_destination_folder: String,
) -> Result<String, String> {
    let name = remote_path
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid remote path".to_string())?
        .to_string();
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    let destination_root = std::path::Path::new(&local_destination_folder);
    if is_directory {
        download_recursive(&connection.sftp, &remote_path, destination_root, &name).await?;
    } else {
        let data = connection
            .sftp
            .read(remote_path.clone())
            .await
            .map_err(|error| error.to_string())?;
        let local_file = destination_root.join(&name);
        if let Some(parent) = local_file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&local_file, data).map_err(|error| error.to_string())?;
    }
    Ok(destination_root.join(&name).display().to_string())
}

async fn download_recursive(
    sftp: &SftpSession,
    remote_path: &str,
    destination_root: &std::path::Path,
    relative_prefix: &str,
) -> Result<(), String> {
    let local_dir = destination_root.join(relative_prefix);
    std::fs::create_dir_all(&local_dir).map_err(|error| error.to_string())?;
    let entries = sftp.read_dir(remote_path).await.map_err(|error| error.to_string())?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), name);
        let child_relative = format!("{relative_prefix}/{name}");
        if entry.metadata().is_dir() {
            Box::pin(download_recursive(sftp, &child_remote, destination_root, &child_relative)).await?;
        } else {
            let data = sftp.read(child_remote).await.map_err(|error| error.to_string())?;
            let local_file = destination_root.join(&child_relative);
            if let Some(parent) = local_file.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(&local_file, data).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
