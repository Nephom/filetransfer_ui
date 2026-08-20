#!/usr/bin/env bash

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
CONFIG_FILE="$PROJECT_ROOT/src/config.ini"
PID_FILE="$PROJECT_ROOT/server.pid"
LOCK_FILE="$PROJECT_ROOT/server.lock"
LOG_FILE="$PROJECT_ROOT/server.log"

read_env_value() {
  local key="$1"
  local value=""
  if [[ -f "$ENV_FILE" ]]; then
    value="$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tail -n1)"
    value="${value#\"}"
    value="${value%\"}"
  fi
  printf '%s' "$value"
}

read_ini_value() {
  local key="$1"
  local value=""
  if [[ -f "$CONFIG_FILE" ]]; then
    value="$(grep "^${key}=" "$CONFIG_FILE" 2>/dev/null | cut -d'=' -f2- | tail -n1 | tr -d ' \r\n')"
  fi
  printf '%s' "$value"
}

server_port() {
  local port
  port="$(read_env_value SERVER_PORT)"
  [[ -n "$port" ]] || port="$(read_ini_value port)"
  printf '%s' "${port:-9400}"
}

https_port() {
  local port
  # Keep the same precedence as the backend: .env first, then config.ini.
  # HTTPS_PORT is accepted as a legacy alias for SSL_HTTPS_PORT.
  port="$(read_env_value SSL_HTTPS_PORT)"
  [[ -n "$port" ]] || port="$(read_env_value HTTPS_PORT)"
  [[ -n "$port" ]] || port="$(read_ini_value httpsPort)"
  printf '%s' "${port:-9443}"
}

storage_path() {
  local path
  path="$(read_env_value FILESYSTEM_STORAGE_PATH)"
  [[ -n "$path" ]] || path="$(read_ini_value storagePath)"
  path="${path:-./storage}"
  if [[ "$path" != /* ]]; then
    path="$PROJECT_ROOT/${path#./}"
  fi
  printf '%s' "$path"
}

port_pid() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v port=":$port" '$4 ~ port { split($7, parts, "/"); print parts[1]; exit }'
  fi
}

pid_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}
