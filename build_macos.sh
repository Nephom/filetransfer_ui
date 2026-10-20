#!/usr/bin/env bash
set -euo pipefail

# Local macOS cross-build helper and Windows NSIS signing entry point.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$ROOT_DIR/fileapi_ui"
ASSET_ROOT="$ROOT_DIR/build-assets/webview2"
DOWNLOAD_ROOT="$ASSET_ROOT/downloads"
EXTRACT_ROOT="$ASSET_ROOT/fixed/x64"
STAGING_ROOT="$DESKTOP_ROOT/src-tauri/webview2-fixed-runtime"
DESKTOP_RUNTIME_LINK="$DESKTOP_ROOT/webview2-fixed-runtime"
WINDOWS_TARGET="x86_64-pc-windows-msvc"
WEBVIEW2_PAGE="https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
PROXY=""
PROJECT_OUTPUT_ROOT="${PROJECT_OUTPUT_ROOT:-$ROOT_DIR/build-assets}"
BUILD_CONFIG=""
BUILD_RUNTIME_LINK_CREATED=0
BUILD_CHANNEL=""
SIGNING_ROOT="${TMPDIR:-/tmp}/nfterm-self-sign-$$"
SIGNING_CERT="$SIGNING_ROOT/nfterm-self-sign.crt"
SIGNING_KEY="$SIGNING_ROOT/nfterm-self-sign.key"
SIGNING_WRAPPER="$SIGNING_ROOT/sign-binary.sh"

usage() {
  cat <<'EOF'
Usage: ./build_macos.sh <install|build [pre|ga]|help> [--proxy URL]

Commands:
  install  Install/check macOS cross-build prerequisites and Windows Rust target.
  build    Build the Windows x64 NSIS installer with an embedded fixed WebView2 runtime.
  help     Show this help.

Environment:
  WEBVIEW2_FIXED_RUNTIME_URL  Optional Microsoft CAB URL override for offline/reproducible builds.
  XWIN_CACHE_DIR              Optional cargo-xwin Windows SDK cache directory.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

cleanup_windows_build() {
  if [[ -n "$BUILD_CONFIG" ]]; then
    rm -f "$BUILD_CONFIG"
  fi
  if ((BUILD_RUNTIME_LINK_CREATED)); then
    rm -f "$DESKTOP_RUNTIME_LINK"
  fi
  rm -rf "$STAGING_ROOT"
  rm -rf "$SIGNING_ROOT"
}

cleanup_unused_build_artifacts() {
  rm -rf \
    "$DESKTOP_ROOT/src-tauri/target/debug" \
    "$DESKTOP_ROOT/src-tauri/target/$WINDOWS_TARGET/debug"
}

run() {
  printf '+ %q' "$1"
  local argument
  for argument in "${@:2}"; do
    printf ' %q' "$argument"
  done
  printf '\n'
  "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' was not found. Run './build_macos.sh install'."
}

configure_proxy() {
  [[ -z "$PROXY" ]] && return 0
  [[ "$PROXY" =~ ^https?://[^/:]+(:[0-9]+)?/?$ ]] || die "Proxy must use http://host:port or https://host:port."
  export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
  export npm_config_proxy="$PROXY" npm_config_https_proxy="$PROXY" CARGO_HTTP_PROXY="$PROXY"
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return 0
  fi
  die "Homebrew is required. Install it from https://brew.sh/ and rerun './build_macos.sh install'."
}

ensure_brew_packages() {
  local packages=(ca-certificates curl git node rustup llvm lld nsis cabextract osslsigncode openssl)
  local missing=()
  local package
  for package in "${packages[@]}"; do
    brew list --formula "$package" >/dev/null 2>&1 || missing+=("$package")
  done
  if ((${#missing[@]} > 0)); then
    run brew install "${missing[@]}"
  fi
}

ensure_node() {
  require_command node
  require_command npm
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && (b > 17 || (b === 17 && c >= 0))) ? 0 : 1)' \
    || die "Node.js 20.17.0 or newer is required."
}

ensure_rust() {
  export PATH="$(brew --prefix rustup)/bin:$(brew --prefix)/bin:$HOME/.cargo/bin:$(brew --prefix llvm)/bin:$(brew --prefix lld)/bin:$PATH"
  require_command rustup
  require_command cargo
  require_command rustc
  rustup toolchain install stable >/dev/null
  rustup target add "$WINDOWS_TARGET"
  cargo install --locked cargo-xwin
  require_command cargo-xwin
}

ensure_llvm_and_nsis() {
  export PATH="$(brew --prefix llvm)/bin:$(brew --prefix lld)/bin:$PATH"
  require_command clang
  require_command lld-link
  require_command llvm-rc
  require_command makensis
  require_command cabextract
  require_command openssl
  require_command osslsigncode
}

prepare_self_signing() {
  rm -rf "$SIGNING_ROOT"
  mkdir -p "$SIGNING_ROOT"
  run openssl req -x509 -newkey rsa:3072 -nodes \
    -keyout "$SIGNING_KEY" \
    -out "$SIGNING_CERT" \
    -days 1825 \
    -subj "/C=TW/O=NDFnet/CN=Nephom" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=codeSigning"
  chmod 600 "$SIGNING_KEY"
  cat > "$SIGNING_WRAPPER" <<'EOF'
#!/bin/sh
set -eu

input="$1"
cert="$2"
key="$3"
case "$input" in
  */webview2-fixed-runtime/*) exit 0 ;;
esac
temp="${input}.self-sign.$$"
trap 'rm -f "$temp"' EXIT

osslsigncode sign \
  -certs "$cert" \
  -key "$key" \
  -h sha256 \
  -n "nFterm" \
  -in "$input" \
  -out "$temp"
mv -f "$temp" "$input"
EOF
  chmod 700 "$SIGNING_WRAPPER"
}

verify_self_signed_binary() {
  local binary="$1"
  [[ -f "$binary" ]] || die "Expected signed binary was not produced: $binary"
  run osslsigncode verify -CAfile "$SIGNING_CERT" -in "$binary"
}

install_prerequisites() {
  ensure_homebrew
  ensure_brew_packages
  ensure_node
  ensure_rust
  ensure_llvm_and_nsis
  ensure_webview_runtime
  printf 'macOS Windows NSIS build prerequisites are ready.\n'
}

resolve_webview_url() {
  if [[ -n "${WEBVIEW2_FIXED_RUNTIME_URL:-}" ]]; then
    printf '%s\n' "$WEBVIEW2_FIXED_RUNTIME_URL"
    return 0
  fi

  require_command curl
  local page
  page="$(curl --fail --location --silent --show-error "$WEBVIEW2_PAGE")"
  node -e '
    const html = process.argv[1];
    const urls = [...html.matchAll(/https?:[^"'"'"'<> ]+FixedVersionRuntime[^"'"'"'<> ]+x64\.cab/gi)]
      .map(match => match[0].replace(/&amp;/g, "&"));
    const unique = [...new Set(urls.map(url => url
      .replace(/&amp;/g, "&")
      .replace(/\\u002f/gi, "/")))];
    if (!unique.length) process.exit(1);
    const version = url => {
      const match = url.match(/FixedVersionRuntime\.(\d+(?:\.\d+){3})\.x64\.cab/i);
      return match ? match[1].split(".").map(Number) : [0, 0, 0, 0];
    };
    unique.sort((a, b) => version(b).map((n, i) => n - version(a)[i]).find(n => n) || 0);
    process.stdout.write(unique[0] + "\n");
  ' "$page" || die "Microsoft's WebView2 page did not expose an x64 fixed-runtime CAB URL. Set WEBVIEW2_FIXED_RUNTIME_URL explicitly."
}

ensure_webview_runtime() {
  mkdir -p "$DOWNLOAD_ROOT" "$EXTRACT_ROOT"
  local url archive
  url="$(resolve_webview_url)"
  archive="$DOWNLOAD_ROOT/$(basename "${url%%\?*}")"
  [[ "$archive" == *.cab ]] || archive="$DOWNLOAD_ROOT/Microsoft.WebView2.FixedVersionRuntime.x64.cab"

  if [[ ! -s "$archive" ]]; then
    printf 'Downloading WebView2 fixed runtime CAB from Microsoft...\n'
    run curl --fail --location --retry 3 --output "$archive" "$url"
  else
    printf 'Using cached WebView2 CAB: %s\n' "$archive"
  fi

  local size magic
  size="$(stat -f '%z' "$archive")"
  ((size > 100000000)) || die "WebView2 CAB is unexpectedly small: $size bytes."
  magic="$(dd if="$archive" bs=1 count=4 2>/dev/null)"
  [[ "$magic" == "MSCF" ]] || die "Downloaded WebView2 file is not a Microsoft Cabinet archive."
  printf 'WebView2 CAB SHA-256: '
  shasum -a 256 "$archive" | cut -d ' ' -f 1

  rm -rf "$EXTRACT_ROOT"
  mkdir -p "$EXTRACT_ROOT"
  run cabextract --quiet --directory "$EXTRACT_ROOT" "$archive"
  find "$EXTRACT_ROOT" -type f -name msedgewebview2.exe -print -quit | grep -q . \
    || die "WebView2 CAB did not contain msedgewebview2.exe."

  rm -rf "$STAGING_ROOT"
  mkdir -p "$STAGING_ROOT"
  local runtime_dir
  runtime_dir="$(find "$EXTRACT_ROOT" -type f -name msedgewebview2.exe -print -quit | xargs dirname)"
  cp -R "$runtime_dir"/. "$STAGING_ROOT"/
  [[ -s "$STAGING_ROOT/msedgewebview2.exe" ]] || die "Staged WebView2 runtime is incomplete."
}

install_desktop_dependencies() {
  run npm ci --ignore-scripts --include=optional --prefix "$DESKTOP_ROOT"
  run npm rebuild --foreground-scripts --prefix "$DESKTOP_ROOT"
  node -e 'const path=require("path"); const dir=process.argv[1]; const pkg=require(path.join(dir,"package.json")); for (const name of Object.keys(pkg.dependencies)) require.resolve(name,{paths:[dir]});' "$DESKTOP_ROOT"
}

install_server_dependencies() {
  (
    cd "$ROOT_DIR" &&
      run npm ci --ignore-scripts --include=optional --include=dev &&
      run npm rebuild --foreground-scripts &&
      node -e 'for (const name of ["bcrypt", "sqlite3", "ssh2", "ws", "unrs-resolver", "esbuild"]) require.resolve(name);' &&
      run npm run check:native &&
      run npm run build:browser &&
      run npm run check:browser
  ) || return $?
}

assert_versions() {
  local expected
  expected="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")"
  node - "$expected" "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$DESKTOP_ROOT/package.json" "$DESKTOP_ROOT/package-lock.json" "$DESKTOP_ROOT/src-tauri/tauri.conf.json" "$DESKTOP_ROOT/src-tauri/Cargo.toml" "$DESKTOP_ROOT/src-tauri/Cargo.lock" <<'NODE'
const fs = require("fs");
const [expected, ...args] = process.argv.slice(2);
const cargoLockFile = args.pop();
const cargoFile = args.pop();
const files = args;
const mismatches = [];
for (const file of files) {
  const actual = JSON.parse(fs.readFileSync(file, "utf8")).version;
  if (actual !== expected) mismatches.push(`${file} = ${actual}`);
}
const cargo = fs.readFileSync(cargoFile, "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cargoVersion !== expected) mismatches.push(`Cargo.toml = ${cargoVersion || "missing"}`);
const cargoLock = fs.readFileSync(cargoLockFile, "utf8");
const lockVersion = cargoLock.match(/name\s*=\s*"nFterm"\s*\nversion\s*=\s*"([^"]+)"/)?.[1];
if (lockVersion !== expected) mismatches.push(`Cargo.lock (nFterm) = ${lockVersion || "missing"}`);
if (mismatches.length) { console.error(`Version metadata does not match VERSION (${expected}):\n - ${mismatches.join("\n - ")}`); process.exit(1); }
NODE
}

build_windows() {
  export APP_VERSION_CHANNEL="$BUILD_CHANNEL"
  local version_data
  version_data="$(node "$ROOT_DIR/scripts/version.js")"
  export VITE_APP_VERSION="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$version_data")"
  export VITE_APP_VERSION_DISPLAY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).display)' "$version_data")"

  install_prerequisites
  assert_versions
  install_desktop_dependencies
  install_server_dependencies
  run npm run build --prefix "$DESKTOP_ROOT"
  ensure_webview_runtime
  prepare_self_signing

  BUILD_CONFIG="$DESKTOP_ROOT/src-tauri/nfterm-macos-build-$$.json"
  BUILD_RUNTIME_LINK_CREATED=0
  trap cleanup_windows_build EXIT
  node - "$ROOT_DIR" "$BUILD_CONFIG" "$VITE_APP_VERSION" "$SIGNING_WRAPPER" "$SIGNING_CERT" "$SIGNING_KEY" <<'NODE'
const fs = require("fs");
const [root, output, version, signingCommand, signingCert, signingKey] = process.argv.slice(2);
const source = JSON.parse(fs.readFileSync(`${root}/fileapi_ui/src-tauri/tauri.conf.json`, "utf8"));
source.version = version;
source.bundle = source.bundle || {};
source.bundle.targets = ["nsis"];
source.bundle.resources = ["webview2-fixed-runtime"];
source.bundle.windows = source.bundle.windows || {};
source.bundle.windows.webviewInstallMode = { type: "fixedRuntime", path: "./webview2-fixed-runtime" };
source.bundle.windows.digestAlgorithm = "sha256";
source.bundle.windows.signCommand = { cmd: signingCommand, args: ["%1", signingCert, signingKey] };
fs.writeFileSync(output, JSON.stringify(source));
NODE
  if [[ -e "$DESKTOP_RUNTIME_LINK" || -L "$DESKTOP_RUNTIME_LINK" ]]; then
    [[ -L "$DESKTOP_RUNTIME_LINK" ]] || die "Refusing to replace non-symlink path: $DESKTOP_RUNTIME_LINK"
    rm -f "$DESKTOP_RUNTIME_LINK"
  fi
  ln -s "src-tauri/webview2-fixed-runtime" "$DESKTOP_RUNTIME_LINK"
  BUILD_RUNTIME_LINK_CREATED=1

  export RUSTFLAGS="${RUSTFLAGS:-} -C linker=$(brew --prefix lld)/bin/lld-link"
  (cd "$DESKTOP_ROOT" && run npm run tauri -- build --runner cargo-xwin --target "$WINDOWS_TARGET" --bundles nsis --config "$BUILD_CONFIG")

  local output="$DESKTOP_ROOT/src-tauri/target/$WINDOWS_TARGET/release/bundle/nsis"
  local installer
  installer="$(find "$output" -maxdepth 1 -type f -name '*-setup.exe' -print -quit)"
  [[ -f "$installer" ]] || die "NSIS installer was not produced under $output."
  local installer_size
  installer_size="$(stat -f '%z' "$installer")"
  ((installer_size > 100000000)) || die "NSIS installer is only $installer_size bytes; embedded WebView2 runtime is missing."
  # nFterm.exe is an intermediate input to the NSIS bundle and is not published separately.
  verify_self_signed_binary "$installer"
  mkdir -p "$PROJECT_OUTPUT_ROOT"
  mv -f "$installer" "$PROJECT_OUTPUT_ROOT/"
  rm -f "$DESKTOP_ROOT/src-tauri/target/$WINDOWS_TARGET/release/nFterm.exe"
  cleanup_unused_build_artifacts
  printf 'Windows x64 NSIS package(s):\n'
  printf '%s\n' "$PROJECT_OUTPUT_ROOT/$(basename "$installer")"
}

main() {
  local command="help"
  while (($#)); do
    case "$1" in
      install|build|help) [[ "$command" == help ]] || die "Only one command may be provided."; command="$1"; shift ;;
      pre|ga)
        [[ "$command" == "build" ]] || die "Version channel '$1' is only valid after build."
        [[ -z "$BUILD_CHANNEL" ]] || die "Only one build version channel may be provided."
        BUILD_CHANNEL="$1"
        shift
        ;;
      --proxy) (($# >= 2)) || die "--proxy requires a URL."; PROXY="$2"; shift 2 ;;
      -h|--help) command=help; shift ;;
      *) die "Unknown argument: $1" ;;
    esac
  done
  if [[ "$command" == "build" ]]; then BUILD_CHANNEL="${BUILD_CHANNEL:-pre}"; fi
  configure_proxy
  case "$command" in
    install) install_prerequisites ;;
    build) build_windows ;;
    help) usage ;;
  esac
}

main "$@"
