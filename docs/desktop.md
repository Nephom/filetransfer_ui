# nFterm Desktop Architecture

This document describes the supported architecture of the nFterm 3.4.0
desktop client. It is an implementation contract for maintainers, not a local
development runbook.

## Runtime Boundaries

nFterm is a Tauri v2 application with a React frontend and a Rust command
backend. The frontend owns presentation, selection, queue state, and user
confirmation. Rust owns network requests that require native TLS behavior,
local filesystem access, SSH/SFTP, archive I/O, and Proxmox relay sockets.

The WebUI and desktop client use the same server API contract, but they do not
share browser storage, transfer executors, or local filesystem permissions.

## Authentication And Secrets

The API client collects a host and HTTPS port separately and uses HTTPS for the
server connection. TLS verification is enabled by default. A user may
explicitly enable the per-entry TLS bypass for a trusted private endpoint.

API bearer tokens are process-lifetime state and are not persisted in WebView
local storage. Workspace definitions contain non-secret connection metadata;
SSH, REST, and Proxmox credentials are stored through the OS credential store.
If the native credential store is unavailable, the operation fails rather than
writing a reversible plaintext or Base64 fallback.

SSH host verification uses a known-hosts file with TOFU semantics: a new host
key is recorded, an existing matching key is accepted, and a changed key is
rejected. Private key files remain on the local machine.

## Local Filesystem Boundary

The normal local root is the current user's HOME. Every command that reads,
writes, renames, deletes, extracts, or stages a local path validates the path
in Rust; frontend path strings are not trusted as authorization.

For writes below a destination directory, nFterm creates missing parents and
then canonicalizes the parent before opening the file. The canonical parent
must remain below the selected root in a non-elevated process. This protects
against traversal, symlink, and Windows junction/reparse-point escapes.

Downloads use collision-safe names and write through a newly-created file.
Network, cancellation, and write failures remove the partial output. Archive
creation streams file contents rather than loading an entire file into memory.

An elevated process may browse real filesystem roots. Elevation is detected by
the Rust process and is never accepted from a frontend boolean.

## Transfer Queue

The queue is a client-side state machine. API and SSH/SFTP executors remain
separate, while both use normalized status, progress, retry, cancellation, and
failure categories.

Queue metadata is persisted for visibility across application restarts. Active
items from a previous process are restored as `needs_user_action`; they are not
reported as completed and are not silently resumed. Sensitive request headers,
bodies, and download URLs are excluded from persistence. A restored API
download that lacks its runtime request credentials must be added again.

Automatic retry is bounded and limited to network, timeout, and transient
server failures. Authentication, permission, conflict, missing source,
changed source, invalid path, and unavailable destination errors require an
explicit user decision.

## SSH And SFTP

The terminal and SFTP browser use separate authenticated SSH connections. A
connection has a bounded connection/authentication attempt, but an established
interactive session remains available until the user disconnects or the
server closes it.

SFTP transfers support directory browsing, create, rename, delete, upload,
download, archive, extraction, and native drag staging. File contents are
transferred in bounded operations appropriate to the selected executor; local
archive creation uses streaming I/O. Remote `zip` and `unzip` availability is
reported as an actionable transfer error when unavailable.

## Proxmox VNC

Proxmox credentials are submitted to the Proxmox ticket endpoint and retained
in the OS credential store when the user chooses to save them. The desktop
client keeps the resulting authenticated session in process memory.

The VNC flow is:

1. Authenticate against the configured HTTPS Proxmox base URL.
2. Discover permitted QEMU/LXC guests.
3. Request a VNC proxy ticket for the selected node and VM.
4. Create a loopback WebSocket relay for noVNC.
5. Validate the exact `/vnc/<connection-id>` path and one-time relay token.
6. Relay the browser WebSocket to the Proxmox WSS endpoint with the ticket.

The relay retains the user's Proxmox authentication flow; the local token is
an additional loopback connection boundary, not a replacement for Proxmox
credentials. Switching entries, disconnecting, or unmounting the workspace
cancels a pending relay. There is no fixed idle timeout while the user remains
on the same entry.

### VNC file transfer

Once a VNC session connects, the client probes for a route to move files
into/out of the guest, in this priority order:

1. **direct-sftp** -- the VM's own IP (from the QEMU Guest Agent's network
   interfaces, or the entry's manual `fileTransferIpOverride` fallback for
   LXC/agent-less guests) is directly reachable on its SSH port from this
   desktop client. Full SFTP via the same pure-Rust `russh`/`russh-sftp`
   stack LOCATION mode's SSH Remote uses.
2. **jump-sftp** -- the VM isn't directly reachable, but the Proxmox host is;
   SFTP is tunneled through the host via an SSH `direct-tcpip` channel
   (`src-tauri/src/ssh/mod.rs::connect_transport`). Still full SFTP.
3. **guest-agent** -- neither is reachable (or no SSH credentials are
   configured); falls back to the Proxmox QEMU Guest Agent REST API
   (qemu-only, size-limited uploads, no directory download). The guest OS is
   auto-detected (`guest-get-osinfo`, cached per session/VM) so both guest
   families work:
   - **Linux/Unix guests**: directory listing via `find`, upload chunks
     merged with `cat`, all through a POSIX shell.
   - **Windows guests**: directory listing and upload-chunk merging run via
     PowerShell (`-EncodedCommand`, never a hand-quoted command line).
     Windows has no single filesystem root, so the app-internal path `/` is
     presented as a synthetic "This PC" listing of the guest's drives
     (`C:`, `D:`, ...); uploads are rejected with a clear error until the
     user navigates into an actual drive.

Reachability for **direct-sftp** and **jump-sftp** is verified with a real SSH
transport handshake (`ssh_check_transport_reachable`, backed by the exact same
`connect_transport` every real SFTP call uses -- see
`src-tauri/src/ssh/mod.rs`), not a bare TCP connect: for jump-sftp this means
actually authenticating to the Proxmox host and opening a `direct-tcpip`
channel through to the VM's SSH port, so a guest with no SSH server (e.g. a
stock Windows VM) is correctly detected as unreachable via jump-sftp too,
instead of the always-up Proxmox host's own SSH port being mistaken for the
VM being reachable. This is pure-Rust `russh`, never a system
`ssh`/`ping`/`telnet` binary, so behavior is identical across Windows,
macOS, and Linux clients. VM SSH and Host SSH (jump) credentials are
identity fields on the `ProxmoxVncEntry` (see the "VM SSH" / "Host SSH (jump)"
pages of the Add/Edit Proxmox VNC Entry dialog); their passwords are never
stored in Session data -- they live in the OS keyring under the synthetic
profile ids `vncvm:<entryId>` / `vncjump:<entryId>` (`vmSshProfileId` /
`hostSshProfileId` in `proxmox-vnc.tsx`), reusing the exact same
`ssh_save_password`/`ssh_forget_password`/`ssh_has_password` commands a
regular Terminal SSH entry uses.

Once a route is found, the VNC workspace's left sidebar swaps its Proxmox
entries list for a multi-select remote file browser (Upload / Download /
Refresh toolbar, breadcrumb, and a file table identical to LOCATION mode's
own) so files can be browsed and transferred without ever unmounting the
Connection Controls + VNC screen on the right -- disconnecting, or clicking
"&larr; Entries" in the sidebar, returns to the entries list without logging
out of the Proxmox web session. See
[`docs/frontend-architecture.md`](./frontend-architecture.md) for the
component/state breakdown of this screen.

## HPE IML Monitor

REST API mode includes an HPE IML Monitor for Redfish polling. The monitor
creates one new CSV session file on the user's Desktop after it discovers the
HPE `ComputerSystem.SerialNumber`. Each newly received, de-duplicated IML entry
is appended and flushed immediately. The in-memory display retains at most 50
entries; the CSV retains the entries received during that monitor workflow.

The monitor uses a process-local Redfish session. It saves the session
`Location` and sends `DELETE` during logout or workflow cleanup when the
location is available. Login operations are serialized per workspace. A
transient request failure enters disconnected/reconnecting states and uses
bounded backoff with jitter. A 401 causes one session re-login and one retry of
the failed monitor request. A second authentication failure enters the
`authentication-failed` state and stops automatic login looping.

Manual `Stop` cancels polling, retry timers, pending discovery, and automatic
login. Manual Stop retains the session for up to one minute so the user can
request the complete advertised AHS resource. AHS download has no date-range
selector and the client does not filter the response by date. Dialog close,
entry switch, unmount, AHS completion, and selection-window expiry clean up the
session. AHS discovery accepts only advertised resources on the configured
entry origin.

IML cannot recover events that iLO loses, clears, or overwrites while the client
is disconnected. A suspected snapshot change retains local entries and records
a snapshot boundary; it does not claim recovery of remote history.

## Operation Logs

Operation logs are JSON Lines stored in the application data directory. They
redact values containing password, token, secret, cookie, or private-key
markers, normalize line breaks, cap field length, rotate at 10 MiB, and retain
at most three log files. Logs are diagnostic records, not a credential store.

## Release Verification

Before a release, maintainers must verify the relevant platform build, Rust
tests, TypeScript production build, Clippy with warnings denied, JavaScript
dependency audit, and RustSec audit. A RustSec advisory with no upstream fix
must be documented with its dependency path and an explicit product risk
decision before release approval.
