# File Transfer Desktop 3.0.1

This is a mouse-first Tauri v2 client for Ubuntu 22.04 and newer. Windows users access the parent project's web interface in a browser; no Windows desktop package is produced.

## Build

From the repository root, use the supported build workflow:

```bash
./build.sh build
```

It installs the required Ubuntu, Node.js, Rust, GTK, and WebKitGTK dependencies, then creates a DEB in `src-tauri/target/release/bundle/deb/`.

For development only:

```bash
npm ci
npm run tauri dev
```

## Server Connection

The sign-in page always uses HTTPS. It collects the server address and HTTPS port separately; the default port is `9443`. Do not include a protocol, path, or port in the server-address field.

`fileapi_ui/.env` is ignored and may provide local development defaults:

```dotenv
VITE_DEFAULT_SERVER_HOST=files.example.internal
VITE_DEFAULT_SERVER_PORT=9443
```

Values beginning with `VITE_` are compiled into a build. Leave both values blank for distributable DEBs so no deployment address is embedded.

The server certificate must be trusted by the Ubuntu system. The client does not bypass TLS certificate validation.

## API Behaviour

- One selected regular file uses `GET /api/files/download/*`.
- A folder or multiple selected items use `POST /api/archive` and download a ZIP.
- The client surfaces the backend's JSON error message rather than only an HTTP status.
- Configuration and token storage use the desktop WebView's local application storage.
- Downloads are written to the user's `Downloads` directory.

See the parent [API contract](../docs/api/API_REFERENCE.md) and [project rules](../docs/PROJECT_RULES.md).
