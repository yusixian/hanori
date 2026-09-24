# Dokploy 新服务器迁移部署教程（沿用原域名）

本文用于把现有 `cos-tool-bot` 生产环境迁移到另一台由 Dokploy 管理的服务器，并继续使用原域名。迁移采用仓库根目录的 `docker-compose.yml`；旧服务器的 `scripts/update-production.sh` 和 `docker-compose.direct.yml` 保持原样。

> 本文不会要求把 secret 粘贴到聊天、Git 或命令输出中。所有密码和密钥只在旧服务器的受控环境与 Dokploy Environment 中处理。
>
> 新旧服务器绝不能同时运行同一个 Telegram Bot。重复 polling 或 webhook 消费会造成消息竞争和状态分叉。
>
> 永远不要执行 `docker compose down -v`。这会删除数据库和业务文件卷。

## 1. 迁移结果与边界

完成后应满足：

- 原域名继续作为 `BETTER_AUTH_URL`，Google/GitHub OAuth 回调地址不变。
- Dokploy 从 GitHub `main` 构建同一份 Docker Compose stack。
- `app` 只通过 Dokploy/Traefik 的 HTTPS 域名访问，不发布主机端口。
- app 启动前必须完成一次经过 `pg_restore --list` 验证的 PostgreSQL dump。
- `/api/health/ready` 只有在迁移、认证、MCP、Bot 和后台服务完成启动后才返回 200。
- `/api/health/ready` 返回构建时嵌入的 40 位 Git SHA。
- PostgreSQL dump 和文件卷具有异机/S3 备份，而不只留在新服务器本地。

本次不把 PostgreSQL 拆成 Dokploy Database，也不改造现有 update 脚本。数据库拆分和预构建 registry 镜像可以在迁移稳定后另行处理。

## 2. 迁移前需要记录的值

下面只记录变量名和存放位置，不要把真实值写入本文：

| 项目                      | 迁移要求                                             |
| ------------------------- | ---------------------------------------------------- |
| 原域名                    | 沿用；记为 `<ORIGINAL_DOMAIN>`                       |
| `ENCRYPTION_KEY`          | 必须保持原值，否则数据库中的 Bot/API 凭据无法解密    |
| `BETTER_AUTH_SECRET`      | 建议保持原值，以保留现有认证签名语义                 |
| `MINI_APP_SESSION_SECRET` | 已启用 Mini App 时保持原值                           |
| `DB_PASSWORD`             | 可换新值；它是新 PostgreSQL 容器的密码               |
| `GITHUB_APP_*`            | 五项全部迁移，或全部留空                             |
| Google OAuth              | Client ID/Secret 一起迁移；原域名不变时回调 URL 不变 |
| `CODING_WORKER_SECRET`    | 启用 coding profile 时迁移或重新生成并同步配置       |
| 当前生产 SHA              | 迁移前记录，并先让旧服务器和新服务器使用同一 SHA     |

在旧服务器仓库中记录当前提交：

```bash
cd ~/code/cos-tool-bot
git rev-parse HEAD
git status --short --branch
```

迁移期间使用下面的占位符：

```text
<TARGET_SHA>          迁移目标的完整 40 位 Git SHA
<ORIGINAL_DOMAIN>     原生产域名，不含 https://
<DOKPLOY_APP_NAME>    Dokploy 为 Compose 服务生成的 appName/项目名
<NEW_DB_CONTAINER>    新服务器 PostgreSQL 容器名
<NEW_APP_CONTAINER>   新服务器 app 容器名
<DB_BACKUP_CONTAINER> 新服务器 db-backup 容器名
<DOKPLOY_HOST>        Dokploy 控制台域名，不含 https://
<COMPOSE_ID>          Dokploy Compose 资源 ID
```

执行后续命令前，把确认过的值放进当前 shell 变量；不要保存在 shell history 会泄露的 secret：

```bash
TARGET_SHA='替换为完整 40 位 SHA'
ORIGINAL_DOMAIN='替换为原域名'
TEMP_DOMAIN='替换为 Dokploy 临时域名'
DOKPLOY_APP_NAME='替换为 Dokploy appName'
NEW_DB_CONTAINER='替换为新数据库容器名'
NEW_APP_CONTAINER='替换为新 app 容器名'
DB_BACKUP_CONTAINER='替换为新 db-backup 容器名'
DOKPLOY_HOST='替换为 Dokploy 控制台域名'
COMPOSE_ID='替换为 Dokploy Compose ID'
```

只有执行第 11 节的可选 API 验收时才需要 `DOKPLOY_TOKEN`。请从受控的 secret manager
注入它，不要把 token 写入仓库、本文或 shell history。

## 3. 先验证仓库部署契约

在开发机运行：

```bash
pnpm deploy:dokploy:check
pnpm exec vitest run packages/server/src/runtime-health.test.ts packages/server/src/app-security.test.ts
pnpm typecheck
pnpm build
```

`deploy:dokploy:check` 会验证：

- Dokploy 配置没有暴露 app、数据库和 NSFW 主机端口。
- app 强制等待 `db-backup` 成功完成。
- app 容器健康检查使用 `/api/health/ready`。
- `pgdata`、`backups`、`botdata`、`codeworkspaces`、`codegit` 都是命名卷。
- `coding` profile 和旧服务器 direct overlay 仍可解析。

建议先在旧服务器使用原更新脚本部署 `<TARGET_SHA>`，确认旧环境运行正常，再迁移同一个 SHA。这样服务器迁移和应用升级不会同时发生。

## 4. 准备新服务器与 Dokploy

### 4.1 服务器建议

启用 app、PostgreSQL、NSFW 和 coding worker 时，Compose 资源上限合计约 3.5 GiB，构建镜像还需要额外内存和磁盘。建议：

- 8 GiB RAM 或更多。
- 4 vCPU 或更多。
- 80 GiB SSD 起步，并为 Docker images、PostgreSQL、Bot 文件和备份预留增长空间。
- Ubuntu/Debian，使用 Dokploy 官方稳定版安装方式。
- 防火墙只对公网开放 SSH、80 和 443；不要开放 PostgreSQL、NSFW 或 worker 端口。

安装与升级命令以 Dokploy 官方文档为准：<https://docs.dokploy.com/docs/core/installation>。

### 4.2 创建 Compose 服务

在 Dokploy 中创建 Project 和 Production Environment，然后添加 Compose：

| 配置                 | 值                                    |
| -------------------- | ------------------------------------- |
| Compose Type         | Docker Compose                        |
| Provider             | GitHub                                |
| Repository           | `example-owner/cos-tool-bot`               |
| Branch               | `main`                                |
| Compose Path         | `./docker-compose.yml`                |
| Isolated Deployments | 开启                                  |
| Auto Deploy          | 迁移完成前关闭                        |
| Advanced Command     | 复制默认命令并追加 `--force-recreate` |

Dokploy 的 Environment 会用于 Compose 变量插值；容器真正需要的变量已经在 `docker-compose.yml` 中显式映射。不要添加 `env_file: .env`，避免把数据库密码等无关变量全部注入 app。

Dokploy 默认使用 `docker compose ... up -d --build --remove-orphans`。已经成功退出的
`db-backup` 容器在配置未变化时可能被复用，因此只保留默认命令不能保证再次执行备份。
在 Advanced Command 中复制界面展示的完整默认命令，只在末尾追加
`--force-recreate`。例如界面默认值是：

```text
compose -p <DOKPLOY_APP_NAME> -f docker-compose.yml up -d --build --remove-orphans
```

则保存为：

```text
compose -p <DOKPLOY_APP_NAME> -f docker-compose.yml up -d --build --remove-orphans --force-recreate
```

不要照抄占位符；保留界面给出的真实 project name 和 Compose path。Dokploy 会自动在前面加
`docker`。`--force-recreate` 会重建容器但保留命名卷，使 `db-backup` 在每次手动或自动部署时
重新执行；代价是 Compose stack 会有短暂重启窗口。

### 4.3 填写生产环境变量

以下是必填模板，不要把真实值提交到仓库：

```env
DB_PASSWORD=<新服务器数据库密码>
BETTER_AUTH_SECRET=<原值>
BETTER_AUTH_URL=https://<ORIGINAL_DOMAIN>
AUTH_OWNER_EMAIL=<原 owner 邮箱>
PANEL_PASSWORD=<仅空库首次启动需要；恢复旧库后清空>
ENCRYPTION_KEY=<必须使用原值>
ADMIN_CHAT_IDS=[]
COMPOSE_PROFILES=
```

可选能力：

```env
MINI_APP_SESSION_SECRET=<已启用 Mini App 时使用原值>
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=<使用字面量 \n 的单行 PEM>
GITHUB_APP_SLUG=
PIXAI_MCP_URL=
```

启用 Pi coding worker 时再设置：

```env
COMPOSE_PROFILES=coding
CODING_WORKER_SECRET=<随机 secret>
```

不要设置 `PORT`、`NSFW_API_PORT` 或数据库外部端口。
也不要把本地开发值 `NSFW_API_URL=http://localhost:43106` 复制到 Dokploy；生产 Compose 应
留空并使用默认的容器内地址 `http://nsfw-api:3000`。

`POSTGRES_IMAGE` 和 `NSFW_API_IMAGE` 默认使用仓库 `.env.example` 中的值。首次迁移可保持默认；稳定后应把经验证的镜像 digest 写入 Dokploy Environment，从而避免可变 tag 漂移。

### 4.4 首次空库部署

先使用 Dokploy 生成的临时域名，不要立刻修改原域名 DNS。点击 Deploy 后验证：

1. `db-backup` 以退出码 0 完成，日志包含 `Verified database backup`。
2. `db` 和 `app` 为 healthy。
3. `/api/health/ready` 返回 `status: ready` 和 `<TARGET_SHA>`。
4. 日志包含 `Database migrated`、`Authentication initialized`、`Application ready`。

如果返回的 `version` 是 `unknown` 或不是 `<TARGET_SHA>`，停止迁移。正常的 GitHub/Dokploy build 会从 `.git/HEAD`、loose ref 或 `packed-refs` 嵌入版本；只有无 Git 元数据的源码压缩包才需要设置 `APP_VERSION=<TARGET_SHA>` build arg。

## 5. 配置异机备份

在 Dokploy Settings 中创建 S3 Destination，然后为 Compose 命名卷设置 Volume Backups：

| 卷               | 内容                                   | 建议                        |
| ---------------- | -------------------------------------- | --------------------------- |
| `backups`        | 每次部署前生成的已验证 PostgreSQL dump | 必须异机备份                |
| `botdata`        | Bot 文件、身份/提示文件、生成图片      | 必须异机备份                |
| `codeworkspaces` | coding workspace                       | 使用 coding 时备份          |
| `codegit`        | coding Git metadata                    | 使用 coding 时备份          |
| `pgdata`         | PostgreSQL 数据目录                    | 可作为补充，不替代逻辑 dump |

Volume Backup 只能处理 Docker named volume。Dokploy 的实际卷名通常是 `<DOKPLOY_APP_NAME>_<volume>`，以新服务器 `docker volume ls` 和 Dokploy UI 显示为准。

首次配置后手动触发一次备份，并在 S3 目标中确认对象确实存在。只看到“已保存计划”不算备份成功。

## 6. 正式停机与导出

提前 24 小时把原域名 DNS TTL 降到 300 秒。到维护窗口后冻结 `main`，确认目标仍是 `<TARGET_SHA>`。

### 6.1 停止旧应用，保留旧数据库

以下命令会停止生产 Bot，属于外部状态变更：

```bash
cd ~/code/cos-tool-bot
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml stop app
```

启用了 coding profile 时再停止：

```bash
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml stop coding-worker coding-egress-proxy
```

确认没有 app/worker 继续运行，而 `db` 仍为 healthy：

```bash
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml ps
```

### 6.2 导出并验证 PostgreSQL

```bash
umask 077
mkdir -p ~/cos-tool-bot-migration
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml \
  exec -T db pg_dump -U bot -d cos_tool_bot -Fc \
  > ~/cos-tool-bot-migration/cos_tool_bot.dump
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml \
  exec -T db pg_restore --list \
  < ~/cos-tool-bot-migration/cos_tool_bot.dump >/dev/null
test -s ~/cos-tool-bot-migration/cos_tool_bot.dump
```

### 6.3 导出文件卷

`botdata` 必须迁移；coding volumes 按是否启用决定：

```bash
docker run --rm \
  -v cos-bot-prod_botdata:/source:ro \
  -v "$HOME/cos-tool-bot-migration:/backup" \
  alpine:3.21 sh -ec 'cd /source && tar -czf /backup/botdata.tar.gz .'
```

可选：

```bash
docker run --rm -v cos-bot-prod_codeworkspaces:/source:ro -v "$HOME/cos-tool-bot-migration:/backup" alpine:3.21 sh -ec 'cd /source && tar -czf /backup/codeworkspaces.tar.gz .'
docker run --rm -v cos-bot-prod_codegit:/source:ro -v "$HOME/cos-tool-bot-migration:/backup" alpine:3.21 sh -ec 'cd /source && tar -czf /backup/codegit.tar.gz .'
```

生成校验值：

```bash
cd ~/cos-tool-bot-migration
sha256sum cos_tool_bot.dump *.tar.gz > SHA256SUMS
sha256sum -c SHA256SUMS
```

通过 SSH/SCP 或受控对象存储把整个目录传到新服务器。传输后再次执行 `sha256sum -c SHA256SUMS`。

## 7. 在新服务器恢复

这一节会覆盖新服务器的空数据库。只允许对刚创建的 Dokploy 目标执行；先在 Dokploy 中关闭 Auto Deploy，并停止新 app/worker，保留新 db 运行。

在新服务器识别容器和卷：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker volume ls --format 'table {{.Name}}'
```

确认 `<NEW_DB_CONTAINER>`、`<NEW_APP_CONTAINER>` 和目标卷全部属于本次新建的 Dokploy Compose。然后：

```bash
docker stop "$NEW_APP_CONTAINER"
```

启用 coding 时同时停止对应 worker 和代理容器。

### 7.1 恢复数据库

下面的 `--clean --if-exists` 会删除新空库中的同名对象后恢复旧库，属于破坏性操作。确认目标容器名无误后执行：

```bash
docker exec -i "$NEW_DB_CONTAINER" \
  pg_restore -U bot -d cos_tool_bot --clean --if-exists --exit-on-error --no-owner --no-privileges \
  < ~/cos-tool-bot-migration/cos_tool_bot.dump
```

验证基本数据：

```bash
docker exec "$NEW_DB_CONTAINER" psql -U bot -d cos_tool_bot -Atc 'select count(*) from bots;'
docker exec "$NEW_DB_CONTAINER" psql -U bot -d cos_tool_bot -Atc 'select count(*) from drizzle.__drizzle_migrations;'
```

### 7.2 恢复 Bot 文件

以下命令只应对新建的空 `botdata` 卷执行：

```bash
docker run --rm \
  -v "${DOKPLOY_APP_NAME}_botdata:/target" \
  -v "$HOME/cos-tool-bot-migration:/backup:ro" \
  alpine:3.21 sh -ec 'cd /target && tar -xzf /backup/botdata.tar.gz'
```

启用 coding 时，用同样方式把归档恢复到 `<DOKPLOY_APP_NAME>_codeworkspaces` 和 `<DOKPLOY_APP_NAME>_codegit`。

恢复完成后先在 Dokploy Environment 清空 `PANEL_PASSWORD`，避免恢复旧认证数据后再次触发
bootstrap 密码逻辑；然后点击 Deploy。完整 Compose deploy 会先重新运行 `db-backup`，再启动
app。

## 8. 切换前验收

### 8.1 接口与版本

使用临时域名检查：

```bash
curl -fsS "https://${TEMP_DOMAIN}/api/health/live"
curl -fsS "https://${TEMP_DOMAIN}/api/health/ready"
```

`ready` 必须同时满足：

```json
{
  "ok": true,
  "status": "ready",
  "version": "<TARGET_SHA>"
}
```

### 8.2 容器与日志

在 Dokploy 或服务器检查：

- app、db 为 `running/healthy`。
- `db-backup` 为 `exited (0)`，而不是反复重启。
- app 日志没有 migration、decrypt、auth、Telegram polling 或 MCP 初始化错误。
- 启用 coding 时，worker 和出口代理均 healthy。
- `backups` volume 中出现恢复后的新 dump，并完成一次 S3 backup。

Dokploy Deployments 显示 `done` 只说明外层 Compose 命令结束，不能替代容器状态、readiness 和业务 smoke。

### 8.3 业务 smoke

按顺序完成：

1. 使用原 owner 账号登录管理面板。
2. 查看 Bot 列表和关键设置，确认加密配置可读取。
3. 向测试群或私聊发送一条低风险消息，确认只有新服务器响应一次。
4. 检查日志中没有重复 polling/webhook 冲突。
5. 启用 coding 时运行一次无写入的 worker 健康测试。

## 9. 切换原域名

在 Dokploy Domains 中添加：

| 项目           | 值                  |
| -------------- | ------------------- |
| Domain         | `<ORIGINAL_DOMAIN>` |
| Service        | `app`               |
| Container Port | `3000`              |
| HTTPS          | 开启                |

确认新 app 已 ready 后，把原域名 A/AAAA 记录切到新服务器。等待解析后验证：

```bash
curl -fsS "https://${ORIGINAL_DOMAIN}/api/health/live"
curl -fsS "https://${ORIGINAL_DOMAIN}/api/health/ready"
```

再检查登录、Google/GitHub OAuth、Mini App 和真实 Bot smoke。由于继续使用原域名，`BETTER_AUTH_URL` 与 OAuth callback URL 不需要变更。

旧服务器保持停止但完整保留至少 48 小时，不要删除容器、仓库、dump 或 volumes。

## 10. 回滚

### DNS 切换前

停止新 app，修复后重新验收；旧环境仍保持可启动。

### DNS 切换后、尚未产生新业务写入

1. 停止新 app/worker。
2. 把 DNS 指回旧服务器。
3. 启动旧 app/worker。
4. 确认 readiness/业务 smoke。

### 已产生新写入

不能直接启动旧数据库，否则会丢失新消息、任务和配置。应：

1. 停止新 app/worker。
2. 从新数据库生成并验证最新 dump。
3. 确认旧服务器仍运行同一 `<TARGET_SHA>` 和兼容 schema。
4. 把最新 dump 恢复到旧数据库。
5. 恢复必要文件卷后再切回 DNS、启动旧 app。

任何回滚路径都必须保持新旧 Bot 不同时运行。

## 11. 稳定后开启 Auto Deploy

观察 24–48 小时且完成一次恢复演练后：

1. 在 Dokploy 开启 Auto Deploy。
2. 保持 Branch 为 `main`、Compose Path 为 `./docker-compose.yml`。
3. 每次部署后同时检查 deployment record、实际容器状态、`/api/health/ready` SHA 和业务 smoke。
4. 定期检查 `backups` volume 和 S3 生命周期，避免本机磁盘无限增长。

如果通过 Dokploy API 自动验收，认证头必须是 `x-api-key`：

```bash
curl -fsS -H "x-api-key: $DOKPLOY_TOKEN" \
  "https://${DOKPLOY_HOST}/api/deployment.all?composeId=${COMPOSE_ID}"
curl -fsS -H "x-api-key: $DOKPLOY_TOKEN" \
  "https://${DOKPLOY_HOST}/api/docker.getContainersByAppNameMatch?appName=${DOKPLOY_APP_NAME}"
```

不要在命令行中写 literal token；从受控环境变量读取。即使 deployment status 为 `done`，仍要检查第二个接口返回的实际容器状态和公开 readiness。

## 12. 日常故障排查

优先收集：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker logs --tail=200 "$NEW_APP_CONTAINER"
docker logs --tail=200 "$DB_BACKUP_CONTAINER"
curl -i "https://${ORIGINAL_DOMAIN}/api/health/ready"
```

常见判定：

- `/live` 200、`/ready` 503 `starting`：应用仍在迁移或启动依赖。
- `/ready` 503 `stopping`：实例已进入优雅下线，等待 Dokploy 替换。
- `/ready` 200 但 Bot smoke 失败：HTTP 就绪不等于外部 Telegram/provider 完整可用，继续查 Bot 日志。
- deployment `done` 但容器退出：以容器状态为准。
- version `unknown`：构建没有可用 Git metadata，也未提供合法 `APP_VERSION` build arg。

相关官方文档：

- Dokploy Docker Compose：<https://docs.dokploy.com/docs/core/docker-compose>
- Dokploy Domains：<https://docs.dokploy.com/docs/core/docker-compose/domains>
- Dokploy Auto Deploy：<https://docs.dokploy.com/docs/core/auto-deploy>
- Dokploy Volume Backups：<https://docs.dokploy.com/docs/core/volume-backups>
- Docker Compose 启动顺序：<https://docs.docker.com/compose/how-tos/startup-order/>
