// SFTP-backed remote directory browsing for an SSH Session entry. This is a
// separate SSH connection from the interactive terminal (it shares the same
// profile/credentials, but the terminal's shell channel and the file browser
// are independent so that browsing does not interfere with an active shell,
// and so the file browser can be opened before or after connecting a
// terminal tab for the same entry).

use super::{authenticate, default_config, ClientHandler, SshProfile};
use russh::client;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

/// Write `data` to `path` on the remote host, creating the file if it does
/// not already exist (and truncating it if it does).
///
/// `SftpSession::write()` opens the target with `OpenFlags::WRITE` only --
/// no `CREATE` flag -- so it requires the remote file to already exist and
/// fails every new-file upload with "No such file". `SftpSession::create()`
/// opens with `CREATE | TRUNCATE | WRITE`, which is what every upload path
/// here actually needs.
async fn write_remote_file(sftp: &SftpSession, path: String, data: &[u8]) -> Result<(), String> {
    let mut file = sftp.create(path).await.map_err(|error| error.to_string())?;
    file.write_all(data)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

struct SftpConnection {
    handle: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

static SFTP_SESSIONS: OnceLock<Arc<AsyncMutex<HashMap<String, SftpConnection>>>> = OnceLock::new();

fn sftp_sessions() -> &'static Arc<AsyncMutex<HashMap<String, SftpConnection>>> {
    SFTP_SESSIONS.get_or_init(|| Arc::new(AsyncMutex::new(HashMap::new())))
}

async fn open_connection(profile: &SshProfile) -> Result<SftpConnection, String> {
    let label = super::profile_label(profile);
    crate::oplog::log(
        "DEBUG",
        "sftp_connect",
        "started",
        &label,
        "sftp",
        "Opening a new SFTP connection.",
    );
    let handler = ClientHandler {
        host: profile.host.clone(),
        port: profile.port,
    };
    let addr = format!("{}:{}", profile.host, profile.port);
    let mut handle = match tokio::time::timeout(
        super::CONNECT_TIMEOUT,
        client::connect(default_config(), addr, handler),
    )
    .await
    {
        Ok(Ok(handle)) => handle,
        Ok(Err(error)) => {
            let message = format!("Unable to connect: {error}");
            crate::oplog::log("ERROR", "sftp_connect", "failed", &label, "sftp", &message);
            return Err(message);
        }
        Err(_) => {
            let message = format!("Connection to {}:{} timed out.", profile.host, profile.port);
            crate::oplog::log("ERROR", "sftp_connect", "failed", &label, "sftp", &message);
            return Err(message);
        }
    };
    if let Err(error) = authenticate(&mut handle, profile).await {
        crate::oplog::log(
            "ERROR",
            "sftp_connect",
            "failed",
            &label,
            "sftp",
            &format!("Authentication failed: {error}"),
        );
        return Err(error);
    }
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
    crate::oplog::log(
        "INFO",
        "sftp_connect",
        "connected",
        &label,
        "sftp",
        "SFTP session established.",
    );
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

pub async fn list_directory(
    profile: SshProfile,
    path: String,
) -> Result<crate::LocalDirectory, String> {
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
        crate::oplog::log(
            "INFO",
            "sftp_connect",
            "disconnected",
            "sftp",
            "",
            &format!("SFTP session for entry {entry_id} was disconnected."),
        );
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
    write_remote_file(&connection.sftp, remote_path.clone(), &data).await?;
    Ok(remote_path)
}

/// Create a new (possibly nested) directory on the remote host. Existing
/// parent segments are created best-effort; an already-existing leaf
/// directory is not treated as an error.
pub async fn create_directory(profile: SshProfile, path: String) -> Result<(), String> {
    let label = super::profile_label(&profile);
    crate::oplog::log(
        "DEBUG",
        "create_folder",
        "started",
        &format!("SSH: {label}"),
        &path,
        "Creating a remote folder over SFTP.",
    );
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    // Absolute paths must stay absolute while being rebuilt segment by
    // segment -- losing the leading '/' here silently creates the folder
    // relative to the SFTP session's default directory instead, so the
    // later `metadata(&path)` check on the (still-absolute) original path
    // reports "No such file" even though *a* directory was created.
    let is_absolute = path.starts_with('/');
    let mut built = String::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        built = if built.is_empty() {
            if is_absolute {
                format!("/{segment}")
            } else {
                segment.to_string()
            }
        } else {
            format!("{built}/{segment}")
        };
        let _ = connection.sftp.create_dir(built.clone()).await;
    }
    match connection.sftp.metadata(path.clone()).await {
        Ok(metadata) if metadata.is_dir() => {
            crate::oplog::log(
                "INFO",
                "create_folder",
                "completed",
                &format!("SSH: {label}"),
                &path,
                "Remote folder created.",
            );
            Ok(())
        }

        Ok(_) => {
            let message = format!("{path} exists and is not a directory");
            crate::oplog::log(
                "ERROR",
                "create_folder",
                "failed",
                &format!("SSH: {label}"),
                &path,
                &message,
            );
            Err(message)
        }
        Err(error) => {
            let message = error.to_string();
            crate::oplog::log(
                "ERROR",
                "create_folder",
                "failed",
                &format!("SSH: {label}"),
                &path,
                &message,
            );
            Err(message)
        }
    }
}

/// Recursively delete a remote file or directory. There is no remote Trash,
/// so this operation cannot be undone -- callers must warn the user before
/// invoking it (see the desktop UI's delete confirmation).
pub async fn delete_path(
    profile: SshProfile,
    path: String,
    is_directory: bool,
) -> Result<(), String> {
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    delete_recursive(&connection.sftp, &path, is_directory).await
}

async fn delete_recursive(
    sftp: &SftpSession,
    path: &str,
    is_directory: bool,
) -> Result<(), String> {
    if !is_directory {
        return sftp
            .remove_file(path)
            .await
            .map_err(|error| error.to_string());
    }
    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|error| error.to_string())?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child_path = format!("{}/{}", path.trim_end_matches('/'), name);
        let child_is_dir = entry.metadata().is_dir();
        Box::pin(delete_recursive(sftp, &child_path, child_is_dir)).await?;
    }
    sftp.remove_dir(path)
        .await
        .map_err(|error| error.to_string())
}

/// Rename/move a remote path. Used both for plain renames and for drag-drop
/// moves within the same SSH host (cross-source moves between SSH and API
/// Remote are not attempted -- those are upload/download operations).
pub async fn rename_path(
    profile: SshProfile,
    old_path: String,
    new_path: String,
) -> Result<String, String> {
    let label = super::profile_label(&profile);
    crate::oplog::log(
        "DEBUG",
        "rename",
        "started",
        &format!("SSH: {label}:{old_path}"),
        &new_path,
        "Renaming/moving a remote path over SFTP.",
    );
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;
    let mut final_path = new_path.clone();
    if final_path != old_path && connection.sftp.metadata(final_path.clone()).await.is_ok() {
        let name = final_path
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Invalid remote path".to_string())?
            .to_string();
        let parent = final_path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("")
            .to_string();
        let mut attempt = 1;
        loop {
            let candidate_name = crate::dedupe_candidate_name(&name, attempt);
            let candidate = if parent.is_empty() {
                format!("/{candidate_name}")
            } else {
                format!("{parent}/{candidate_name}")
            };
            if connection.sftp.metadata(candidate.clone()).await.is_err() {
                final_path = candidate;
                break;
            }
            attempt += 1;
        }
    }
    let result = connection
        .sftp
        .rename(old_path.clone(), final_path.clone())
        .await
        .map_err(|error| error.to_string());
    match &result {
        Ok(()) => crate::oplog::log(
            "INFO",
            "rename",
            "completed",
            &format!("SSH: {label}:{old_path}"),
            &final_path,
            "Remote rename/move completed.",
        ),
        Err(error) => crate::oplog::log(
            "ERROR",
            "rename",
            "failed",
            &format!("SSH: {label}:{old_path}"),
            &final_path,
            error,
        ),
    }
    result.map(|()| final_path)
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
    let destination_root = connection
        .sftp
        .canonicalize(&remote_destination_folder)
        .await
        .map_err(|error| {
            format!("Unable to resolve remote upload folder {remote_destination_folder:?}: {error}")
        })?;
    let remote_path = |name: &str| {
        if destination_root == "/" {
            format!("/{name}")
        } else {
            format!("{}/{name}", destination_root.trim_end_matches('/'))
        }
    };

    // Collision-avoidance is applied to the top-level name only (the file
    // itself, or the top folder of a directory upload) -- never by
    // prompting the user -- so an upload never silently overwrites an
    // unrelated remote file/folder that happens to share its name.
    let dedupe_top_level_name = |initial_name: String| async {
        let mut candidate_name = initial_name;
        let mut attempt = 1;
        loop {
            if connection
                .sftp
                .metadata(remote_path(&candidate_name))
                .await
                .is_err()
            {
                return candidate_name;
            }
            candidate_name = crate::dedupe_candidate_name(&candidate_name, attempt);
            attempt += 1;
        }
    };

    if metadata.is_dir() {
        let top_name = local
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid local directory name".to_string())?
            .to_string();
        let final_top_name = dedupe_top_level_name(top_name.clone()).await;
        let (files, directories) = crate::collect_upload_paths(std::slice::from_ref(&local_path))?;
        for directory in &directories {
            let relative = if directory == &top_name {
                final_top_name.clone()
            } else if let Some(rest) = directory.strip_prefix(&format!("{top_name}/")) {
                format!("{final_top_name}/{rest}")
            } else {
                directory.clone()
            };
            let remote_dir = remote_path(&relative);
            if connection.sftp.metadata(remote_dir.clone()).await.is_err() {
                connection
                    .sftp
                    .create_dir(remote_dir.clone())
                    .await
                    .map_err(|error| {
                        format!("Unable to create remote folder {remote_dir:?}: {error}")
                    })?;
            }
        }
        for (local_file, relative) in &files {
            let relative = if relative == &top_name {
                final_top_name.clone()
            } else if let Some(rest) = relative.strip_prefix(&format!("{top_name}/")) {
                format!("{final_top_name}/{rest}")
            } else {
                relative.clone()
            };
            let data = std::fs::read(local_file).map_err(|error| error.to_string())?;
            let remote_file = remote_path(&relative);
            write_remote_file(&connection.sftp, remote_file, &data).await?;
        }
    } else if metadata.is_file() {
        let name = local
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid local file name".to_string())?
            .to_string();
        let final_name = dedupe_top_level_name(name).await;
        let data = std::fs::read(local).map_err(|error| error.to_string())?;
        let remote_file = remote_path(&final_name);
        write_remote_file(&connection.sftp, remote_file, &data).await?;
    } else {
        return Err("Unsupported local upload source".to_string());
    }
    Ok(destination_root)
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
    // Collision-avoidance on the top-level name only, mirroring
    // `upload_path` -- never by prompting the user -- so a download never
    // silently overwrites an unrelated local file/folder of the same name.
    let mut name = name;
    let mut attempt = 1;
    while destination_root.join(&name).exists() {
        name = crate::dedupe_candidate_name(&name, attempt);
        attempt += 1;
    }
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
    let entries = sftp
        .read_dir(remote_path)
        .await
        .map_err(|error| error.to_string())?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), name);
        let child_relative = format!("{relative_prefix}/{name}");
        if entry.metadata().is_dir() {
            Box::pin(download_recursive(
                sftp,
                &child_remote,
                destination_root,
                &child_relative,
            ))
            .await?;
        } else {
            let data = sftp
                .read(child_remote)
                .await
                .map_err(|error| error.to_string())?;
            let local_file = destination_root.join(&child_relative);
            if let Some(parent) = local_file.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(&local_file, data).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Single-quote a value for safe use as one argument in a POSIX shell
/// command line (handles embedded `'` by closing/reopening the quote).
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Run `command` on the remote host over a fresh exec channel on the same
/// already-authenticated connection (no second handshake), returning its
/// exit status and anything written to stderr.
async fn exec_command(
    handle: &client::Handle<ClientHandler>,
    command: &str,
) -> Result<(Option<u32>, String), String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut exit_status: Option<u32> = None;
    let mut stderr_text = String::new();
    let mut channel = channel;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExitStatus {
                exit_status: status,
            }) => exit_status = Some(status),
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                stderr_text.push_str(&String::from_utf8_lossy(&data));
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok((exit_status, stderr_text))
}

/// Compress `paths` (each an absolute remote path, all siblings inside
/// `destination_folder`) into a new `<archive_name>.zip` inside
/// `destination_folder`, via a remote `zip` command over an exec channel --
/// this never has to download and re-upload the content. Collision
/// avoidance auto-appends "_(n)" the same way local compression does; it
/// never prompts the user.
pub async fn compress_paths(
    profile: SshProfile,
    paths: Vec<String>,
    destination_folder: String,
    archive_name: String,
) -> Result<String, String> {
    let label = super::profile_label(&profile);
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;

    let base_name = crate::sanitize_archive_name(if archive_name.trim().is_empty() {
        "Archive"
    } else {
        archive_name.trim()
    });
    let zip_name = if base_name.to_lowercase().ends_with(".zip") {
        base_name
    } else {
        format!("{base_name}.zip")
    };
    let dest_path_for = |name: &str| {
        if destination_folder == "/" {
            format!("/{name}")
        } else {
            format!("{}/{name}", destination_folder.trim_end_matches('/'))
        }
    };
    let mut final_name = zip_name.clone();
    let mut attempt = 1;
    while connection
        .sftp
        .metadata(dest_path_for(&final_name))
        .await
        .is_ok()
    {
        final_name = crate::dedupe_candidate_name(&zip_name, attempt);
        attempt += 1;
    }

    let relative_names = paths
        .iter()
        .map(|item| {
            item.rsplit('/')
                .next()
                .filter(|value| !value.is_empty())
                .map(shell_quote)
                .ok_or_else(|| "Invalid remote path".to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let remote_command = format!(
        "cd {} && zip -r -- {} {}",
        shell_quote(&destination_folder),
        shell_quote(&final_name),
        relative_names.join(" "),
    );
    crate::oplog::log(
        "DEBUG",
        "compress",
        "started",
        &format!("SSH: {label}:{destination_folder}"),
        &final_name,
        "Compressing remote item(s) with zip.",
    );
    let (exit_status, stderr) = exec_command(&connection.handle, &remote_command).await?;
    if exit_status != Some(0) {
        let message = format!(
            "Remote zip command failed (exit {}). Is 'zip' installed on the remote host? {}",
            exit_status
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim(),
        );
        crate::oplog::log(
            "ERROR",
            "compress",
            "failed",
            &format!("SSH: {label}:{destination_folder}"),
            &final_name,
            &message,
        );
        return Err(message);
    }
    crate::oplog::log(
        "INFO",
        "compress",
        "completed",
        &format!("SSH: {label}:{destination_folder}"),
        &final_name,
        "Remote compression completed.",
    );
    Ok(final_name)
}

/// Extract a remote `.zip` archive into a new deduped subfolder of
/// `destination_folder` via a remote `unzip` command over an exec channel.
pub async fn extract_archive(
    profile: SshProfile,
    archive_path: String,
    destination_folder: String,
) -> Result<String, String> {
    let label = super::profile_label(&profile);
    ensure_connected(&profile).await?;
    let sessions = sftp_sessions().lock().await;
    let connection = sessions
        .get(&profile.id)
        .ok_or_else(|| "SFTP session is not connected".to_string())?;

    let archive_name = archive_path
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid remote path".to_string())?;
    let stem = archive_name
        .strip_suffix(".zip")
        .or_else(|| archive_name.strip_suffix(".ZIP"))
        .unwrap_or(archive_name)
        .to_string();
    let dest_path_for = |name: &str| {
        if destination_folder == "/" {
            format!("/{name}")
        } else {
            format!("{}/{name}", destination_folder.trim_end_matches('/'))
        }
    };
    let mut final_name = stem.clone();
    let mut attempt = 1;
    while connection
        .sftp
        .metadata(dest_path_for(&final_name))
        .await
        .is_ok()
    {
        final_name = crate::dedupe_candidate_name(&stem, attempt);
        attempt += 1;
    }

    let remote_command = format!(
        "mkdir -p {} && cd {} && unzip -o -q {}",
        shell_quote(&dest_path_for(&final_name)),
        shell_quote(&dest_path_for(&final_name)),
        shell_quote(&archive_path),
    );
    crate::oplog::log(
        "DEBUG",
        "extract",
        "started",
        &format!("SSH: {label}:{archive_path}"),
        &final_name,
        "Extracting remote archive with unzip.",
    );
    let (exit_status, stderr) = exec_command(&connection.handle, &remote_command).await?;
    if exit_status != Some(0) {
        let message =
            format!(
            "Remote unzip command failed (exit {}). Is 'unzip' installed on the remote host? {}",
            exit_status.map(|code| code.to_string()).unwrap_or_else(|| "unknown".to_string()),
            stderr.trim(),
        );
        crate::oplog::log(
            "ERROR",
            "extract",
            "failed",
            &format!("SSH: {label}:{archive_path}"),
            &final_name,
            &message,
        );
        return Err(message);
    }
    crate::oplog::log(
        "INFO",
        "extract",
        "completed",
        &format!("SSH: {label}:{archive_path}"),
        &final_name,
        "Remote extraction completed.",
    );
    Ok(final_name)
}
