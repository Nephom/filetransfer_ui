# nFterm 3.4.0

This is a mouse-first Tauri v2 desktop client for Ubuntu 22.04+ and Windows 10/11. The repository folder is `fileapi_ui`.

## Build

From the repository root on Ubuntu, use the supported Linux build workflow:

```bash
./build.sh build
```

It installs the required Ubuntu, Node.js, Rust, GTK, and WebKitGTK dependencies, then creates a DEB in `src-tauri/target/release/bundle/deb/`.

On a Windows build machine, run the repository-level PowerShell workflow. It checks or installs Node.js, Rust with the MSVC toolchain, and the required desktop dependencies:

```powershell
.\build.ps1 build
```

The portable EXE is created at `src-tauri/target/release/nFterm.exe`. The NSIS installer is created in `src-tauri/target/release/bundle/nsis/`.

## Server Connection

The sign-in page always uses HTTPS. It collects the server address and HTTPS port separately; the default port is `9443`. Do not include a protocol, path, or port in the server-address field.

`fileapi_ui/.env` is ignored and may provide local development defaults:

```dotenv
VITE_DEFAULT_SERVER_HOST=files.example.internal
VITE_DEFAULT_SERVER_PORT=9443
```

Values beginning with `VITE_` are compiled into a build. Leave both values blank for distributable packages so no deployment address is embedded.

The server certificate must be trusted by the operating system. The client does not bypass TLS certificate validation.

## API Behaviour

- One selected regular file uses `GET /api/files/download/*`.
- A folder or multiple selected items use `POST /api/archive` and download a ZIP.
- The client surfaces the backend's JSON error message rather than only an HTTP status.
- Configuration and token storage use the desktop WebView's local application storage.
- Downloads are written to the user's `Downloads` directory.

See the parent [API contract](../docs/api/API_REFERENCE.md).
