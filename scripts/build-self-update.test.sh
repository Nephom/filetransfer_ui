#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

git init --bare "$TEMP_DIR/remote.git" >/dev/null
git init "$TEMP_DIR/source" >/dev/null
git -C "$TEMP_DIR/source" checkout -b main >/dev/null
git -C "$TEMP_DIR/source" config user.email self-update-test@example.invalid
git -C "$TEMP_DIR/source" config user.name self-update-test

cat > "$TEMP_DIR/source/build.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${FILETRANSFER_ROOT:?}" > "$FILETRANSFER_ROOT/self-update-root"
EOF
git -C "$TEMP_DIR/source" add build.sh
git -C "$TEMP_DIR/source" commit -m upstream >/dev/null
git -C "$TEMP_DIR/source" remote add origin "$TEMP_DIR/remote.git"
git -C "$TEMP_DIR/source" push -u origin main >/dev/null
git clone -q "$TEMP_DIR/remote.git" "$TEMP_DIR/active"
git -C "$TEMP_DIR/active" checkout -q main
cp "$ROOT_DIR/build.sh" "$TEMP_DIR/active/build.sh"
printf 'local change\n' > "$TEMP_DIR/active/local.txt"

before_hash="$(sha256sum "$TEMP_DIR/active/build.sh")"
bash "$TEMP_DIR/active/build.sh" self-update --dry-run
bash "$TEMP_DIR/active/build.sh" self-update --continue
[[ -f "$TEMP_DIR/active/self-update-root" ]]
[[ "$(cat "$TEMP_DIR/active/self-update-root")" == "$TEMP_DIR/active" ]]
[[ "$(cat "$TEMP_DIR/active/local.txt")" == 'local change' ]]
[[ "$before_hash" == "$(sha256sum "$TEMP_DIR/active/build.sh")" ]]

cat > "$TEMP_DIR/source/build.sh" <<'EOF'
#!/usr/bin/env bash
if (
EOF
git -C "$TEMP_DIR/source" add build.sh
git -C "$TEMP_DIR/source" commit -m invalid-upstream >/dev/null
git -C "$TEMP_DIR/source" push origin main >/dev/null
if bash "$TEMP_DIR/active/build.sh" self-update --dry-run; then
  echo 'Expected invalid fetched build.sh to fail syntax validation.' >&2
  exit 1
fi

echo 'build self-update tests passed.'
