#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${FILETRANSFER_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
INSTALL_MANIFEST="$ROOT_DIR/.filetransfer_install_manifest"
COMMAND=""
PROXY=""
INTERACTIVE_UPGRADE=0
SELF_UPDATE_CONTINUE=0
SELF_UPDATE_DRY_RUN=0

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
    --interactive)
      INTERACTIVE_UPGRADE=1
      shift
      ;;
    --continue)
      SELF_UPDATE_CONTINUE=1
      shift
      ;;
    --dry-run)
      SELF_UPDATE_DRY_RUN=1
      shift
      ;;
    install|setup|build|test|upgrade|self-update|help)
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
Usage: ./build.sh <command> [--proxy http://proxy-host:port] [--interactive]

Commands:
  install  Install server dependencies on Alpine Linux or Ubuntu.
  setup    Create missing local configuration and ask for deployment values.
  build    Build the Ubuntu 22.04+ Tauri DEB package.
  test     Run backend sandbox tests.
  upgrade      Fast-forward from GitHub, migrate configuration, update dependencies, and run backend tests.
  self-update  Fetch and syntax-check the upstream build.sh; use --continue to run upgrade with it.

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

package_installed() {
  local manager="$1"
  local package="$2"
  case "$manager" in
    apt) dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii ' ;;
    apk) apk info -e "$package" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

record_installed_packages() {
  local manager="$1"
  shift
  local package

  [[ "$#" -gt 0 ]] || return 0
  if [[ ! -f "$INSTALL_MANIFEST" ]]; then
    {
      printf '%s\n' '# File Transfer install manifest; managed by build.sh.'
      printf '%s\n' 'version=1'
    } > "$INSTALL_MANIFEST"
  fi

  for package in "$@"; do
    grep -Fq "${manager}	${package}" "$INSTALL_MANIFEST" ||
      printf '%s\t%s\n' "$manager" "$package" >> "$INSTALL_MANIFEST"
  done
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
  local webkit_package="libwebkit2gtk-4.1-dev"
  if ! apt-cache show "$webkit_package" >/dev/null 2>&1; then
    webkit_package="libwebkit2gtk-4.0-dev"
  fi

  local packages=(ca-certificates curl wget git file build-essential pkg-config libssl-dev libgtk-3-dev "$webkit_package" libayatana-appindicator3-dev librsvg2-dev libxdo-dev)
  local missing=()
  local package
  for package in "${packages[@]}"; do
    package_installed apt "$package" || missing+=("$package")
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    echo "Desktop system dependencies are already installed; skipping root-only package installation."
    return
  fi

  echo "Installing missing desktop system dependencies: ${missing[*]}"
  run_as_root true
  run_apt update
  run_apt install -y "${missing[@]}"
  record_installed_packages apt "${missing[@]}"
}

install_server_system_dependencies() {
  detect_os
  case "$OS_ID" in
    alpine)
      local packages=(bash ca-certificates curl wget git nodejs npm python3 make g++ libstdc++ lsof iproute2 redis)
      local missing=()
      local package
      for package in "${packages[@]}"; do
        package_installed apk "$package" || missing+=("$package")
      done
      if [[ "${#missing[@]}" -eq 0 ]]; then
        echo "Server system dependencies are already installed; skipping root-only package installation."
        return
      fi
      run_apk add --no-cache "${missing[@]}"
      record_installed_packages apk "${missing[@]}"
      ;;
    ubuntu)
      local packages=(ca-certificates curl wget git file build-essential pkg-config python3 redis-server)
      local missing=()
      local package
      for package in "${packages[@]}"; do
        package_installed apt "$package" || missing+=("$package")
      done
      if [[ "${#missing[@]}" -eq 0 ]]; then
        echo "Server system dependencies are already installed; skipping root-only package installation."
        return
      fi
      run_as_root true
      run_apt update
      run_apt install -y "${missing[@]}"
      record_installed_packages apt "${missing[@]}"
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
    record_installed_packages apt nodejs
  else
    echo "Unsupported server OS: $OS_ID." >&2
    exit 1
  fi
  major="$(node_major)"
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 20 ]] && node_supports_env_file || { echo "Node.js 20.6 or newer is required." >&2; exit 1; }
}

ensure_rust() {
  if [[ -x "$HOME/.cargo/bin/cargo" && -x "$HOME/.cargo/bin/rustc" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  fi

  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    echo "Using existing Rust toolchain: $(rustc --version)"
    return
  fi

  if command -v rustup >/dev/null 2>&1; then
    echo "Rust compiler is incomplete; installing the stable rustup toolchain..."
    rustup toolchain install stable --profile minimal
    rustup default stable
    export PATH="$HOME/.cargo/bin:$PATH"
    return
  fi

  echo "Installing Rust stable toolchain..."
  curl --fail --location --show-error https://sh.rustup.rs | sh -s -- -y --profile minimal
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup toolchain install stable --profile minimal
  rustup default stable
}

install_server_node_dependencies() {
  npm ci --ignore-scripts --include=optional --prefix "$ROOT_DIR"
  npm rebuild --foreground-scripts --prefix "$ROOT_DIR"
  (cd "$ROOT_DIR" && node -e 'for (const name of ["bcrypt", "sqlite3", "unrs-resolver"]) require.resolve(name);')
}

install_desktop_node_dependencies() {
  npm ci --ignore-scripts --include=optional --prefix "$ROOT_DIR/fileapi_ui"
  npm rebuild --foreground-scripts --prefix "$ROOT_DIR/fileapi_ui"
  # Fail fast with a clear message here if `npm ci` did not actually leave
  # every declared dependency resolvable (stale/corrupted npm cache,
  # network drop mid-install, package.json/package-lock.json drift, etc.)
  # instead of surfacing as a confusing "Cannot find module" deep inside
  # `tsc`/`vite build` later on. Mirrors the same require.resolve() safety
  # net install_server_node_dependencies already uses for backend deps.
  (cd "$ROOT_DIR/fileapi_ui" && node -e 'for (const name of Object.keys(require("./package.json").dependencies)) require.resolve(name);')
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

read_env_value() {
  local env_file="$1"
  local key="$2"
  [[ -f "$env_file" ]] || return 0
  awk -F= -v key="$key" '$1 == key { value = substr($0, index($0, "=") + 1); gsub(/^"|"$/, "", value); print value; exit }' "$env_file"
}

backup_database_before_upgrade() {
  local env_database_path database_path backup_dir backup_file timestamp
  env_database_path="$(read_env_value "$ROOT_DIR/.env" DATABASE_PATH)"
  database_path="${env_database_path:-$ROOT_DIR/src/data/app.db}"
  if [[ "$database_path" != /* ]]; then
    database_path="$ROOT_DIR/$database_path"
  fi

  if [[ ! -f "$database_path" ]]; then
    echo "No SQLite database found at $database_path; migration will create it if needed."
    return
  fi

  backup_dir="$ROOT_DIR/data/backups"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="$backup_dir/app.db.$timestamp.sqlite"
  mkdir -p "$backup_dir"
  DATABASE_PATH="$database_path" node "$ROOT_DIR/scripts/backup-database.js" "$backup_file"
  echo "Upgrade database backup: $backup_file"
}

run_database_migrations() {
  local env_database_path database_path
  env_database_path="$(read_env_value "$ROOT_DIR/.env" DATABASE_PATH)"
  database_path="${env_database_path:-$ROOT_DIR/src/data/app.db}"
  if [[ "$database_path" != /* ]]; then
    database_path="$ROOT_DIR/$database_path"
  fi
  DATABASE_PATH="$database_path" npm run migrate:database --prefix "$ROOT_DIR"
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

target_application_version() {
  local upstream_ref version_file package_json
  upstream_ref="$(get_upstream_ref)" || {
    echo "Unable to determine an upstream branch for this checkout." >&2
    return 1
  }
  version_file="$(run_git -C "$ROOT_DIR" show "${upstream_ref}:VERSION" 2>/dev/null || true)"
  if [[ -n "$version_file" ]]; then
    printf '%s\n' "${version_file//$'\n'/}"
    return 0
  fi
  package_json="$(run_git -C "$ROOT_DIR" show "${upstream_ref}:package.json")" || {
    echo "Unable to read package.json from upstream ${upstream_ref}." >&2
    return 1
  }
  node -e 'process.stdout.write(`${JSON.parse(process.argv[1]).version}\n`)' "$package_json" || {
    echo "Unable to parse package.json from upstream ${upstream_ref}." >&2
    return 1
  }
}

application_version() {
  node "$ROOT_DIR/scripts/version.js" | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).version));'
}

application_version_display() {
  node "$ROOT_DIR/scripts/version.js" | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).display));'
}

get_upstream_ref() {
  local tracked_ref
  tracked_ref="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref '@{u}' 2>/dev/null || true)"
  if [[ -n "$tracked_ref" ]]; then
    printf '%s\n' "$tracked_ref"
    return 0
  fi

  if git -C "$ROOT_DIR" show-ref --verify --quiet refs/remotes/origin/main; then
    printf '%s\n' 'origin/main'
    return 0
  fi

  return 1
}

self_update() {
  local upstream_ref temporary
  git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1 || {
    echo "self-update requires a Git checkout." >&2
    exit 1
  }

  echo "Self-update: fetching upstream changes..."
  run_git -C "$ROOT_DIR" fetch origin
  upstream_ref="$(get_upstream_ref)" || {
    echo "Self-update: unable to determine an upstream branch for this checkout." >&2
    exit 1
  }

  temporary="$(mktemp "${TMPDIR:-/tmp}/filetransfer-build.XXXXXX")"
  cleanup_self_update() {
    rm -f "$temporary"
  }
  trap cleanup_self_update RETURN

  if ! run_git -C "$ROOT_DIR" show "${upstream_ref}:build.sh" > "$temporary"; then
    echo "Self-update: unable to read build.sh from ${upstream_ref}." >&2
    exit 1
  fi
  if ! bash -n "$temporary"; then
    echo "Self-update: fetched build.sh failed syntax validation." >&2
    exit 1
  fi
  echo "Self-update: fetched build.sh from ${upstream_ref} passed syntax validation."

  [[ "$SELF_UPDATE_DRY_RUN" -eq 1 ]] && return 0
  [[ "$SELF_UPDATE_CONTINUE" -eq 1 ]] || {
    echo "Self-update complete. Run ./build.sh upgrade to apply it, or use --continue next time."
    return 0
  }

  local -a forwarded_args=(upgrade)
  [[ "$INTERACTIVE_UPGRADE" -eq 1 ]] && forwarded_args+=(--interactive)
  [[ -n "$PROXY" ]] && forwarded_args+=(--proxy "$PROXY")
  FILETRANSFER_ROOT="$ROOT_DIR" SELF_UPDATE_BOOTSTRAPPED=1 bash "$temporary" "${forwarded_args[@]}"
}

confirm_configuration_upgrade() {
  local target_version current_version needs_upgrade answer
  target_version="$1"
  current_version="$(node "$ROOT_DIR/upgrade_tools/config-upgrade.js" --print-version --target-version "$target_version")"
  needs_upgrade="$(node "$ROOT_DIR/upgrade_tools/config-upgrade.js" --needs-upgrade --target-version "$target_version")"

  [[ "$needs_upgrade" == "yes" ]] || return 0

  echo "Configuration upgrade required: $current_version -> $target_version"
  echo "The upgrade keeps matching values, migrates Locations, and comments deprecated options."
  if [[ "$INTERACTIVE_UPGRADE" -eq 1 ]]; then
    read -r -p "Upgrade src/config.ini and continue? [y/N] " answer
    case "${answer,,}" in
      y|yes) ;;
      *)
        echo "Upgrade stopped. src/config.ini remains at $current_version; application code was not updated." >&2
        exit 1
        ;;
    esac
  else
    echo "Non-interactive upgrade: preserving existing values and applying migration defaults."
  fi
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
  upsert_env SSL_AUTO_GENERATE_CERTS "true"
  upsert_env JWT_SECRET "$secret"
  mkdir -p "$storage"

  if [[ -n "$server_host" ]]; then
    cp "$ROOT_DIR/fileapi_ui/.env.example" "$ROOT_DIR/fileapi_ui/.env"
    printf 'VITE_DEFAULT_SERVER_HOST=%s\nVITE_DEFAULT_SERVER_PORT=%s\n' "$server_host" "$https_port" > "$ROOT_DIR/fileapi_ui/.env"
  fi
  chmod 600 "$ROOT_DIR/.env"
  echo "Created local deployment settings. Keep .env and src/config.ini out of version control."
}

normalize_generated_tauri_changes() {
  local manifest="$ROOT_DIR/fileapi_ui/src-tauri/Cargo.toml"
  local changed expected
  [[ -f "$manifest" ]] || return
  changed="$(git -C "$ROOT_DIR" diff --unified=0 -- "$manifest" | while IFS= read -r line; do
    case "$line" in
      +++*|---*|@@*) ;;
      +*|-*) printf '%s\n' "$line" ;;
    esac
  done)"
  expected="$(printf '%s\n' \
    '-tauri-build = { version = "=2.6.3" }' \
    '+tauri-build = { version = "=2.6.3", features = [] }' \
    '-tauri = { version = "=2.11.5" }' \
    '+tauri = { version = "=2.11.5", features = [] }')"
  if [[ "$changed" == "$expected" ]]; then
    echo "Removing Tauri's generated empty feature-list changes from Cargo.toml."
    git -C "$ROOT_DIR" restore --source=HEAD -- "$manifest"
  fi
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
  local before_build_status after_build_status
  before_build_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
  export VITE_APP_VERSION="$(application_version)"
  export VITE_APP_VERSION_DISPLAY="$(application_version_display)"
  cmd_install
  install_desktop_system_dependencies
  ensure_rust
  install_desktop_node_dependencies
  npm run build --prefix "$ROOT_DIR/fileapi_ui"
  (
    cd "$ROOT_DIR/fileapi_ui/src-tauri"
    cargo check --locked
  )
  (
    cd "$ROOT_DIR/fileapi_ui"
    npm run tauri build -- --config "{\"version\":\"$VITE_APP_VERSION\"}"
  )
  normalize_generated_tauri_changes
  local deb_dir="$ROOT_DIR/fileapi_ui/src-tauri/target/release/bundle/deb"
  local deb_file
  shopt -s nullglob
  for deb_file in "$deb_dir"/*.deb; do
    local normalized_name
    normalized_name="$(basename "$deb_file" | tr ' ' '-')"
    [[ "$deb_file" == "$deb_dir/$normalized_name" ]] || mv "$deb_file" "$deb_dir/$normalized_name"
  done
  shopt -u nullglob
  after_build_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)"
  if [[ "$after_build_status" != "$before_build_status" ]]; then
    echo "Build created uncommitted files in the repository; refusing to continue." >&2
    git -C "$ROOT_DIR" status --short >&2
    exit 1
  fi
  echo "DEB packages are in fileapi_ui/src-tauri/target/release/bundle/deb/."
}

cmd_test() {
  if ! find "$ROOT_DIR" \
    -path "$ROOT_DIR/node_modules" -prune -o \
    -path "$ROOT_DIR/fileapi_ui/node_modules" -prune -o \
    -type f -name '*.test.js' -print -quit | grep -q .; then
    echo "No backend test files were found under $ROOT_DIR; refusing to report a false pass." >&2
    return 1
  fi
  npm test --prefix "$ROOT_DIR"
}

has_blocking_worktree_changes() {
  local line status path
  while IFS= read -r line; do
    status="${line:0:2}"
    path="${line:3}"
    if [[ "$status" == "??" ]]; then
      case "$path" in
        *.log-*|*.log.*) continue ;;
      esac
    fi
    return 0
  done < <(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)
  return 1
}

preflight_upstream() {
  local upstream_head="$1"
  local checkout old_root
  checkout="$(mktemp -d)"
  old_root="$ROOT_DIR"

  cleanup_preflight() {
    ROOT_DIR="$old_root"
    git -C "$old_root" worktree remove --force "$checkout" >/dev/null 2>&1 || true
    rmdir "$checkout" >/dev/null 2>&1 || true
  }

  if ! git -C "$old_root" worktree add --detach "$checkout" "$upstream_head"; then
    cleanup_preflight
    return 1
  fi

  echo "Upgrade: validating dependencies and tests before changing the active checkout..."
  ROOT_DIR="$checkout"
  if ! ensure_node || ! install_server_node_dependencies || ! cmd_test; then
    cleanup_preflight
    echo "Upgrade preflight failed; the active checkout was not changed." >&2
    return 1
  fi

  cleanup_preflight
}

cmd_upgrade() {
  git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1 || { echo "upgrade requires a Git checkout." >&2; exit 1; }
  normalize_generated_tauri_changes
  if [[ "${SELF_UPDATE_BOOTSTRAPPED:-0}" -ne 1 ]] && has_blocking_worktree_changes; then
    echo "Refusing to update a working tree with uncommitted changes." >&2
    echo "Keep ignored .env and src/config.ini, but restore any accidentally moved tracked files before retrying:" >&2
    echo "  git restore --source=HEAD -- package-lock.json start.sh stop.sh status.sh" >&2
    exit 1
  fi
  local target_version
  echo "Upgrade: fetching upstream changes..."
  run_git -C "$ROOT_DIR" fetch origin
  echo "Upgrade: checking the upstream application version..."
  target_version="$(target_application_version)"
  echo "Upgrade: upstream application version is $target_version."
  confirm_configuration_upgrade "$target_version"
  local legacy_config=""
  if [[ ! -f "$ROOT_DIR/.env" && -f "$ROOT_DIR/src/config.ini" ]]; then
    legacy_config="$(mktemp)"
    cp "$ROOT_DIR/src/config.ini" "$legacy_config"
  fi
  if [[ ! -d "$ROOT_DIR/node_modules" ]] || ! (cd "$ROOT_DIR" && node -e 'require.resolve("sqlite3")' >/dev/null 2>&1); then
    echo "Upgrade: installing server dependencies before the database backup..."
    cmd_install
  fi
  echo "Upgrade: backing up the database..."
  backup_database_before_upgrade
  echo "Upgrade: applying a fast-forward update..."
  local upstream_ref local_head upstream_head
  upstream_ref="$(get_upstream_ref)"
  upstream_head="$(git -C "$ROOT_DIR" rev-parse "$upstream_ref")"
  preflight_upstream "$upstream_head"
  run_git -C "$ROOT_DIR" merge --ff-only "$upstream_ref"
  local_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [[ "$local_head" == "$upstream_head" ]] || {
    echo "Upgrade failed: local HEAD $local_head does not match upstream $upstream_head after merge." >&2
    exit 1
  }
  if [[ -f "$ROOT_DIR/src/config.ini" ]]; then
    echo "Upgrade: applying configuration migration..."
    if [[ "$INTERACTIVE_UPGRADE" -eq 1 ]]; then
      node "$ROOT_DIR/upgrade_tools/config-upgrade.js" --target-version "$target_version"
    else
      node "$ROOT_DIR/upgrade_tools/config-upgrade.js" --target-version "$target_version" --non-interactive
    fi
  fi
  echo "Upgrade: installing dependencies..."
  cmd_install
  migrate_legacy_configuration "$legacy_config"
  [[ -z "$legacy_config" ]] || rm -f "$legacy_config"
  setup_configuration
  echo "Upgrade: running database migrations..."
  run_database_migrations
  echo "Upgrade: running backend tests..."
  cmd_test
  echo "Upgrade complete. Start the service with ./start.sh."
}

configure_proxy
case "$COMMAND" in
  install) cmd_install ;;
  setup) cmd_setup ;;
  build) cmd_build ;;
  test) cmd_test ;;
  upgrade) cmd_upgrade ;;
  self-update) self_update ;;
  help|"") usage ;;
  *) usage >&2; exit 2 ;;
esac
