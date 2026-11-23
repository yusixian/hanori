# Hanori · 花织

pnpm monorepo 结构的 Telegram Bot，使用 [grammY](https://grammy.dev/) 框架 + [Hono](https://hono.dev/) API 服务 + [React](https://react.dev/) + [Refine](https://refine.dev/) 管理面板。

[快速开始](packages/docs/content/docs/getting-started/quickstart.mdx) · [功能指南](packages/docs/content/docs/index.mdx) · [自托管](packages/docs/content/docs/self-hosting/index.mdx) · [更新说明](packages/docs/content/docs/changelog/index.mdx)

首次部署可运行 `pnpm setup:env` 生成独立密钥。部署命令、代理网络和已有实例升级见[部署指南](packages/docs/content/docs/self-hosting/docker.mdx)。贡献代码见[贡献指南](CONTRIBUTING.md)，私下报告安全问题见[安全联系说明](SECURITY.md)。

`pnpm deployment:smoke --check` 只验证部署隔离配置；本机 Docker 启动后运行 `pnpm deployment:smoke`，可用随机项目、临时密钥和空数据库验证首次启动、登录、重建持久性与备份恢复。它不读取已有 `.env`，结束后只清理本次测试资源；前版本升级和真实集成仍需单独验收。

## 文档与更新说明

项目包含独立的 Fumadocs 文档站，随应用一起部署，访客无需登录或获得 GitHub 仓库权限即可阅读。管理面板侧栏底部和登录页均提供“文档”和“更新说明”入口。

| 内容               | 部署后的入口（在实例域名后追加）   | 仓库内阅读                                                            |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------- |
| 文档首页与功能总览 | `/docs/`                           | [文档首页](packages/docs/content/docs/index.mdx)                      |
| 首次配置与使用     | `/docs/getting-started/quickstart` | [快速开始](packages/docs/content/docs/getting-started/quickstart.mdx) |
| 自托管、配置与升级 | `/docs/self-hosting`               | [自托管总览](packages/docs/content/docs/self-hosting/index.mdx)       |
| 历史版本与升级说明 | `/docs/changelog/`                 | [发布说明源文件](docs/releases)                                       |

首版中文指南覆盖 AI 对话与模型、群聊和 JEV、隐私与记忆、图片与贴纸、RSS/总结/提醒、Mini App、管理员私聊代发、MCP、GitHub 编码任务。文档支持搜索、移动端导航和深浅色主题。

[Telegram 链接读取配置指南](packages/docs/content/docs/integrations/telegram-reader.mdx)介绍独立 MCP Platform Reader 的账号登录、白名单、OAuth 与验收流程，并说明当前 Bot 接入仍需补齐的能力。

角色库、原创角色、群友形象绑定和提示词资产的用法见[图片与生成资产指南](packages/docs/content/docs/guides/media.mdx)；迁移、权限和定向测试见[生成资产库维护与验收](docs/GENERATION_LIBRARY.md)。自动注入与 NSFW 素材默认关闭。

管理面板的任务分组、导航搜索和全局管理入口见[管理面板导航](packages/docs/content/docs/guides/panel-navigation.mdx)。

统一 `search` 的来源、权限、按需读取与网页回退开关见[统一检索指南](packages/docs/content/docs/guides/search.mdx)。

网页安装、按 Bot 启停及 Cookie 配置见[插件市场指南](packages/docs/content/docs/guides/plugins.mdx)；第三方插件的 manifest、JavaScript 入口和示例见[插件开发指南](packages/docs/content/docs/integrations/plugin-development.mdx)。

图片任务的查找、参数回查与删除核对见[生成记录与问题恢复](packages/docs/content/docs/guides/generation-records.mdx)。

管理员通过 AI 查询运行状态、有效配置和上一条消息执行链路的用法及权限边界见[AI 运行诊断](packages/docs/content/docs/reference/runtime-diagnostics.mdx)。

版本详情与 GitHub Release 共用 `docs/releases/v*.md` 正文，避免两份说明长期不一致。源码许可见 [MIT License](LICENSE)。

本地只查看文档可运行 `pnpm dev:docs`，打开 `http://localhost:43102/docs/`，无需数据库或 Bot Token。内容维护和构建方式见 [公开文档维护指南](docs/PUBLIC_DOCUMENTATION.md)。

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
pnpm install --frozen-lockfile
cp -n .env.example .env  # 首次开发时填写本地数据库与认证配置
pnpm dev:db
pnpm db:migrate

pnpm dev              # 启动 server + panel + docs
pnpm dev:docs         # 只启动公开文档站，无需数据库或 Bot Token
pnpm build            # 构建所有包
pnpm lint             # oxlint 代码检查
```

首次部署或更新服务器，请阅读 [Docker 部署指南](docs/DEPLOYMENT.md)。管理员通过面板连接 GitHub 前，请阅读 [GitHub App 配置指南](docs/GITHUB_APP.md)。认证迁移、Google OAuth 和完整环境变量说明见 [配置与初始化指南](docs/SETUP.md)。

## CI

推送到主线或向主线提交 PR 会在 GitHub 托管的 Ubuntu 环境运行构建、类型、翻译、单元和浏览器检查。具体命令见 [CI 工作流](.github/workflows/ci.yml)。

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
HARNESS_CONFIG_PATH=   # (可选) Dev Harness 配置文件路径；留空则完全关闭
HARNESS_GITHUB_WEBHOOK_SECRET= # (可选) Dev Harness GitHub webhook 密钥
HARNESS_LODY_BRIDGE_URL=       # (可选) lody-bridge 地址，例如 http://lody-bridge:43190；需启用 harness profile
HARNESS_LODY_BRIDGE_SECRET=    # (可选) app 与 lody-bridge 共享的 Bearer 密钥，至少 32 个字符
LODY_CLI_TOKEN=                # (可选) 仅 lody-bridge 使用的 Lody CLI Token
```

生产环境必须设置 `BETTER_AUTH_URL`、`BETTER_AUTH_SECRET` 和 `AUTH_OWNER_EMAIL`；`PANEL_PASSWORD` 只用于首次创建 owner，首次启动成功后即可删除。

GitHub App 的创建、Callback URL、仓库权限和私钥安全写入方式见 [GitHub App 配置指南](docs/GITHUB_APP.md)。旧服务器的隔离 Pi worker 通过 `.env` 中的 `COMPOSE_PROFILES=coding` 启用；Dokploy 使用 `COMPOSE_PROFILES=dokploy,coding`。两种部署都要求同时配置 `CODING_WORKER_SECRET`。

Dev Harness（预览）用专用 Bot 在 Telegram 话题群里汇报并合并 GitHub PR，配置示例见 [harness.example.yaml](harness.example.yaml)，使用说明见公开文档「集成 → Dev Harness」。

## 部署

首次在本机安装时，在仓库根目录生成 Docker 环境文件，再启动服务：

```bash
node scripts/init-env.mjs --email owner@example.com --url http://localhost:43100
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml up -d --build
curl -fsS http://localhost:43100/api/health/ready
```

将示例邮箱换成自己的邮箱。公网部署时使用自己的 HTTPS origin。已有实例继续使用原来的环境文件、加密密钥、Compose 项目名和数据卷。

更新时运行 `./scripts/update-production.sh`，脚本会备份、构建并检查应用是否就绪。自定义项目名的实例应设置 `DEPLOY_PROJECT_NAME` 为最初使用的名称。Dokploy 的代理设置、备份恢复以及旧版本升级分别见 [Docker 部署](packages/docs/content/docs/self-hosting/docker.mdx) 和 [备份与升级](packages/docs/content/docs/self-hosting/backup-upgrade.mdx)。

## Claude Code 用户

项目包含 `.claude/skills/grammy/` 本地 skill，提供 grammY 框架的离线 API 参考文档，开发 Bot 时可供 Claude Code 查阅。
