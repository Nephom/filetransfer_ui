#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/scripts/runtime.sh"

PID=""
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
fi

if ! pid_is_running "$PID"; then
  PID="$(port_pid "$(server_port)")"
fi

if [[ -z "$PID" ]]; then
  rm -f "$PID_FILE"
  echo "Service is not running."
  exit 0
fi

kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 10); do
  pid_is_running "$PID" || break
  sleep 1
done

if pid_is_running "$PID"; then
  echo "Service did not stop gracefully; sending SIGKILL." >&2
  kill -KILL "$PID" 2>/dev/null || true
fi

if pid_is_running "$PID"; then
  echo "Failed to stop PID $PID." >&2
  exit 1
fi

rm -f "$PID_FILE" "$LOCK_FILE"

mkdir -p "$(storage_path)" "$ROOT_DIR/logs"
printf '{"pid":%s,"timestamp":"%s","initiator":"shell","method":"shell"}\n' "$$" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$LOCK_FILE"

cd "$ROOT_DIR"
nohup node --env-file-if-exists=.env src/backend/server.js > "$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"

sleep 2
if pid_is_running "$PID"; then
  echo "Service started (PID $PID, HTTP port $(server_port))."
  echo "Log file: $LOG_FILE"
else
  echo "Service failed to start. Check $LOG_FILE." >&2
  rm -f "$PID_FILE"
  exit 1
fi