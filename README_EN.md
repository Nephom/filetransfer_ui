[正體中文](README.md)

# Web-Based File Management System 3.3.2

A local file management system with a Windows Explorer-style web interface and a Tauri v2 desktop client (**nFterm**) for Ubuntu and Windows.

The nFterm desktop client also includes a REST API mode for Workspace-managed REST API entries, HPE iLO, OpenBMC, and generic Redfish/REST services. It supports Redfish Session Auth with `X-Auth-Token`, `@odata.id` navigation, Redfish Actions, AHS/`DownloadUri` downloads, and recent GET path history.

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

## Desktop Package

Ubuntu 22.04+ builds the desktop DEB with:

```bash
./build.sh build
```

The package is written to `fileapi_ui/src-tauri/target/release/bundle/deb/`.

Windows build machines use the PowerShell workflow. It only handles the Tauri desktop client; server `install` and `setup` remain in `build.sh`:

```powershell
.\build.ps1 build
.\build.ps1 upgrade
.\build.ps1 self-upgrade
```

The Windows build creates a portable EXE at `fileapi_ui/src-tauri/target/release/nFterm.exe` and an NSIS package under `fileapi_ui/src-tauri/target/release/bundle/nsis/`. The local file pane defaults to the current user's Desktop.

The desktop client was renamed to **nFterm** (formerly "File Transfer Desktop" / fileapi-desktop). Upgrading users can move their legacy data directory (`~/.fileapi-desktop`) to the new one (`~/.nFterm`) with `upgrade_tools/migrate-desktop-data.ps1`.

## REST API Mode

nFterm REST API mode is separate from the existing `LOCATION` file-management mode. In REST API mode, the left side shows REST API entries from the selected Workspace and the center shows the REST response reader. The Terminal and SSH entries remain available and unchanged.

A REST API entry can define its Base URL, path, query parameters, TLS settings, and authentication. For HPE iLO or OpenBMC Redfish, choose `Session Auth` and then select the matching `HPE` or `OpenBMC` preset.

Redfish login flow:

1. Select `Session Auth`.
2. Enter the Redfish username and password.
3. Select `HPE` or `OpenBMC`.
4. Click `Use Redfish SessionService preset`.
5. Click `Login`.
6. Confirm that `REST session established` is displayed.
7. Click `GET` to start browsing `/redfish/v1`.

The reader supports `@odata.id`, `href`, `Members`, nested `Links`, Redfish `Actions.*.target`, recent GET path history, and download links such as `DownloadUri`. Reset, power, BIOS, and other actions require confirmation. Tokens, cookies, and passwords are never written to Workspace JSON or the operation log.

## Documentation

- [API reference](docs/api/API_REFERENCE.md)
- [Documentation index](docs/README.md)
- [WebUI permission management](docs/permissions.md)
- [Tauri desktop client](fileapi_ui/README.md)

`fileapi.sh` is deprecated and is not a supported compatibility target.
