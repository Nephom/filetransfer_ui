#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND=""
PROXY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy)
      [[ $# -ge 2 ]] || { echo "--proxy requires a URL" >&2; exit 2; }
      PROXY="$2"
      shift 2
      ;;
    --help|-h)
      COMMAND="help"
      shift
      ;;
    install|setup|build|test|upgrade|help)
      [[ -z "$COMMAND" ]] || { echo "Only one command may be provided." >&2; exit 2; }
      COMMAND="$1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

COMMAND="${COMMAND:-help}"

usage() {
  cat <<'EOF'
Usage: ./build.sh <command> [--proxy http://proxy-host:port]

Commands:
  install  Install server dependencies on Alpine Linux or Ubuntu.
  setup    Create missing local configuration and ask for deployment values.
  build    Build the Ubuntu 22.04+ Tauri DEB package.
  test     Run backend sandbox tests.
  upgrade  Fast-forward from GitHub, update dependencies, and run backend tests.

The proxy applies only to this invocation. It is passed to apk or apt, Git, npm,
Cargo, curl, and wget; it is never saved to global configuration.
EOF
}

configure_proxy() {
  [[ -z "$PROXY" ]] && return
  [[ "$PROXY" =~ ^https?://[^/:]+(:[0-9]+)?/?$ ]] || {
    echo "Proxy must use http://host:port or https://host:port" >&2
    exit 2
  }

  export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
  export npm_config_proxy="$PROXY" npm_config_https_proxy="$PROXY" CARGO_HTTP_PROXY="$PROXY"
  export NO_PROXY="localhost,127.0.0.1" no_proxy="localhost,127.0.0.1"
}

run_git() {
  if [[ -n "$PROXY" ]]; then
    git -c http.proxy="$PROXY" "$@"
  else
    git "$@"
  fi
}

run_apt() {
  if [[ -n "$PROXY" ]]; then
    run_as_root env http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" DEBIAN_FRONTEND=noninteractive apt-get "$@"
  else
    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get "$@"
  fi
}

run_apk() {
  if [[ -n "$PROXY" ]]; then
    run_as_root env http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" apk "$@"
  else
    run_as_root apk "$@"
  fi
}

run_as_root() {
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Root privileges or sudo are required to install system packages." >&2
    exit 1
  fi
}

detect_os() {
  [[ -r /etc/os-release ]] || { echo "Alpine Linux or Ubuntu is required." >&2; exit 1; }
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_VERSION="${VERSION_ID:-}"
}

require_ubuntu() {
  detect_os
  [[ "$OS_ID" == "ubuntu" ]] || { echo "Ubuntu 22.04 or newer is required for the Tauri DEB build." >&2; exit 1; }
  local major="${OS_VERSION%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 22 ]] || { echo "Ubuntu 22.04 or newer is required." >&2; exit 1; }
}

install_desktop_system_dependencies() {
  require_ubuntu
  run_as_root true
  run_apt update

  local webkit_package="libwebkit2gtk-4.1-dev"
  if ! apt-cache show "$webkit_package" >/dev/null 2>&1; then
    webkit_package="libwebkit2gtk-4.0-dev"
  fi

  run_apt install -y ca-certificates curl wget git file build-essential pkg-config libssl-dev libgtk-3-dev "$webkit_package" libayatana-appindicator3-dev librsvg2-dev libxdo-dev
}

install_server_system_dependencies() {
  detect_os
  case "$OS_ID" in
    alpine)
      run_apk add --no-cache bash ca-certificates curl wget git nodejs npm python3 make g++ libstdc++ lsof iproute2
      ;;
    ubuntu)
      run_as_root true
      run_apt update
      run_apt install -y ca-certificates curl wget git file build-essential pkg-config python3
      ;;
    *)
      echo "Unsupported server OS: $OS_ID. Supported server platforms are Alpine Linux and Ubuntu." >&2
      exit 1
      ;;
  esac
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || true
}

node_supports_env_file() {
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 6) ? 0 : 1)' 2>/dev/null
}

ensure_node() {
  local major
  major="$(node_major)"
  if [[ "$major" =~ ^[0-9]+$ && "$major" -ge 20 ]] && node_supports_env_file; then
    return
  fi

  detect_os
  if [[ "$OS_ID" == "alpine" ]]; then
    run_apk add --no-cache nodejs npm
  elif [[ "$OS_ID" == "ubuntu" ]]; then
    echo "Installing Node.js 22 LTS..."
    curl --fail --location --show-error https://deb.nodesource.com/setup_22.x | run_as_root env http_proxy="${http_proxy:-}" https_proxy="${https_proxy:-}" bash -
    run_apt install -y nodejs
  else
    echo "Unsupported server OS: $OS_ID." >&2
    exit 1
  fi
  major="$(node_major)"
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 20 ]] && node_supports_env_file || { echo "Node.js 20.6 or newer is required." >&2; exit 1; }
}

ensure_rust() {
  if ! command -v rustup >/dev/null 2>&1; then
    echo "Installing Rust stable toolchain..."
    curl --fail --location --show-error https://sh.rustup.rs | sh -s -- -y --profile minimal
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup toolchain install stable --profile minimal
  rustup default stable
}

install_server_node_dependencies() {
  npm ci --prefix "$ROOT_DIR"
}

install_desktop_node_dependencies() {
  npm ci --prefix "$ROOT_DIR/fileapi_ui"
}

format_env_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/}"
  printf '"%s"' "$value"
}

upsert_env() {
  local key="$1"
  local value="$2"
  local formatted_value
  local env_file="$ROOT_DIR/.env"
  local temporary
  formatted_value="$(format_env_value "$value")"
  temporary="$(mktemp)"
  awk -v key="$key" -v value="$formatted_value" '
    $0 ~ "^" key "=" { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$env_file" > "$temporary"
  mv "$temporary" "$env_file"
}

read_value() {
  local prompt="$1"
  local default_value="$2"
  local value
  read -r -p "$prompt [$default_value]: " value
  printf '%s' "${value:-$default_value}"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  fi
}

read_ini_value() {
  local ini_file="$1"
  local section="$2"
  local key="$3"
  awk -F= -v section="$section" -v key="$key" '
    $0 == "[" section "]" { active = 1; next }
    /^\[/ { active = 0 }
    active && $1 == key { print substr($0, index($0, "=") + 1); exit }
  ' "$ini_file"
}

migrate_legacy_configuration() {
  local legacy_file="$1"
  [[ -n "$legacy_file" && -f "$legacy_file" && ! -f "$ROOT_DIR/.env" ]] || return

  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  local storage username password password_hashed http_port https_port redirect secret
  storage="$(read_ini_value "$legacy_file" fileSystem storagePath)"
  username="$(read_ini_value "$legacy_file" auth username)"
  password="$(read_ini_value "$legacy_file" auth password)"
  password_hashed="$(read_ini_value "$legacy_file" auth passwordHashed)"
  http_port="$(read_ini_value "$legacy_file" server port)"
  https_port="$(read_ini_value "$legacy_file" ssl httpsPort)"
  redirect="$(read_ini_value "$legacy_file" ssl enableHttpsRedirect)"
  secret="$(read_ini_value "$legacy_file" security jwtSecret)"

  upsert_env FILESYSTEM_STORAGE_PATH "${storage:-./storage}"
  upsert_env AUTH_USERNAME "${username:-admin}"
  upsert_env AUTH_PASSWORD "$password"
  upsert_env AUTH_PASSWORD_HASHED "${password_hashed:-false}"
  upsert_env SERVER_PORT "${http_port:-9400}"
  upsert_env SSL_HTTPS_PORT "${https_port:-9443}"
  upsert_env SSL_ENABLE_HTTPS_REDIRECT "${redirect:-true}"
  upsert_env JWT_SECRET "${secret:-$(generate_secret)}"
  chmod 600 "$ROOT_DIR/.env"
  echo "Migrated the existing local configuration to .env without replacing its values."
}

setup_configuration() {
  if [[ ! -f "$ROOT_DIR/src/config.ini" ]]; then
    cp "$ROOT_DIR/src/config.ini.example" "$ROOT_DIR/src/config.ini"
    echo "Created src/config.ini from the safe template."
  fi

  if [[ -f "$ROOT_DIR/.env" ]]; then
    echo "Existing .env retained; no deployment values were overwritten."
    return
  fi

  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  local storage username password http_port https_port server_host secret
  storage="$(read_value "Storage path" "./storage")"
  username="$(read_value "Administrator username" "admin")"
  http_port="$(read_value "HTTP port" "9400")"
  https_port="$(read_value "HTTPS port" "9443")"
  server_host="$(read_value "Desktop default server address (optional)" "")"
  read -r -s -p "Administrator password (required): " password
  printf '\n'
  [[ -n "$password" ]] || { echo "Administrator password cannot be empty." >&2; rm -f "$ROOT_DIR/.env"; exit 1; }
  secret="$(generate_secret)"

  upsert_env FILESYSTEM_STORAGE_PATH "$storage"
  upsert_env AUTH_USERNAME "$username"
  upsert_env AUTH_PASSWORD "$password"
  upsert_env SERVER_PORT "$http_port"
  upsert_env SSL_HTTPS_PORT "$https_port"
  upsert_env JWT_SECRET "$secret"
  mkdir -p "$storage"

  if [[ -n "$server_host" ]]; then
    cp "$ROOT_DIR/fileapi_ui/.env.example" "$ROOT_DIR/fileapi_ui/.env"
    printf 'VITE_DEFAULT_SERVER_HOST=%s\nVITE_DEFAULT_SERVER_PORT=%s\n' "$server_host" "$https_port" > "$ROOT_DIR/fileapi_ui/.env"
  fi
  chmod 600 "$ROOT_DIR/.env"
  echo "Created local deployment settings. Keep .env and src/config.ini out of version control."
}

cmd_install() {
  install_server_system_dependencies
  ensure_node
  install_server_node_dependencies
}

cmd_setup() {
  node_supports_env_file || cmd_install
  setup_configuration
}

cmd_build() {
  cmd_install
  install_desktop_system_dependencies
  ensure_rust
  install_desktop_node_dependencies
  npm run build --prefix "$ROOT_DIR/fileapi_ui"
  (
    cd "$ROOT_DIR/fileapi_ui"
    cargo check --locked
    npm run tauri build
  )
  echo "DEB packages are in fileapi_ui/src-tauri/target/release/bundle/deb/."
}

cmd_test() {
  npm test --prefix "$ROOT_DIR"
}

cmd_upgrade() {
  [[ -d "$ROOT_DIR/.git" ]] || { echo "upgrade requires a Git checkout." >&2; exit 1; }
  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    echo "Refusing to update a working tree with uncommitted changes." >&2
    echo "Keep ignored .env and src/config.ini, but restore any accidentally moved tracked files before retrying:" >&2
    echo "  git restore --source=HEAD -- package-lock.json start.sh stop.sh status.sh" >&2
    exit 1
  fi
  local legacy_config=""
  if [[ ! -f "$ROOT_DIR/.env" && -f "$ROOT_DIR/src/config.ini" ]]; then
    legacy_config="$(mktemp)"
    cp "$ROOT_DIR/src/config.ini" "$legacy_config"
  fi
  run_git -C "$ROOT_DIR" fetch origin
  run_git -C "$ROOT_DIR" merge --ff-only "@{u}"
  cmd_install
  migrate_legacy_configuration "$legacy_config"
  [[ -z "$legacy_config" ]] || rm -f "$legacy_config"
  setup_configuration
  npm test --prefix "$ROOT_DIR"
  echo "Upgrade complete. Start the service with ./start.sh."
}

configure_proxy
case "$COMMAND" in
  install) cmd_install ;;
  setup) cmd_setup ;;
  build) cmd_build ;;
  test) cmd_test ;;
  upgrade) cmd_upgrade ;;
  help|"") usage ;;
  *) usage >&2; exit 2 ;;
esac
