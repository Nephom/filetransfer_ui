[正體中文](README.md)

# Web-Based File Management System 3.0.0

A local file management system with a Windows Explorer-style web interface and an Ubuntu desktop client. Windows users use the web interface in a browser; the Tauri desktop client is distributed only as an Ubuntu DEB.

## Install And Upgrade

Ubuntu 22.04+, network access, and `sudo` are required. The build script installs Node.js, Rust, GTK/WebKitGTK, and the remaining dependencies.

For a new environment:

```bash
./build.sh install
./build.sh setup
./start.sh
```

For an existing Git checkout:

```bash
./build.sh upgrade
./start.sh
```

`upgrade` only fast-forwards and refuses a dirty working tree. It never overwrites `.env`, `src/config.ini`, storage, databases, users, or logs.

Use a one-command proxy when external access requires it:

```bash
./build.sh upgrade --proxy http://proxy.example.internal:8080
```

The proxy is used only for that invocation by apt, Git, npm, Cargo, curl, and wget; it is not saved globally.

## Local Configuration

`./build.sh setup` creates ignored `.env` and `src/config.ini` files and asks for storage, administrator credentials, HTTP/HTTPS ports, and an optional desktop default server address. Do not commit real addresses, credentials, tokens, or certificates.

The default HTTP port is `9400`; the default HTTPS port is `9443`. HTTP redirects only after an HTTPS certificate is available. The desktop client always uses HTTPS and collects the server address and port separately.

## Ubuntu Desktop Package

Build the Ubuntu 22.04+ DEB package with:

```bash
./build.sh build
```

The package is written to `fileapi_ui/src-tauri/target/release/bundle/deb/`. It contains no internal server address; users enter an address and HTTPS port when they sign in.

## Documentation

- [Project rules](docs/PROJECT_RULES.md)
- [API reference](docs/api/API_REFERENCE.md)
- [Documentation index](docs/README.md)
- [Ubuntu Tauri client](fileapi_ui/README.md)

`fileapi.sh` is deprecated and is not a supported compatibility target.
