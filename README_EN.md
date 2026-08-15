[正體中文](README.md)

# File Transfer Platform 3.3.3

This repository contains two product surfaces: the browser-based WebUI and the nFterm Desktop App. They share the API server and permission model, but their execution environments and local-file capabilities are different.

## WebUI

The WebUI is the browser file-management product. It provides:

- Location browsing, search, upload, download, rename, delete, and folder operations.
- Multi-file and directory uploads with preserved relative structure and progress polling.
- ZIP archive downloads, share links, expiration, and download-count controls.
- JWT authentication, TLS, Location health, read-only state, and capability authorization.
- Admin Console workflows for users, Permission Roles, Locations, and system settings.

### WebUI Installation

The server supports Alpine Linux and Ubuntu. For a new environment:

```bash
./build.sh install
./build.sh setup
./start.sh
```

For an existing checkout:

```bash
./build.sh upgrade
./start.sh
```

Uninstall removes project-local dependencies and generated configuration by default, while preserving operating-system packages:

```bash
./uninstall.sh
```

To remove only the system packages that `build.sh install` installed and recorded:

```bash
./uninstall.sh --remove-system-dependencies
```

The install manifest is kept in the ignored `.filetransfer_install_manifest` file. Packages that existed before installation are never recorded or removed.

Deployment values belong in protected, ignored `.env` or `src/config.ini` files. Do not put real addresses, credentials, tokens, certificates, or storage paths in documentation or Git.

The default HTTP port is `9400`; the default HTTPS port is `9443`. Production deployments should use an operating-system-trusted HTTPS certificate.

## nFterm Desktop App

nFterm is a Tauri v2 desktop client for Ubuntu 22.04+ and Windows 10/11. It connects to the API server over HTTPS and provides:

- LOCAL and API Remote file-management panes.
- SSH Terminal, SFTP browsing, SSH upload/download, and remote archive operations.
- A Transfer Queue with progress, cancellation, bounded retry, failure classification, and interrupted-state recovery.
- REST API workspaces for generic REST, HPE iLO, OpenBMC, Redfish Session Auth, and Redfish Actions.
- Proxmox VNC workspaces with login, VM discovery, VNC connection, and entry isolation.
- Local file viewer/editor, archive operations, operation logs, and undo history.

### Desktop Build

Ubuntu:

```bash
./build.sh build
```

Windows build machine:

```powershell
.\build.ps1 build
```

Artifacts are written to:

- Linux DEB: `fileapi_ui/src-tauri/target/release/bundle/deb/`
- Windows portable EXE: `fileapi_ui/src-tauri/target/release/nFterm.exe`
- Windows NSIS package: `fileapi_ui/src-tauri/target/release/bundle/nsis/`

### Desktop Security Behaviour

- The API session token exists only for the running process and is not stored in WebView local storage.
- SSH, REST, and Proxmox secrets use the OS credential store. If it is unavailable, nFterm fails explicitly instead of writing plaintext or Base64 secrets.
- In a non-elevated process, local filesystem operations remain inside the user HOME. Canonical parent checks protect writes from symlink/junction escapes.
- Downloads use collision-safe filenames and clean partial output after cancellation or failure.
- TLS certificate verification is enabled by default. It is disabled only after the user explicitly selects Ignore TLS errors.
- The Proxmox localhost relay uses a one-time token and exact WebSocket path validation. Switching entries cancels a pending relay.

## API Contract

See the authoritative server contract:

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
