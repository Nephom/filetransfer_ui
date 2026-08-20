#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT_DIR/scripts/runtime.sh"

HTTP_PORT="$(server_port)"
HTTPS_PORT="$(https_port)"
STORAGE_PATH="$(storage_path)"
PID=""
[[ -f "$PID_FILE" ]] && PID="$(cat "$PID_FILE")"

if pid_is_running "$PID"; then
  echo "Service: running (PID $PID)"
else
  LISTENER_PID="$(port_pid "$HTTP_PORT")"
  [[ -n "$LISTENER_PID" ]] || LISTENER_PID="$(port_pid "$HTTPS_PORT")"
  if [[ -n "$LISTENER_PID" ]]; then
    echo "Service: port $HTTP_PORT or $HTTPS_PORT is in use by PID $LISTENER_PID (server.pid is unavailable)"
  else
    echo "Service: stopped"
  fi
fi

echo "HTTP port: $HTTP_PORT"
echo "HTTPS port: $HTTPS_PORT"
echo "Storage path: $STORAGE_PATH"
[[ -f "$ENV_FILE" ]] && echo "Environment: $ENV_FILE" || echo "Environment: not configured"
[[ -f "$LOG_FILE" ]] && echo "Log file: $LOG_FILE" || echo "Log file: not created"

if command -v curl >/dev/null 2>&1; then
  HTTP_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://localhost:$HTTP_PORT/" || true)"
  [[ "$HTTP_STATUS" =~ ^(200|301|302)$ ]] && echo "HTTP health: $HTTP_STATUS" || echo "HTTP health: unavailable"

  HTTPS_STATUS="$(curl --silent --insecure --output /dev/null --write-out '%{http_code}' "https://localhost:$HTTPS_PORT/" || true)"
  [[ "$HTTPS_STATUS" =~ ^(200|301|302)$ ]] && echo "HTTPS health: $HTTPS_STATUS" || echo "HTTPS health: unavailable"
fi
