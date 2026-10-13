[正體中文](README.md)

# File Transfer Platform

This project has two product surfaces: the browser-based WebUI and the standalone nFterm Desktop App. They share an API server and permission model, but differ in their execution environments, file capabilities, and workflows.

## WebUI

The WebUI is a browser-based file-management interface. It provides:

- Location browsing, search, upload, download, rename, delete, and folder operations.
- Multi-file and folder uploads with resumable transfers (4.0.0+), preserved relative directory structure, and progress tracking.
- ZIP archive downloads, share links, expiration settings, and download-count limits.
- JWT authentication, TLS, Location health, read-only state, and capability-based authorization.
- Admin Console management for users, Permission Roles, Locations, and system settings.
- Two interface styles: Classical and Pane (4.0.0+).

### WebUI Installation and Startup

The main service supports Alpine Linux and Ubuntu. For a new environment:

```bash
./build.sh install
./build.sh setup
./start.sh
```

To update an existing checkout:

```bash
./build.sh upgrade
./start.sh
```

By default, uninstall removes project-local dependencies and generated configuration while preserving operating-system packages:

```bash
./uninstall.sh
```

To remove system packages installed and recorded by `build.sh install`:

```bash
./uninstall.sh --remove-system-dependencies
```

The install record is stored in `.filetransfer_install_manifest`, which is excluded from version control. Shared packages that existed before installation are not recorded or removed.

Store deployment settings in the protected, untracked `.env` or `src/config.ini` files. Do not put real addresses, credentials, tokens, certificates, or storage paths in documentation or Git.

The default HTTP port is `9400`; the default HTTPS port is `9443`. Production deployments should use an HTTPS certificate trusted by the operating system.

## nFterm Desktop

nFterm is a Tauri v2 desktop client for Ubuntu 22.04+ and Windows 10/11. It connects to the API server over HTTPS and provides:

- LOCAL and API Remote file-management panes.
- A Windows-only Browser pane with separate web browsing and download controls.
- SSH Terminal, SFTP browsing, SSH upload/download, and remote archive operations.
- A Transfer Queue with progress, cancellation, bounded retries, failure classification, and interrupted-state recovery.
- REST API workspaces for generic REST, HPE iLO, OpenBMC, Redfish Session Auth, and Redfish Actions.
- Proxmox VNC workspaces with login, VM discovery, VNC connections, and entry isolation. nFterm must reach the Proxmox HTTPS API; VM file transfer uses the available Guest Agent, direct SFTP, or Host SSH jump route and does not require the same subnet.
- A Direct VNC card above the VNC workspace for standard VNC-password connections to macOS Screen Sharing desktops. Direct VNC provides display and input only; it does not provide file transfer.
- VM file transfer checks actual SSH reachability first, then may use the QEMU Guest Agent fallback; it does not use ping as the route test:

  | Condition | Transfer route |
  | --- | --- |
  | The VM's SSH address is directly reachable | Direct SFTP |
  | VM SSH is not directly reachable but can be reached through the Proxmox Host | Host Jump SFTP |
  | QEMU Guest Agent is installed and responding, and SSH routes are unavailable | Guest Agent fallback (no folder downloads; uploads are size-limited) |
  | LXC has a reachable VM IP and SSH configured | Direct SFTP or Host Jump SFTP; no Guest Agent API |
- QEMU Guest Agent file transfer requires the agent and `VM.GuestAgent.FileRead`, `VM.GuestAgent.FileWrite`, and `VM.GuestAgent.Unrestricted` permissions; enabling all `VM.GuestAgent.*` permissions is recommended. Without that route, direct or Host SSH jump SFTP may still work when configured. LXC does not support the Guest Agent API route.
- Local file viewing and editing, archive operations, operation logs, and undo history.

### Desktop Build

Ubuntu:

```bash
./build.sh build pre
```

The `pre` channel appends `-pre<commit hash>` to the version. For a general-availability release without a commit hash, use `./build.sh build ga`.

On a Windows build machine:

```powershell
.\build.ps1 build pre
```

For a general-availability release without a commit hash, use `build.ps1 build ga`.

Build artifacts are located at:

- Linux DEB: `fileapi_ui/src-tauri/target/release/bundle/deb/`
- Windows portable EXE: `fileapi_ui/src-tauri/target/release/nFterm.exe`
- Windows NSIS: `fileapi_ui/src-tauri/target/release/bundle/nsis/`

### Desktop Security Behavior

- The API session token remains in memory for the running process and is not stored in WebView local storage.
- SSH, REST, and Proxmox secrets use the OS credential store. If it is unavailable, nFterm does not fall back to plaintext or Base64 files.
- In a non-elevated process, local file operations are restricted to the user's HOME. Writes check the canonical parent to prevent symlink/junction boundary escapes.
- Downloads use collision-safe filenames and remove partial output after cancellation or failure.
- TLS certificate verification is enabled by default. It is disabled only when the user explicitly selects **Ignore TLS errors**.
- The Proxmox localhost relay uses a one-time token and an exact WebSocket path. Switching entries cancels a pending relay that has not yet been established.
- The Desktop UI supports only `en_US` and `zh_TW`. It selects an initial locale from the WebView language and lets users change and save it in the top-right Account menu.

## API Contract

See the complete server API contract:

- [API Reference](docs/api/API_REFERENCE.md)
- [API Documentation](docs/api/README.md)
- [Upload API](docs/api/upload.md)
- [Progress API](docs/api/progress.md)
- [Error Codes](docs/api/error-codes.md)

## Technical Documentation

- [Documentation index](docs/README.md)
- [Desktop Architecture](docs/desktop.md)
- [Transfer Queue](docs/queue.md)
- [Queue Maintenance](docs/queue-maintenance.md)
- [Locations](docs/locations.md)
- [Permission Management](docs/permissions.md)
- [Versioning](docs/versioning.md)
