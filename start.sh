#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/scripts/runtime.sh"

PORT="$(server_port)"
STORAGE_PATH="$(storage_path)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run ./build.sh install first." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Node modules are missing. Run ./build.sh install or ./build.sh upgrade first." >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if pid_is_running "$PID"; then
    echo "Service is already running (PID $PID)."
    exit 1
  fi
  rm -f "$PID_FILE"
fi

LISTENER_PID="$(port_pid "$PORT")"
if [[ -n "$LISTENER_PID" ]]; then
  echo "Port $PORT is already in use by PID $LISTENER_PID." >&2
  exit 1
fi

mkdir -p "$STORAGE_PATH" "$ROOT_DIR/logs"
printf '{"pid":%s,"timestamp":"%s","initiator":"shell","method":"shell"}\n' "$$" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$LOCK_FILE"

cd "$ROOT_DIR"
nohup node --env-file-if-exists=.env src/backend/server.js > "$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"

sleep 2
if pid_is_running "$PID"; then
  echo "Service started (PID $PID, HTTP port $PORT)."
  echo "Log file: $LOG_FILE"
else
  echo "Service failed to start. Check $LOG_FILE." >&2
  rm -f "$PID_FILE"
  exit 1
fi
