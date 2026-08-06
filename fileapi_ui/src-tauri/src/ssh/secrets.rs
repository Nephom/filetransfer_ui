// Password storage for SSH entries.
//
// Preferred backend: the OS-native credential store (macOS Keychain, Windows
// Credential Manager, Linux Secret Service via keyring::Entry). This keeps
// SSH passwords out of the ordinary session/workspace JSON that the frontend
// persists to localStorage.
//
// Fallback backend: if no native credential store is available (e.g. a
// headless Linux box with no Secret Service daemon running), we fall back to
// a small standalone file under the app's data directory. This file is
// intentionally kept separate from the session registry so it never gets
// synced/exported along with ordinary session data, and its permissions are
// restricted to the current user where the platform supports it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const SERVICE_NAME: &str = "com.nephom.filetransfer.ssh";

#[derive(Serialize, Deserialize, Default)]
struct SecretsFile {
    // entry_id -> base64-encoded password. This is obfuscation, not
    // encryption: anyone with filesystem access to this file can decode it.
    // That is an accepted tradeoff for the fallback path only.
    entries: HashMap<String, String>,
}

fn secrets_file_path() -> Result<PathBuf, String> {
    Ok(crate::operation_storage_directory()?.join("ssh-secrets.json"))
}

fn read_secrets_file() -> Result<SecretsFile, String> {
    let path = secrets_file_path()?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(serde_json::from_str(&contents).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SecretsFile::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_secrets_file(file: &SecretsFile) -> Result<(), String> {
    let path = secrets_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let contents = serde_json::to_string_pretty(file).map_err(|error| error.to_string())?;
    std::fs::write(&path, contents).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, permissions);
        }
    }
    Ok(())
}

fn keyring_entry(entry_id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE_NAME, entry_id).ok()
}

pub fn save_password(entry_id: &str, password: &str) -> Result<(), String> {
    if let Some(entry) = keyring_entry(entry_id) {
        if entry.set_password(password).is_ok() {
            // Keep the fallback file free of any stale copy of a secret that
            // now lives in the native credential store.
            let mut file = read_secrets_file().unwrap_or_default();
            if file.entries.remove(entry_id).is_some() {
                let _ = write_secrets_file(&file);
            }
            return Ok(());
        }
    }
    let mut file = read_secrets_file()?;
    file.entries
        .insert(entry_id.to_string(), base64_encode(password));
    write_secrets_file(&file)
}

pub fn load_password(entry_id: &str) -> Result<Option<String>, String> {
    if let Some(entry) = keyring_entry(entry_id) {
        match entry.get_password() {
            Ok(password) => return Ok(Some(password)),
            Err(keyring::Error::NoEntry) => {}
            Err(_) => {}
        }
    }
    let file = read_secrets_file()?;
    Ok(file
        .entries
        .get(entry_id)
        .and_then(|encoded| base64_decode(encoded)))
}

pub fn forget_password(entry_id: &str) -> Result<(), String> {
    if let Some(entry) = keyring_entry(entry_id) {
        let _ = entry.delete_credential();
    }
    let mut file = read_secrets_file()?;
    if file.entries.remove(entry_id).is_some() {
        write_secrets_file(&file)?;
    }
    Ok(())
}

fn base64_encode(value: &str) -> String {
    use std::fmt::Write;
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = value.as_bytes();
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let triple = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        let indices = [
            (triple >> 18) & 0x3f,
            (triple >> 12) & 0x3f,
            (triple >> 6) & 0x3f,
            triple & 0x3f,
        ];
        for (index, value) in indices.iter().enumerate() {
            if index == 2 && chunk.len() < 2 {
                let _ = write!(output, "=");
            } else if index == 3 && chunk.len() < 3 {
                let _ = write!(output, "=");
            } else {
                output.push(ALPHABET[*value as usize] as char);
            }
        }
    }
    output
}

fn base64_decode(value: &str) -> Option<String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for character in value.chars() {
        if character == '=' {
            break;
        }
        let index = ALPHABET.iter().position(|candidate| *candidate == character as u8)?;
        buffer = (buffer << 6) | index as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    String::from_utf8(bytes).ok()
}
