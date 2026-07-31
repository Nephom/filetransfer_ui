#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/scripts/runtime.sh"

PORT="$(server_port)"
STORAGE_PATH="$(storage_path)"
PID=""
[[ -f "$PID_FILE" ]] && PID="$(cat "$PID_FILE")"

if pid_is_running "$PID"; then
  echo "Service: running (PID $PID)"
else
  LISTENER_PID="$(port_pid "$PORT")"
  if [[ -n "$LISTENER_PID" ]]; then
    echo "Service: port $PORT is in use by PID $LISTENER_PID (server.pid is unavailable)"
  else
    echo "Service: stopped"
  fi
fi

echo "HTTP port: $PORT"
echo "Storage path: $STORAGE_PATH"
[[ -f "$ENV_FILE" ]] && echo "Environment: $ENV_FILE" || echo "Environment: not configured"
[[ -f "$LOG_FILE" ]] && echo "Log file: $LOG_FILE" || echo "Log file: not created"

if command -v curl >/dev/null 2>&1; then
  STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://localhost:$PORT/" || true)"
  [[ "$STATUS" =~ ^(200|301|302)$ ]] && echo "HTTP health: $STATUS" || echo "HTTP health: unavailable"
fi
