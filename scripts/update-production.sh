#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_NAME="${DEPLOY_PROJECT_NAME:-cos-bot-prod}"
BRANCH="main"
BACKUP_DIR="${DEPLOY_BACKUP_DIR:-${COS_BOT_BACKUP_DIR:-$HOME/cos-tool-bot-backups}}"
REMOTE="${DEPLOY_REMOTE:-origin}"
VERSION=""
DEPLOYED_MARKER="$BACKUP_DIR/last-deployed-commit"
FORCE=0

usage() {
  cat <<'EOF'
用法：
  ./scripts/update-production.sh          拉取 main，有更新时备份并部署
  ./scripts/update-production.sh --force  即使代码未更新也重新备份并部署
  ./scripts/update-production.sh --version vX.Y.Z  部署远程已发布 tag，使用 detached HEAD

可选环境变量：
  COS_BOT_BACKUP_DIR=/path/to/backups      修改数据库备份目录
  DEPLOY_BACKUP_DIR=/path/to/backups       通用备份目录（优先于旧变量）
  DEPLOY_PROJECT_NAME=cos-bot-prod          已有实例保持原项目名，避免创建空 volume
  DEPLOY_REMOTE=origin                    获取版本的远程名称

.env 可选功能：
  COMPOSE_PROFILES=coding                  部署 Pi worker 与出口代理
  CODING_WORKER_SECRET=<随机值>             启用 coding profile 时必须填写
  GITHUB_APP_*                             五项必须全填或全空
EOF
}

fail() {
  printf '\n错误：%s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n[%s/7] %s\n' "$1" "$2"
}

compose_environment() {
  local output
  output="$("${COMPOSE[@]}" config --environment)" || fail "无法读取 Docker Compose 环境变量。"
  printf '%s' "$output"
}

environment_value() {
  local environment="$1"
  local name="$2"
  local line

  line="$(printf '%s\n' "$environment" | grep -m 1 -E "^${name}=" || true)"
  if [[ -n "$line" ]]; then
    printf '%s' "${line#*=}"
  fi
  return 0
}

validate_optional_github_app() {
  local environment="$1"
  local configured=0
  local name value
  local -a variables=(
    GITHUB_APP_ID
    GITHUB_APP_CLIENT_ID
    GITHUB_APP_CLIENT_SECRET
    GITHUB_APP_PRIVATE_KEY
    GITHUB_APP_SLUG
  )
  local -a missing=()

  for name in "${variables[@]}"; do
    value="$(environment_value "$environment" "$name")"
    if [[ -n "$value" ]]; then
      configured=$((configured + 1))
    else
      missing+=("$name")
    fi
  done

  if [[ "$configured" -eq 0 ]]; then
    printf '提示：GitHub App 尚未配置，管理面板中的 GitHub 授权功能将不可用。\n'
    return
  fi

  if [[ "${#missing[@]}" -gt 0 ]]; then
    fail "GitHub App 只配置了一部分。请补齐这些变量后重试：${missing[*]}（变量值不会显示）"
  fi

  printf 'GitHub App 的五项环境变量已完整配置（变量值不会显示）。\n'
}

detect_coding_profile() {
  local environment="$1"
  local services secret

  services="$("${COMPOSE[@]}" config --services)" || fail "无法读取 Docker Compose 服务列表。"
  secret="$(environment_value "$environment" CODING_WORKER_SECRET)"
  if ! grep -qx 'coding-worker' <<<"$services"; then
    [[ -z "$secret" ]] ||
      fail "CODING_WORKER_SECRET 已填写，但 coding profile 未启用。请在 .env 设置 COMPOSE_PROFILES=coding，或清空该 secret。"
    CODING_PROFILE_ENABLED=0
    printf 'Pi coding profile 未启用；本次只部署主应用。\n'
    return
  fi

  [[ -n "$secret" ]] ||
    fail "已启用 coding profile，但 CODING_WORKER_SECRET 为空。请先执行 openssl rand -hex 32 并写入 .env。"

  CODING_PROFILE_ENABLED=1
  printf 'Pi coding profile 已启用；将同时部署 worker 和出口代理。\n'
}

coding_service_container_ids() {
  local service="$1"
  docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.service=$service"
}

verify_coding_services_removed() {
  local service ids
  local -a remaining=()

  for service in coding-worker coding-egress-proxy; do
    ids="$(coding_service_container_ids "$service")" ||
      fail "无法检查已禁用的 $service 容器。"
    [[ -z "$ids" ]] || remaining+=("$service")
  done

  [[ "${#remaining[@]}" -eq 0 ]] ||
    fail "coding profile 已禁用，但这些容器仍然存在：${remaining[*]}"
}

remove_disabled_coding_services() {
  local service ids

  for service in coding-worker coding-egress-proxy; do
    ids="$(coding_service_container_ids "$service")" ||
      fail "无法检查待清理的 $service 容器。"
    [[ -n "$ids" ]] || continue

    "${COMPOSE[@]}" stop "$service" || fail "停止已禁用的 $service 失败。"
    "${COMPOSE[@]}" rm -f "$service" || fail "删除已禁用的 $service 失败。"
  done

  verify_coding_services_removed
  printf '已确认禁用的 Pi worker 和出口代理容器均不存在。\n'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --version)
      [[ $# -ge 2 && -z "$VERSION" ]] || fail "--version 需要且只能填写一个 vX.Y.Z tag。"
      VERSION="$2"
      [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "版本必须为 vX.Y.Z。"
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "DEPLOY_PROJECT_NAME 不是有效的 Compose 项目名。"
[[ "$REMOTE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail "DEPLOY_REMOTE 不是有效的远程名称。"

command -v git >/dev/null 2>&1 || fail "没有找到 git。"
command -v docker >/dev/null 2>&1 || fail "没有找到 docker。"
docker compose version >/dev/null 2>&1 || fail "没有找到 Docker Compose 插件。"
docker info >/dev/null 2>&1 || fail "Docker 没有运行，或当前用户没有 Docker 权限。"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
cd "$REPO_ROOT"

[[ "$(git rev-parse --show-toplevel)" == "$REPO_ROOT" ]] || fail "脚本不在仓库根目录中。"
if [[ -z "$VERSION" ]]; then
  [[ "$(git branch --show-current)" == "$BRANCH" ]] || fail "跟随 main 更新需要位于 main 分支；发布版升级请使用 --version。"
fi
[[ -z "$(git status --porcelain)" ]] || fail "仓库存在未提交文件。请先处理 git status 显示的内容。"
git remote get-url "$REMOTE" >/dev/null 2>&1 || fail "仓库没有指定的远程地址。"

step 1 "检查远程更新"
if [[ -n "$VERSION" ]]; then
  git fetch --no-tags "$REMOTE" "refs/tags/$VERSION"
  TARGET_COMMIT="$(git rev-parse 'FETCH_HEAD^{commit}')"
else
  git fetch "$REMOTE" "refs/heads/$BRANCH"
  TARGET_COMMIT="$(git rev-parse 'FETCH_HEAD^{commit}')"
fi

CURRENT_COMMIT="$(git rev-parse HEAD)"
CURRENT_SHORT="$(git rev-parse --short "$CURRENT_COMMIT")"
TARGET_SHORT="$(git rev-parse --short "$TARGET_COMMIT")"
DEPLOYED_COMMIT=""

if [[ -f "$DEPLOYED_MARKER" ]]; then
  DEPLOYED_COMMIT="$(tr -d '[:space:]' <"$DEPLOYED_MARKER")"
fi

if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" && "$DEPLOYED_COMMIT" == "$TARGET_COMMIT" && "$FORCE" -eq 0 ]]; then
  if [[ -n "$VERSION" ]]; then
    git checkout --detach "$TARGET_COMMIT"
  fi
  printf '当前已经是最新版本 %s，无需部署。\n' "$CURRENT_SHORT"
  exit 0
fi

if [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]]; then
  git merge-base --is-ancestor "$CURRENT_COMMIT" "$TARGET_COMMIT" ||
    fail "目标版本不是当前代码的向前升级。脚本不自动降级、跨历史迁移或覆盖本地提交。"

  printf '准备更新：%s -> %s\n' "$CURRENT_SHORT" "$TARGET_SHORT"
  git log --oneline --no-decorate "$CURRENT_COMMIT..$TARGET_COMMIT"
else
  if [[ "$FORCE" -eq 1 ]]; then
    printf '当前版本 %s，将执行强制重新部署。\n' "$CURRENT_SHORT"
  else
    printf '代码已经是 %s，但没有成功部署记录，将继续部署。\n' "$CURRENT_SHORT"
  fi
fi

COMPOSE=(
  docker compose -p "$PROJECT_NAME"
  -f docker-compose.yml
  -f docker-compose.direct.yml
)
"${COMPOSE[@]}" config --quiet
COMPOSE_ENVIRONMENT="$(compose_environment)"
validate_optional_github_app "$COMPOSE_ENVIRONMENT"
CODING_PROFILE_ENABLED=0
detect_coding_profile "$COMPOSE_ENVIRONMENT"
"${COMPOSE[@]}" exec -T db pg_isready -U bot -d cos_tool_bot >/dev/null 2>&1 ||
  fail "生产数据库没有运行。请先执行 docker compose -p $PROJECT_NAME ps。"

step 2 "备份数据库"
umask 077
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/cos_tool_bot_before_${TARGET_SHORT}_${TIMESTAMP}.dump"

if ! "${COMPOSE[@]}" exec -T db pg_dump -U bot -d cos_tool_bot -Fc >"$BACKUP_PATH"; then
  rm -f "$BACKUP_PATH"
  fail "数据库备份失败，部署已停止。"
fi

if [[ ! -s "$BACKUP_PATH" ]] ||
  ! "${COMPOSE[@]}" exec -T db pg_restore --list <"$BACKUP_PATH" >/dev/null; then
  rm -f "$BACKUP_PATH"
  fail "数据库备份无法验证，部署已停止。"
fi

printf '备份完成：%s\n' "$BACKUP_PATH"

step 3 "更新到目标版本"
INFRA_CHANGED=0
CHANGE_BASE="$CURRENT_COMMIT"

if [[ -z "$DEPLOYED_COMMIT" ]]; then
  INFRA_CHANGED=1
elif git cat-file -e "$DEPLOYED_COMMIT^{commit}" 2>/dev/null &&
  git merge-base --is-ancestor "$DEPLOYED_COMMIT" "$TARGET_COMMIT"; then
  CHANGE_BASE="$DEPLOYED_COMMIT"
else
  INFRA_CHANGED=1
fi

if [[ -n "$VERSION" ]]; then
  git checkout --detach "$TARGET_COMMIT"
elif [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]]; then
  git merge --ff-only "$TARGET_COMMIT"
fi

git diff --quiet "$CHANGE_BASE" "$TARGET_COMMIT" -- \
  docker-compose.yml docker-compose.direct.yml || INFRA_CHANGED=1

[[ "$(git rev-parse HEAD)" == "$TARGET_COMMIT" ]] || fail "代码没有更新到预期版本。"

step 4 "检查新版本配置"
"${COMPOSE[@]}" config --quiet
COMPOSE_ENVIRONMENT="$(compose_environment)"
validate_optional_github_app "$COMPOSE_ENVIRONMENT"
detect_coding_profile "$COMPOSE_ENVIRONMENT"

LEGACY_PIXAI_PENDING="$("${COMPOSE[@]}" exec -T db \
  psql -U bot -d cos_tool_bot -Atc \
  "SELECT CASE WHEN to_regclass('public.pixai_generations') IS NULL THEN 0 ELSE (SELECT count(*) FROM pixai_generations WHERE status = 'pending') END" \
  2>/dev/null)" || fail "无法检查旧 PixAI pending 任务，部署已停止。"
[[ "$LEGACY_PIXAI_PENDING" == "0" ]] || \
  fail "检测到 $LEGACY_PIXAI_PENDING 个旧 PixAI pending 任务。请先处理这些任务，再部署 MCP 生图版本。"

step 5 "构建应用与已启用的附加服务"
BUILD_SERVICES=(app)
if [[ "$CODING_PROFILE_ENABLED" -eq 1 ]]; then
  BUILD_SERVICES+=(coding-egress-proxy coding-worker)
fi
"${COMPOSE[@]}" build "${BUILD_SERVICES[@]}"

step 6 "启动新版本"
if [[ "$CODING_PROFILE_ENABLED" -eq 0 ]]; then
  remove_disabled_coding_services
fi
if [[ "$INFRA_CHANGED" -eq 1 ]]; then
  printf '首次运行脚本或检测到 docker-compose.yml 有变化，将应用完整 Compose 配置。\n'
  "${COMPOSE[@]}" up -d
elif [[ "$CODING_PROFILE_ENABLED" -eq 1 ]]; then
  "${COMPOSE[@]}" up -d app coding-egress-proxy coding-worker
else
  "${COMPOSE[@]}" up -d --no-deps app
fi

step 7 "等待健康检查"
HEALTHY=0
for ((attempt = 1; attempt <= 60; attempt++)); do
  if "${COMPOSE[@]}" exec -T app \
    wget --spider -q http://localhost:3000/api/health/ready >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'

if [[ "$HEALTHY" -ne 1 ]]; then
  "${COMPOSE[@]}" logs --tail=120 app >&2 || true
  fail "新版本在 120 秒内没有通过健康检查。数据库备份位于 $BACKUP_PATH"
fi

if [[ "$CODING_PROFILE_ENABLED" -eq 1 ]]; then
  CODING_HEALTHY=0
  for ((attempt = 1; attempt <= 60; attempt++)); do
    WORKER_ID="$("${COMPOSE[@]}" ps -q coding-worker)"
    PROXY_ID="$("${COMPOSE[@]}" ps -q coding-egress-proxy)"
    if [[ -n "$WORKER_ID" && -n "$PROXY_ID" ]] &&
      [[ "$(docker inspect --format '{{.State.Health.Status}}' "$WORKER_ID" 2>/dev/null)" == "healthy" ]] &&
      [[ "$(docker inspect --format '{{.State.Health.Status}}' "$PROXY_ID" 2>/dev/null)" == "healthy" ]]; then
      CODING_HEALTHY=1
      break
    fi
    printf '.'
    sleep 2
  done
  printf '\n'

  if [[ "$CODING_HEALTHY" -ne 1 ]]; then
    "${COMPOSE[@]}" logs --tail=120 coding-worker coding-egress-proxy >&2 || true
    fail "Pi coding worker 或出口代理在 120 秒内没有通过健康检查。"
  fi

  "${COMPOSE[@]}" ps app db coding-worker coding-egress-proxy
else
  verify_coding_services_removed
  "${COMPOSE[@]}" ps app db
fi
MARKER_TMP="$DEPLOYED_MARKER.tmp"
printf '%s\n' "$TARGET_COMMIT" >"$MARKER_TMP"
mv "$MARKER_TMP" "$DEPLOYED_MARKER"
printf '\n部署成功：%s\n数据库备份：%s\n' "$TARGET_SHORT" "$BACKUP_PATH"
