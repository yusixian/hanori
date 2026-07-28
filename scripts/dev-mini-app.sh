#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_NAME="cos-bot-dev"
PUBLIC_ORIGIN="${COS_TOOL_BOT_MINI_APP_ORIGIN:-https://tg-test.example.invalid}"
PANEL_PORT="${COS_TOOL_BOT_MINI_APP_PANEL_PORT:-5174}"
PERSISTENT_TUNNEL_CONFIG="$HOME/.cloudflared/cos-tool-bot-tg-test.yml"
TEMPORARY_TUNNEL_CONFIG="/private/tmp/cos-tool-bot-telegram-mini-app-cloudflared.yml"
if [[ -n "${COS_TOOL_BOT_TUNNEL_CONFIG:-}" ]]; then
  TUNNEL_CONFIG="$COS_TOOL_BOT_TUNNEL_CONFIG"
elif [[ -f "$PERSISTENT_TUNNEL_CONFIG" ]]; then
  TUNNEL_CONFIG="$PERSISTENT_TUNNEL_CONFIG"
elif [[ -f "$TEMPORARY_TUNNEL_CONFIG" ]]; then
  TUNNEL_CONFIG="$TEMPORARY_TUNNEL_CONFIG"
else
  TUNNEL_CONFIG="$PERSISTENT_TUNNEL_CONFIG"
fi
RUNTIME_DIR="/tmp/cos-tool-bot-mini-app-dev-$UID"
SUPERVISOR_PID_FILE="$RUNTIME_DIR/supervisor.pid"
CONCURRENTLY_PID=""

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
COMPOSE=(docker compose -p "$PROJECT_NAME" -f "$REPO_ROOT/docker-compose.dev.yml")

usage() {
  cat <<'EOF'
用法：
  pnpm dev:mini-app          启动 DB、迁移、Server、Vite 与 Cloudflare Tunnel
  pnpm dev:mini-app:stop     停止本脚本启动的进程与 dev Compose 服务
  pnpm dev:mini-app:status   查看统一开发环境状态

可选环境变量：
  COS_TOOL_BOT_TUNNEL_CONFIG          cloudflared 配置文件路径
  COS_TOOL_BOT_MINI_APP_ORIGIN        Mini App HTTPS origin
  COS_TOOL_BOT_MINI_APP_PANEL_PORT    Vite 端口，默认 5174
  MINI_APP_SESSION_SECRET             固定本次开发 session secret；未设置时自动生成
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

read_supervisor_pid() {
  [[ -f "$SUPERVISOR_PID_FILE" ]] || return 1

  local pid
  pid="$(tr -d '[:space:]' <"$SUPERVISOR_PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$pid"
}

is_managed_supervisor() {
  local pid="$1"
  local command

  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$(basename -- "$SCRIPT_PATH") start"* ]]
}

remove_stale_pid_file() {
  local pid
  pid="$(read_supervisor_pid || true)"
  if [[ -n "$pid" ]] && is_managed_supervisor "$pid"; then
    return
  fi
  rm -f "$SUPERVISOR_PID_FILE"
}

read_tunnel_id() {
  local config="$1"
  awk '$1 == "tunnel:" { print $2; exit }' "$config"
}

conflicting_tunnel_pids() {
  local command config pid process_config process_tunnel_id status target_tunnel_id
  local pids=""

  config="$TUNNEL_CONFIG"
  target_tunnel_id="$(read_tunnel_id "$config")"
  [[ -n "$target_tunnel_id" ]] || return 2

  set +e
  pids="$(pgrep -x cloudflared 2>/dev/null)"
  status=$?
  set -e

  case "$status" in
    0) ;;
    1) return 0 ;;
    *) return "$status" ;;
  esac

  for pid in $pids; do
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$command" == *"tunnel"*"run"* ]] || continue

    if [[ "$command" == *"$target_tunnel_id"* ]]; then
      printf '%s\n' "$pid"
      continue
    fi

    process_config="$(
      printf '%s\n' "$command" |
        sed -E -n 's/.*--config(=|[[:space:]]+)([^[:space:]]+).*/\2/p'
    )"
    [[ -n "$process_config" && -r "$process_config" ]] || continue
    process_tunnel_id="$(read_tunnel_id "$process_config")"
    if [[ "$process_tunnel_id" == "$target_tunnel_id" ]]; then
      printf '%s\n' "$pid"
    fi
  done
}

ensure_port_available() {
  local port="$1"
  local label="$2"
  local listeners

  command -v lsof >/dev/null 2>&1 || return
  listeners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$listeners" ]]; then
    printf '%s\n' "$listeners" >&2
    fail "$label 端口 $port 已被占用；请先停止旧的手工开发进程。"
  fi
}

wait_for_database() {
  local attempt
  for attempt in {1..30}; do
    if "${COMPOSE[@]}" exec -T db pg_isready -U bot -d cos_tool_bot >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  fail "开发数据库在 30 秒内没有就绪。"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP

  if [[ -n "$CONCURRENTLY_PID" ]] && kill -0 "$CONCURRENTLY_PID" 2>/dev/null; then
    kill -TERM "$CONCURRENTLY_PID" 2>/dev/null || true
    wait "$CONCURRENTLY_PID" 2>/dev/null || true
  fi

  printf '\n正在停止本项目的 dev Compose 服务...\n'
  "${COMPOSE[@]}" stop >/dev/null 2>&1 || true
  rm -f "$SUPERVISOR_PID_FILE"
  printf '本地 Mini App 开发环境已停止；数据库 volume 已保留。\n'
  exit "$exit_code"
}

start_environment() {
  local existing_pid existing_tunnels session_secret tunnel_command

  command -v docker >/dev/null 2>&1 || fail "没有找到 docker。"
  command -v pnpm >/dev/null 2>&1 || fail "没有找到 pnpm。"
  command -v cloudflared >/dev/null 2>&1 || fail "没有找到 cloudflared。"
  command -v pgrep >/dev/null 2>&1 || fail "没有找到 pgrep。"
  command -v openssl >/dev/null 2>&1 || fail "没有找到 openssl。"
  docker compose version >/dev/null 2>&1 || fail "没有找到 Docker Compose 插件。"
  [[ -f "$TUNNEL_CONFIG" ]] || fail "找不到 tunnel 配置：$TUNNEL_CONFIG"
  [[ "$PUBLIC_ORIGIN" =~ ^https://[^/]+$ ]] ||
    fail "Mini App origin 必须是无路径、无末尾斜杠的 HTTPS origin。"
  [[ "$PANEL_PORT" =~ ^[0-9]+$ ]] || fail "Panel 端口必须是数字。"
  ((10#$PANEL_PORT >= 1 && 10#$PANEL_PORT <= 65535)) || fail "Panel 端口超出有效范围。"

  mkdir -p "$RUNTIME_DIR"
  chmod 700 "$RUNTIME_DIR"
  remove_stale_pid_file
  existing_pid="$(read_supervisor_pid || true)"
  [[ -z "$existing_pid" ]] || fail "开发环境已由 PID $existing_pid 运行。"

  if ! existing_tunnels="$(conflicting_tunnel_pids)"; then
    fail "无法检查现有 cloudflared 进程。"
  fi
  if [[ -n "$existing_tunnels" ]]; then
    printf '检测到当前 named tunnel 已有 connector PID：%s\n' \
      "$(printf '%s' "$existing_tunnels" | tr '\n' ' ')" >&2
    fail "请先确认并停止旧 connector，避免同一 named tunnel 使用冲突的 ingress。"
  fi

  ensure_port_available 3000 "Server"
  ensure_port_available "$PANEL_PORT" "Panel"

  printf '%s\n' "$$" >"$SUPERVISOR_PID_FILE"
  chmod 600 "$SUPERVISOR_PID_FILE"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  cd "$REPO_ROOT"
  printf '正在启动开发数据库...\n'
  "${COMPOSE[@]}" up -d
  wait_for_database

  printf '正在运行数据库迁移...\n'
  pnpm db:migrate

  session_secret="${MINI_APP_SESSION_SECRET:-}"
  if [[ -z "$session_secret" ]]; then
    session_secret="$(openssl rand -hex 32)"
  fi

  export BETTER_AUTH_URL="$PUBLIC_ORIGIN"
  export MINI_APP_SESSION_SECRET="$session_secret"
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="${PUBLIC_ORIGIN#https://}"
  printf -v tunnel_command 'cloudflared --config %q tunnel run' "$TUNNEL_CONFIG"

  printf '\n本地 Mini App 开发环境正在启动：\n'
  printf '  Panel:  http://127.0.0.1:%s\n' "$PANEL_PORT"
  printf '  Public: %s\n' "$PUBLIC_ORIGIN"
  printf '  Stop:   pnpm dev:mini-app:stop，或在当前终端按 Ctrl-C\n\n'

  pnpm exec concurrently \
    --names server,panel,tunnel \
    --prefix-colors cyan,magenta,yellow \
    --kill-others \
    --kill-timeout 8000 \
    "pnpm --filter @cos-tool-bot/server dev" \
    "pnpm --filter @cos-tool-bot/panel exec vite --port $PANEL_PORT --strictPort --host 127.0.0.1" \
    "$tunnel_command" &
  CONCURRENTLY_PID=$!
  wait "$CONCURRENTLY_PID"
}

stop_environment() {
  local pid attempt

  pid="$(read_supervisor_pid || true)"
  if [[ -n "$pid" ]] && is_managed_supervisor "$pid"; then
    printf '正在停止统一开发进程 PID %s...\n' "$pid"
    kill -TERM "$pid"
    for attempt in {1..50}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$pid" 2>/dev/null && fail "进程 $pid 未能在 10 秒内退出，请查看启动终端。"
  else
    printf '没有检测到由统一脚本管理的前台进程。\n'
    rm -f "$SUPERVISOR_PID_FILE"
  fi

  "${COMPOSE[@]}" stop
  printf '本项目的本地开发服务已停止；数据库 volume 已保留。\n'
}

show_status() {
  local pid tunnels

  pid="$(read_supervisor_pid || true)"
  if [[ -n "$pid" ]] && is_managed_supervisor "$pid"; then
    printf '统一开发进程：运行中（PID %s）\n' "$pid"
  else
    printf '统一开发进程：未运行\n'
  fi

  printf '\nDev Compose：\n'
  "${COMPOSE[@]}" ps 2>/dev/null || printf '无法读取 Docker Compose 状态。\n'

  printf '\nCloudflare Tunnel：\n'
  if [[ ! -r "$TUNNEL_CONFIG" ]]; then
    printf '配置文件不存在：%s\n' "$TUNNEL_CONFIG"
  elif tunnels="$(conflicting_tunnel_pids)"; then
    if [[ -n "$tunnels" ]]; then
      printf '当前 named tunnel connector PID：%s\n' "$(printf '%s' "$tunnels" | tr '\n' ' ')"
    else
      printf '未运行\n'
    fi
  else
    printf '无法检查进程列表\n'
  fi

  printf '\nHTTP：\n'
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    printf 'Server :3000：健康\n'
  else
    printf 'Server :3000：不可用\n'
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:$PANEL_PORT" >/dev/null 2>&1; then
    printf 'Panel  :%s：可用\n' "$PANEL_PORT"
  else
    printf 'Panel  :%s：不可用\n' "$PANEL_PORT"
  fi
}

case "${1:-start}" in
  start) start_environment ;;
  stop) stop_environment ;;
  status) show_status ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
