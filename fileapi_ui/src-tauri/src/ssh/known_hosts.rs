// Host key (server identity) verification against the standard `~/.ssh/known_hosts`
// file, using the same TOFU (trust-on-first-use) semantics as OpenSSH's
// `StrictHostKeyChecking=accept-new`: a host never seen before is learned and
// trusted; a host whose recorded key no longer matches is rejected outright
// because that indicates a possible man-in-the-middle attack.
//
// This does not touch user authentication keys (private/public key pairs used
// to prove the *client's* identity) — that is handled separately in `keys.rs`.

use russh::keys::PublicKey;
use std::path::PathBuf;

pub enum HostKeyDecision {
    /// The presented key matches the one already recorded for this host.
    TrustedExisting,
    /// The host had no recorded key; it has now been learned and trusted.
    TrustedNew,
    /// The host has a recorded key that does not match the one presented now.
    Mismatch,
}

fn known_hosts_path() -> Result<PathBuf, String> {
    let home = crate::local_home()?;
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).map_err(|error| error.to_string())?;
    Ok(ssh_dir.join("known_hosts"))
}

/// Verify (and, if necessary, learn) a server's host key. Mirrors OpenSSH's
/// `accept-new` behaviour: unseen hosts are recorded automatically, but a
/// changed key for a previously known host is always rejected.
pub fn verify_and_learn(host: &str, port: u16, key: &PublicKey) -> Result<HostKeyDecision, String> {
    let path = known_hosts_path()?;

    let recorded = russh::keys::known_hosts::known_host_keys_path(host, port, &path)
        .map_err(|error| error.to_string())?;

    match recorded {
        keys if keys.is_empty() => {
            russh::keys::known_hosts::learn_known_hosts_path(host, port, key, &path)
                .map_err(|error| error.to_string())?;
            Ok(HostKeyDecision::TrustedNew)
        }
        keys if keys.iter().any(|(_, known)| known == key) => Ok(HostKeyDecision::TrustedExisting),
        _ => Ok(HostKeyDecision::Mismatch),
    }
}
