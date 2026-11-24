# Hanori · 花织

自托管的 Telegram AI 伙伴，基于 [grammY](https://grammy.dev/)、[Hono](https://hono.dev/)、[React 19](https://react.dev/) 与 [Refine](https://refine.dev/) 构建。

支持多 Bot 管理、AI 对话与记忆、群聊自然接话、图片与贴纸生成、RSS / 定时提醒、插件与 MCP 工具接入，以及配套的 Web 管理面板和 Telegram Mini App。

- 在线文档：[bot.cosine.ren/docs](https://bot.cosine.ren/docs)
- 仓库内阅读：[文档首页](packages/docs/content/docs/index.mdx) · [快速开始](packages/docs/content/docs/getting-started/quickstart.mdx) · [自托管](packages/docs/content/docs/self-hosting/index.mdx) · [更新日志](docs/releases)

## 快速部署（Docker）

首次部署用 POSIX Shell 和 OpenSSL 生成环境配置与随机密钥，再用 Docker Compose 启动：

```bash
./scripts/init-env.sh --email owner@example.com --url https://bot.example.com
node scripts/check-env.mjs
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml up -d --build
curl -fsS http://localhost:43100/api/health/ready
```

手动配置可从 [.env.selfhost.example](.env.selfhost.example) 开始，再运行 `pnpm deploy:env:check`。已有实例继续使用原来的环境文件、加密密钥、Compose 项目名和数据卷。

本地试跑可以把 `--url` 改成 `http://localhost:43100`。后续更新直接跑 `./scripts/update-production.sh`（自动备份、重建并做健康检查）；如果自定义过 Compose 项目名，记得先设置 `DEPLOY_PROJECT_NAME`。

反代配置（含 Dokploy）、备份恢复与版本升级见 [Docker 部署](packages/docs/content/docs/self-hosting/docker.mdx) 和 [备份与升级](packages/docs/content/docs/self-hosting/backup-upgrade.mdx)。需要跑完整启动/恢复冒烟检查时，可使用 `pnpm deployment:smoke`。

## 本地开发

需要 Node.js >= 22.19 与 pnpm 10。

```bash
pnpm install --frozen-lockfile
cp -n .env.example .env
pnpm dev:db
pnpm db:migrate

pnpm dev        # 同时启动 server (:43100) + panel (:43101) + docs (:43102)
pnpm dev:docs   # 仅启动文档站，不需要数据库或 Bot Token
pnpm build
pnpm lint
```

### 目录结构

```text
packages/
  shared/         跨包类型、校验与通用工具
  database/       Drizzle ORM Schema 与 PostgreSQL 迁移
  bot/            grammY Bot 运行时、命令、中间件与工具
  server/         Hono API、认证、BotPool 与外部集成
  panel/          React 19 + Refine 管理面板与 Telegram Mini App
  docs/           Fumadocs 公开文档站（构建后挂载在 /docs）
  coding-worker/  独立 Pi 编码工作容器
```

## 常用环境变量

完整说明见 [.env.example](.env.example) 与 [配置项说明](packages/docs/content/docs/self-hosting/configuration.mdx)。

```bash
# 必填（生产环境）
DATABASE_URL=          # PostgreSQL 连接串
BETTER_AUTH_SECRET=    # 认证密钥，至少 32 位
BETTER_AUTH_URL=       # 面板对外地址，如 https://bot.example.com
AUTH_OWNER_EMAIL=      # 首次启动时创建的管理员邮箱
ENCRYPTION_KEY=        # Bot Token 等敏感字段的加密密钥

# 仅首次初始化使用，完成后可删除
PANEL_PASSWORD=        # 管理员初始密码
BOT_TOKEN=             # 初始 Telegram Bot Token
ADMIN_CHAT_IDS=[]      # 初始管理员 Chat ID 列表

# 可选集成
GOOGLE_CLIENT_ID=      # Google OAuth
GOOGLE_CLIENT_SECRET=
GITHUB_APP_ID=         # GitHub App（以下五项需全填或全留空）
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=# 单行 PEM 私钥，换行用 \n 表示
GITHUB_APP_SLUG=

# 可选：Dev Harness（Telegram 话题群 PR 协作）
HARNESS_CONFIG_PATH=
HARNESS_GITHUB_WEBHOOK_SECRET=
HARNESS_LODY_BRIDGE_URL=
HARNESS_LODY_BRIDGE_SECRET=
LODY_CLI_TOKEN=
```

启用独立 Pi 编码容器时，在 `.env` 中设置 `COMPOSE_PROFILES=coding`（Dokploy 环境为 `dokploy,coding`）并配置 `CODING_WORKER_SECRET`。Dev Harness 配置示例见 [harness.example.yaml](harness.example.yaml)。

## 其他

- 贡献代码：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题私下报告：[SECURITY.md](SECURITY.md)
- 开源协议：[MIT License](LICENSE)
