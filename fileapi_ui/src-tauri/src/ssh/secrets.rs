// Password storage for SSH entries.
//
// Preferred backend: the OS-native credential store (macOS Keychain, Windows
// Credential Manager, Linux Secret Service via keyring::Entry). This keeps
// SSH passwords out of the ordinary session/workspace JSON that the frontend
// persists to localStorage.
//
// There is deliberately no plaintext or Base64 fallback. If the native
// credential store is unavailable, saving/loading the secret fails explicitly
// instead of silently weakening the protection of credentials.
//
// One consistent service name for every credential this app stores (SSH
// passwords, REST secrets, Proxmox secrets -- all keyed by prefix under
// this same service, see save_rest_secret/save_proxmox_secret below), so
// Keychain Access shows one recognizable name instead of a mix of legacy
// identifiers. No backward-compat migration for entries saved under any
// earlier service name -- this app has no shipped users yet.
const SERVICE_NAME: &str = "com.ndfnet.nFterm";
fn keyring_entry(entry_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE_NAME, entry_id)
        .map_err(|error| format!("Unable to access the OS credential store: {error}"))
}

pub fn save_password(entry_id: &str, password: &str) -> Result<(), String> {
    keyring_entry(entry_id)?
        .set_password(password)
        .map_err(|error| format!("Unable to save credential in the OS credential store: {error}"))
}

pub fn load_password(entry_id: &str) -> Result<Option<String>, String> {
    match keyring_entry(entry_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Unable to read credential from the OS credential store: {error}"
        )),
    }
}

pub fn forget_password(entry_id: &str) -> Result<(), String> {
    match keyring_entry(entry_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Unable to remove credential from the OS credential store: {error}"
        )),
    }
}

pub fn save_rest_secret(entry_id: &str, kind: &str, value: &str) -> Result<(), String> {
    let key = format!("rest:{entry_id}:{kind}");
    keyring_entry(&key)?
        .set_password(value)
        .map_err(|error| format!("Unable to save credential in the OS credential store: {error}"))
}

pub fn load_rest_secret(entry_id: &str, kind: &str) -> Result<Option<String>, String> {
    let key = format!("rest:{entry_id}:{kind}");
    match keyring_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Unable to read credential from the OS credential store: {error}"
        )),
    }
}

pub fn forget_rest_secret(entry_id: &str, kind: &str) -> Result<(), String> {
    let key = format!("rest:{entry_id}:{kind}");
    match keyring_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Unable to remove credential from the OS credential store: {error}"
        )),
    }
}

pub fn save_proxmox_secret(entry_id: &str, kind: &str, value: &str) -> Result<(), String> {
    save_rest_secret(&format!("proxmox:{entry_id}"), kind, value)
}

pub fn load_proxmox_secret(entry_id: &str, kind: &str) -> Result<Option<String>, String> {
    load_rest_secret(&format!("proxmox:{entry_id}"), kind)
}

pub fn forget_proxmox_secret(entry_id: &str, kind: &str) -> Result<(), String> {
    forget_rest_secret(&format!("proxmox:{entry_id}"), kind)
}
