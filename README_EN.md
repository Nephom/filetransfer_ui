[正體中文](README.md)

# Web-Based File Management System 3.2.0

A local file management system with a Windows Explorer-style web interface and an Ubuntu desktop client. Windows users use the web interface in a browser; the Tauri desktop client is distributed only as an Ubuntu DEB.

## Install And Upgrade

The server supports Alpine Linux and Ubuntu and requires network access plus permission to install system packages. `install` and `upgrade` install only Node.js and server dependencies; they do not install or build Tauri.

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

### Legacy Migration

For releases older than 3.0.0, when `git pull` explicitly reports that local tracked changes would be overwritten, stop the service, back up the configuration, and move **only the files named by Git's error**:

```bash
./stop.sh
mkdir -p ../filetransfer-local-backup
cp src/config.ini ../filetransfer-local-backup/config.ini
for file in package-lock.json start.sh stop.sh status.sh src/config.ini; do
  if ! git diff --quiet -- "$file" || ! git diff --cached --quiet -- "$file"; then
    mkdir -p "../filetransfer-local-backup/$(dirname "$file")"
    mv "$file" "../filetransfer-local-backup/$file"
  fi
done
git pull --ff-only
cp ../filetransfer-local-backup/config.ini src/config.ini
./build.sh upgrade
./start.sh
```

The loop moves only files with local Git changes. Do not restore the old `package-lock.json` or lifecycle scripts. Temporarily restoring `src/config.ini` lets `build.sh upgrade` migrate credentials, storage, and ports into ignored `.env`; it remains a local configuration file afterward.

Use a one-command proxy when external access requires it:

```bash
./build.sh upgrade --proxy http://proxy.example.internal:8080
```

The proxy is used only for that invocation by apk or apt, Git, npm, Cargo, curl, and wget; it is not saved globally.

## Local Configuration

`./build.sh setup` creates ignored `.env` and `src/config.ini` files and asks for storage, administrator credentials, HTTP/HTTPS ports, and an optional desktop default server address. Do not commit real addresses, credentials, tokens, or certificates.

The default HTTP port is `9400`; the default HTTPS port is `9443`. HTTP redirects only after an HTTPS certificate is available. The desktop client always uses HTTPS and collects the server address and port separately.

## Ubuntu Desktop Package

Only Ubuntu 22.04+ builds the desktop package. This command installs Rust, GTK/WebKitGTK, and the Tauri build dependencies:

```bash
./build.sh build
```

The package is written to `fileapi_ui/src-tauri/target/release/bundle/deb/`. It contains no internal server address; users enter an address and HTTPS port when they sign in.

## Documentation

- [API reference](docs/api/API_REFERENCE.md)
- [Documentation index](docs/README.md)
- [Ubuntu Tauri client](fileapi_ui/README.md)

`fileapi.sh` is deprecated and is not a supported compatibility target.
