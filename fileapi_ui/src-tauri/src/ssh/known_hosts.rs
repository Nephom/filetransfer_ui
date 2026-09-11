// Host key (server identity) verification against the app's SSH storage
// directory (`~/.ssh/known_hosts` on Unix, or the portable Windows directory)
// file, using the same TOFU (trust-on-first-use) semantics as OpenSSH's
// `StrictHostKeyChecking=accept-new`: a host never seen before is learned and
// trusted. A changed key is replaced for the exact host and port after it is
// recorded in the operation log.
//
// This does not touch user authentication keys (private/public key pairs used
// to prove the *client's* identity) — that is handled separately in `keys.rs`.

use russh::keys::PublicKey;
use std::fs;
use std::path::PathBuf;

pub enum HostKeyDecision {
    /// The presented key matches the one already recorded for this host.
    TrustedExisting,
    /// The host had no recorded key; it has now been learned and trusted.
    TrustedNew,
    /// The host had a recorded key that was replaced by the presented key.
    Replaced,
}

fn known_hosts_path() -> Result<PathBuf, String> {
    let ssh_dir = crate::ssh_storage_dir()?;
    Ok(ssh_dir.join("known_hosts"))
}

/// Verify (and, if necessary, learn) a server's host key. Mirrors OpenSSH's
/// `accept-new` behaviour for new hosts, while replacing a changed key for
/// this exact host and port so a rebuilt server can reconnect.
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
        keys => {
            let old_lines: Vec<usize> = keys.into_iter().map(|(line, _)| line).collect();
            replace_known_host_lines(&path, &old_lines)?;
            russh::keys::known_hosts::learn_known_hosts_path(host, port, key, &path)
                .map_err(|error| error.to_string())?;
            Ok(HostKeyDecision::Replaced)
        }
    }
}

fn replace_known_host_lines(path: &std::path::Path, old_lines: &[usize]) -> Result<(), String> {
    let contents = fs::read_to_string(path).map_err(|error| {
        format!(
            "Unable to read SSH known_hosts at {}: {error}",
            path.display()
        )
    })?;
    let mut filtered = String::new();
    for (index, line) in contents.lines().enumerate() {
        if !old_lines.contains(&(index + 1)) {
            filtered.push_str(line);
            filtered.push('\n');
        }
    }
    fs::write(path, filtered).map_err(|error| {
        format!(
            "Unable to replace SSH known_hosts at {}: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::replace_known_host_lines;
    use std::fs;

    #[test]
    fn removes_only_the_recorded_conflicting_lines() {
        let directory =
            std::env::temp_dir().join(format!("fileapi-known-hosts-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("known_hosts");
        fs::write(&path, "keep-a\nremove\nkeep-b\n").unwrap();

        replace_known_host_lines(&path, &[2]).unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "keep-a\nkeep-b\n");
        fs::remove_dir_all(directory).unwrap();
    }
}
