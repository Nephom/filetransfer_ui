// Pure-Rust TCP reachability probing.
//
// Deliberately implemented with `tokio::net::TcpStream` + `tokio::time::timeout`
// instead of shelling out to a platform ping/telnet/Test-NetConnection binary.
// The desktop client is expected to run on Windows most of the time, and
// Windows does not reliably ship a scriptable `ping`/`nc` equivalent (and ICMP
// is frequently filtered even when it does), so this performs a real TCP
// connect attempt (a SYN, from the OS's perspective) directly from the Rust
// process. This is the same "no dependency on OS-provided network tools"
// principle already used by `ssh/mod.rs` and `ssh/sftp.rs` (pure-Rust `russh`
// instead of shelling out to `ssh`/`scp`/`sftp`).

use std::time::Duration;

/// Returns `true` if a TCP connection to `host:port` can be established
/// within `timeout_ms` milliseconds, `false` otherwise (including on DNS
/// failure, connection refused, or timeout). Never returns an `Err` -- the
/// caller only cares about a yes/no reachability signal, not the failure
/// reason, since this is used purely to pick a transfer strategy.
pub async fn is_port_reachable(host: &str, port: u16, timeout_ms: u64) -> bool {
    let target = format!("{host}:{port}");
    let timeout = Duration::from_millis(timeout_ms.max(1));
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&target)).await {
        Ok(Ok(_stream)) => true,
        Ok(Err(_)) => false,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_port_reachable;

    #[tokio::test]
    async fn unreachable_port_reports_false_quickly() {
        // 192.0.2.0/24 is reserved (TEST-NET-1) and never routable, so this
        // reliably times out rather than actually connecting.
        let reachable = is_port_reachable("192.0.2.1", 9, 300).await;
        assert!(!reachable);
    }

    #[tokio::test]
    async fn loopback_listener_is_reported_reachable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind should succeed");
        let port = listener.local_addr().expect("local addr").port();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let reachable = is_port_reachable("127.0.0.1", port, 2000).await;
        assert!(reachable);
    }
}
