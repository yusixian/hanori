# cos-tool-bot

pnpm monorepo 结构的 Telegram Bot，使用 [grammY](https://grammy.dev/) 框架 + [Hono](https://hono.dev/) API 服务 + [React](https://react.dev/) + [Refine](https://refine.dev/) 管理面板。

[快速开始](packages/docs/content/docs/getting-started/quickstart.mdx) · [功能指南](packages/docs/content/docs/index.mdx) · [自托管](packages/docs/content/docs/self-hosting/index.mdx) · [更新说明](packages/docs/content/docs/changelog/index.mdx)

## 文档与更新说明

项目包含独立的 Fumadocs 文档站，随应用一起部署，访客无需登录或获得 GitHub 仓库权限即可阅读。管理面板侧栏底部和登录页均提供“文档”和“更新说明”入口。

| 内容               | 部署后的入口（在实例域名后追加）   | 仓库内阅读                                                            |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------- |
| 文档首页与功能总览 | `/docs/`                           | [文档首页](packages/docs/content/docs/index.mdx)                      |
| 首次配置与使用     | `/docs/getting-started/quickstart` | [快速开始](packages/docs/content/docs/getting-started/quickstart.mdx) |
| 自托管、配置与升级 | `/docs/self-hosting`               | [自托管总览](packages/docs/content/docs/self-hosting/index.mdx)       |
| 历史版本与升级说明 | `/docs/changelog/`                 | [发布说明源文件](docs/releases)                                       |

首版中文指南覆盖 AI 对话与模型、群聊和 JEV、隐私与记忆、图片与贴纸、RSS/总结/提醒、Mini App、管理员私聊代发、MCP、GitHub 编码任务和飞书集成。文档支持搜索、移动端导航和深浅色主题。

[Telegram 链接读取配置指南](packages/docs/content/docs/integrations/telegram-reader.mdx)介绍独立 MCP Platform Reader 的账号登录、白名单、OAuth 与验收流程，并说明当前 Bot 接入仍需补齐的能力。

角色库、原创角色、群友形象绑定和提示词资产的用法见[图片与生成资产指南](packages/docs/content/docs/guides/media.mdx)；迁移、权限和定向测试见[生成资产库维护与验收](docs/GENERATION_LIBRARY.md)。自动注入与 NSFW 素材默认关闭。

管理面板的任务分组、导航搜索和全局管理入口见[管理面板导航](packages/docs/content/docs/guides/panel-navigation.mdx)。

版本详情与 GitHub Release 共用 `docs/releases/v*.md` 正文，避免两份说明长期不一致。公开文档不代表源码仓库已经开源；仓库访问与未来许可证会独立管理。

本地只查看文档可运行 `pnpm dev:docs`，打开 `http://localhost:5174/docs/`，无需数据库或 Bot Token。内容维护和构建方式见 [公开文档维护指南](docs/PUBLIC_DOCUMENTATION.md)。

## 项目结构

```
packages/
  shared/    # 领域类型 + 工具函数
  database/  # Drizzle ORM schema + PostgreSQL 客户端
  bot/       # grammY Bot（createBot 工厂函数）
  server/    # Hono API 入口 + BotPool + DbLogger
  panel/     # React 19 + Refine v4 + Tailwind CSS v4 管理面板
  docs/      # Fumadocs 公开文档站（静态构建，/docs）
```

## 开发

```bash
pnpm install
cp .env.example .env  # 填写环境变量

pnpm dev              # 启动 server + panel + docs
pnpm dev:docs         # 只启动公开文档站，无需数据库或 Bot Token
pnpm build            # 构建所有包
pnpm lint             # oxlint 代码检查
```

首次部署或更新服务器，请阅读 [Docker 部署指南](docs/DEPLOYMENT.md)。管理员通过面板连接 GitHub 前，请阅读 [GitHub App 配置指南](docs/GITHUB_APP.md)。认证迁移、Google OAuth 和完整环境变量说明见 [配置与初始化指南](docs/SETUP.md)。

## CI / Self-hosted Runner

CI(`.github/workflows/ci.yml`)运行在维护者的 Mac 上（self-hosted runner，标签 `cos-tool-bot`),**不使用 GitHub 托管的 runner**。runner 不在线时，workflow 会一直排队等待，不会执行。推送代码 / 开 PR 前请确认 runner 服务已启动：

```bash
cd ~/actions-runner/cos-tool-bot

./svc.sh status   # 查看运行状态
./svc.sh start    # 启动（安装后重启系统会自动运行）
./svc.sh stop     # 停止
```

- runner 目录：`~/actions-runner/cos-tool-bot`（与其他项目的 runner 实例相互独立，一台机器可以同时作为多个项目的 runner)
- 运行日志：`~/actions-runner/cos-tool-bot/_diag/`
- 服务通过 launchd 注册（`~/Library/LaunchAgents/actions.runner.example-owner-cos-tool-bot.*.plist`)，安装命令为 `./svc.sh install`
- 需要重新注册时：在仓库 Settings → Actions → Runners → New self-hosted runner 获取 token 后重新运行 `./config.sh`，再执行 `./svc.sh install && ./svc.sh start`

## 环境变量

```bash
DATABASE_URL=          # PostgreSQL 连接字符串
BETTER_AUTH_SECRET=    # Better Auth secret，至少 32 位
BETTER_AUTH_URL=       # 面板公开 URL，例如 https://bot.example.com
AUTH_OWNER_EMAIL=      # 首次启动时创建 owner 的邮箱
PANEL_PASSWORD=        # 仅用于首次迁移时创建 owner，完成后可删除
GOOGLE_CLIENT_ID=      # (可选) Google OAuth Client ID
GOOGLE_CLIENT_SECRET=  # (可选) Google OAuth Client Secret
GITHUB_APP_ID=         # (可选) GitHub App ID；GitHub App 五项必须全填或全空
GITHUB_APP_CLIENT_ID=  # (可选) GitHub App Client ID
GITHUB_APP_CLIENT_SECRET= # (可选) GitHub App Client Secret
GITHUB_APP_PRIVATE_KEY=   # (可选) 单行、使用字面 \n 分隔的 PEM 私钥
GITHUB_APP_SLUG=       # (可选) github.com/apps/ 后面的 slug
ENCRYPTION_KEY=        # Bot Token 加密密钥
BOT_TOKEN=             # (可选) Telegram Bot Token，仅首次迁移用
ADMIN_CHAT_IDS=[]      # (可选) 管理员 Chat ID 数组，仅首次迁移用
```

生产环境必须设置 `BETTER_AUTH_URL`、`BETTER_AUTH_SECRET` 和 `AUTH_OWNER_EMAIL`；`PANEL_PASSWORD` 只用于首次创建 owner，首次启动成功后即可删除。

GitHub App 的创建、Callback URL、仓库权限和私钥安全写入方式见 [GitHub App 配置指南](docs/GITHUB_APP.md)。旧服务器的隔离 Pi worker 通过 `.env` 中的 `COMPOSE_PROFILES=coding` 启用；Dokploy 使用 `COMPOSE_PROFILES=dokploy,coding`。两种部署都要求同时配置 `CODING_WORKER_SECRET`。

## 部署

```bash
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml up -d --build
```

后续更新可以使用自动备份、拉取、构建和健康检查脚本：

```bash
./scripts/update-production.sh
```

首次部署和脚本使用方法见 [Docker 部署指南](docs/DEPLOYMENT.md)。

### 从旧版本升级（pgvector 迁移）

本项目使用 `pgvector/pgvector:pg17` 镜像（官方 PostgreSQL 17 超集，预装 pgvector 扩展），用于语义搜索功能。若从旧版 `postgres:17-alpine` 升级，数据库大版本相同，volume 数据完全兼容，不会丢失数据。

**生产环境已有容器运行时的升级步骤：**

```bash
# 1. 拉取新镜像 + 重建应用镜像
docker compose pull db
docker compose build app

# 2. 重启容器（db 先启动，app 自动运行迁移）
docker compose up -d db
docker compose up -d app
```

app 启动时会自动执行：

- `CREATE EXTENSION IF NOT EXISTS vector` — 注册 pgvector 扩展
- Drizzle 迁移 — 添加 vector 列和 HNSW 索引

**（可选）回填存量数据的 embedding：**

在管理面板中配置好 Bot 的 Embedding 设置后，运行回填脚本：

```bash
docker compose exec app npx tsx packages/server/src/scripts/backfill-embeddings.ts
```

> 不运行回填脚本也可以正常使用。新消息和记忆会自动生成 embedding，老数据在搜索时走纯关键词匹配。

## Claude Code 用户

项目包含 `.claude/skills/grammy/` 本地 skill，提供 grammY 框架的离线 API 参考文档，开发 Bot 时可供 Claude Code 查阅。
