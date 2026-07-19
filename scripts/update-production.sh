#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_NAME="cos-bot-prod"
BRANCH="main"
BACKUP_DIR="${COS_BOT_BACKUP_DIR:-$HOME/cos-tool-bot-backups}"
DEPLOYED_MARKER="$BACKUP_DIR/last-deployed-commit"
FORCE=0

usage() {
  cat <<'EOF'
用法：
  ./scripts/update-production.sh          拉取 main，有更新时备份并部署
  ./scripts/update-production.sh --force  即使代码未更新也重新备份并部署

可选环境变量：
  COS_BOT_BACKUP_DIR=/path/to/backups      修改数据库备份目录
EOF
}

fail() {
  printf '\n错误：%s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n[%s/7] %s\n' "$1" "$2"
}

case "${1:-}" in
  "") ;;
  --force) FORCE=1 ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

[[ $# -le 1 ]] || {
  usage >&2
  exit 2
}

command -v git >/dev/null 2>&1 || fail "没有找到 git。"
command -v docker >/dev/null 2>&1 || fail "没有找到 docker。"
docker compose version >/dev/null 2>&1 || fail "没有找到 Docker Compose 插件。"
docker info >/dev/null 2>&1 || fail "Docker 没有运行，或当前用户没有 Docker 权限。"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

[[ "$(git rev-parse --show-toplevel)" == "$REPO_ROOT" ]] || fail "脚本不在仓库根目录中。"
[[ "$(git branch --show-current)" == "$BRANCH" ]] || fail "生产服务器必须位于 main 分支。"
[[ -z "$(git status --porcelain)" ]] || fail "仓库存在未提交文件。请先处理 git status 显示的内容。"
git remote get-url origin >/dev/null 2>&1 || fail "仓库没有 origin 远程地址。"

step 1 "检查远程更新"
git fetch --prune origin "$BRANCH"

CURRENT_COMMIT="$(git rev-parse HEAD)"
TARGET_COMMIT="$(git rev-parse "origin/$BRANCH")"
CURRENT_SHORT="$(git rev-parse --short "$CURRENT_COMMIT")"
TARGET_SHORT="$(git rev-parse --short "$TARGET_COMMIT")"
DEPLOYED_COMMIT=""

if [[ -f "$DEPLOYED_MARKER" ]]; then
  DEPLOYED_COMMIT="$(tr -d '[:space:]' <"$DEPLOYED_MARKER")"
fi

if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" && "$DEPLOYED_COMMIT" == "$TARGET_COMMIT" && "$FORCE" -eq 0 ]]; then
  printf '当前已经是最新版本 %s，无需部署。\n' "$CURRENT_SHORT"
  exit 0
fi

if [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]]; then
  git merge-base --is-ancestor "$CURRENT_COMMIT" "$TARGET_COMMIT" ||
    fail "本地 main 与 origin/main 已分叉，脚本不会自动覆盖本地提交。"

  printf '准备更新：%s -> %s\n' "$CURRENT_SHORT" "$TARGET_SHORT"
  git log --oneline --no-decorate "$CURRENT_COMMIT..$TARGET_COMMIT"
else
  if [[ "$FORCE" -eq 1 ]]; then
    printf '当前版本 %s，将执行强制重新部署。\n' "$CURRENT_SHORT"
  else
    printf '代码已经是 %s，但没有成功部署记录，将继续部署。\n' "$CURRENT_SHORT"
  fi
fi

COMPOSE=(docker compose -p "$PROJECT_NAME")
"${COMPOSE[@]}" config --quiet
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

step 3 "更新 main 分支"
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

if [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]]; then
  git merge --ff-only "origin/$BRANCH"
fi

git diff --quiet "$CHANGE_BASE" "$TARGET_COMMIT" -- docker-compose.yml || INFRA_CHANGED=1

[[ "$(git rev-parse HEAD)" == "$TARGET_COMMIT" ]] || fail "代码没有更新到预期版本。"

step 4 "检查新版本配置"
"${COMPOSE[@]}" config --quiet

step 5 "构建应用镜像"
"${COMPOSE[@]}" build app

step 6 "启动新版本"
if [[ "$INFRA_CHANGED" -eq 1 ]]; then
  printf '首次运行脚本或检测到 docker-compose.yml 有变化，将应用完整 Compose 配置。\n'
  "${COMPOSE[@]}" up -d
else
  "${COMPOSE[@]}" up -d --no-deps app
fi

step 7 "等待健康检查"
HEALTHY=0
for ((attempt = 1; attempt <= 60; attempt++)); do
  if "${COMPOSE[@]}" exec -T app \
    wget --spider -q http://localhost:3000/api/health >/dev/null 2>&1; then
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

"${COMPOSE[@]}" ps app db
MARKER_TMP="$DEPLOYED_MARKER.tmp"
printf '%s\n' "$TARGET_COMMIT" >"$MARKER_TMP"
mv "$MARKER_TMP" "$DEPLOYED_MARKER"
printf '\n部署成功：%s\n数据库备份：%s\n' "$TARGET_SHORT" "$BACKUP_PATH"
