set -eu

ROOT="/Users/ascopia/Project/filetransfer_ui"
UI="$ROOT/fileapi_ui"
CARGO_MANIFEST="$UI/src-tauri/Cargo.toml"

node --version
npm --version
rustc --version
cargo --version

# 安裝主專案 npm 套件，並依 package.json 同步 package-lock.json
npm install --prefix "$ROOT"

# 安裝桌面 UI npm 套件；這會納入 typescript-api alias
# 並同步 fileapi_ui/package-lock.json
npm install --prefix "$UI"

# 確認 Archiver 安全更新已實際套用
npm --prefix "$ROOT" ls archiver readdir-glob minimatch

# 確認 TypeScript CLI/API 與桌面套件都已安裝
npm --prefix "$UI" ls \
  typescript typescript-api \
  @tauri-apps/api @tauri-apps/cli \
  @tauri-apps/plugin-clipboard-manager \
  i18next react-i18next

# Cargo 先依目前 Cargo.lock 透過 sparse registry 下載。
# 若實際請求失敗，才解除本次命令的 proxy 設定直接嘗試 crates.io。
fetch_cargo() {
  if CARGO_NET_RETRY=1 \
    CARGO_HTTP_TIMEOUT=30 \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
    cargo fetch --locked --manifest-path "$CARGO_MANIFEST" "$@"
  then
    return 0
  fi

  echo "Cargo sparse/proxy fetch failed; trying direct crates.io once." >&2
  env \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    -u CARGO_HTTP_PROXY \
    CARGO_NET_RETRY=1 \
    CARGO_HTTP_TIMEOUT=30 \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
    cargo fetch --locked --manifest-path "$CARGO_MANIFEST" "$@"
}

# 下載一般與 Windows target 的 Cargo 相依
fetch_cargo
fetch_cargo --target x86_64-pc-windows-msvc

# 建置與基本驗證
npm --prefix "$ROOT" test
npm --prefix "$ROOT" run build:browser
npm --prefix "$ROOT" run check:browser
npm --prefix "$ROOT" run check:native
npm --prefix "$UI" run build
cargo check --locked --manifest-path "$CARGO_MANIFEST"

# 建立目前作業系統的 Tauri 桌面 bundle（選用完整打包驗證）
npm --prefix "$UI" run tauri -- build
