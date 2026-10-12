<img src="packages/docs/public/docs/icon.svg" width="80" height="80" alt="Hanori 樱花对话气泡标识" />

# Hanori · 花织

以 Telegram 为入口的自托管 AI 伙伴。聊聊日常、留下记忆，也一起把灵感画出来。花织包含 React 工作台、Hono API、PostgreSQL、公开文档，以及可选的 Lark、MCP、GitHub 与隔离编码 worker。核心服务可以不配置 Bot Token、AI 服务商或第三方 OAuth 就完成初始化；这些能力随后在面板按需开启。

[功能与使用](packages/docs/content/docs/index.mdx) · [部署指南](packages/docs/content/docs/self-hosting/docker.mdx) · [配置说明](packages/docs/content/docs/self-hosting/configuration.mdx) · [备份与升级](packages/docs/content/docs/self-hosting/backup-upgrade.mdx) · [参与贡献](CONTRIBUTING.md)

## Docker 部署

准备 Docker Engine、Compose v2、Node.js 22.19+ 和 Git。取得一个已发布版本的源码后，在根目录生成环境文件；此命令不依赖 pnpm 安装：

```bash
node scripts/init-env.mjs --email owner@example.com --url https://bot.example.com
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml up -d --build
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml ps
curl -fsS http://127.0.0.1:43100/api/health/ready
```

把邮箱与 origin 替换为自己的值。初次本机试用可用 `http://localhost:43100`；远程部署需要配置自己的 HTTPS 反向代理，并限制主机端口的访问。数据库不发布主机端口。

脚本生成权限为 `0600` 的 `.env`，其中每个密钥独立随机生成，不会覆盖已有文件或在终端输出秘密。仅在本地查看 `PANEL_PASSWORD` 以完成首次登录，然后在 Settings 修改密码；验证新密码后移除 bootstrap 密码并重建 app。此配置用于 Docker；本地源码开发请用下文的开发模板。

不要更换 `ENCRYPTION_KEY`、已有 Compose 项目名或数据库 volume，也不要执行 `docker compose down -v`。数据库之外还需备份文件卷与受保护的密钥副本。部署后 `/docs/` 可匿名访问。

Compose 默认不启用 coding worker 或 Lody bridge。Dokploy 部署使用基础 `docker-compose.yml`，配置 `TRAEFIK_DOCKER_NETWORK` 为自己的共享代理网络，不要复制其他实例的网络名称。

## 升级

Git 克隆部署可指定一个真实存在、已经审查的 release tag：

```bash
./scripts/update-production.sh --version vX.Y.Z
```

把 `vX.Y.Z` 替换为要安装的版本。脚本验证数据库备份、只允许向前升级、启动后等待 readiness。默认 Compose 项目名是 `cos-bot-prod`；自定义实例应通过 `DEPLOY_PROJECT_NAME` 保持第一次部署时的名称，备份路径可通过 `DEPLOY_BACKUP_DIR` 固定。源码归档没有 `.git`，构建前必须设置该公开 release 对应的完整 Git SHA 为 `APP_VERSION`，并按[备份与升级](packages/docs/content/docs/self-hosting/backup-upgrade.mdx)手动更新。

## 源码开发

Node.js 22.19+，pnpm 10.5.2，Docker：

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev:db
pnpm db:migrate
pnpm dev
```

启动前编辑 `.env`，设置 owner 邮箱、bootstrap 密码和独立随机密钥。开发模板使用本地 PostgreSQL 端口 `43105`；数据库、server、panel 与文档默认分别使用 `43105`、`43100`、`43101`、`43102`。只查看文档可运行 `pnpm dev:docs`，无需数据库。

## 项目与验证

`packages/shared` 为跨包契约，`database` 为 schema 与迁移，`bot` 为 Telegram runtime，`server` 为 API 和集成，`panel` 为 React 面板与 Mini App，`docs` 为 Fumadocs，`coding-worker` 为隔离 Pi worker。

```bash
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm i18n:check
pnpm test
pnpm test:browser
pnpm build
pnpm test:docs
```

浏览器测试先安装 Chromium：`pnpm --filter @cos-tool-bot/panel exec playwright install chromium`。真实 Telegram Mini App 的签名访问、外部模型、OAuth 和消息投递需要自己的测试账号单独验收。

发布前可运行隔离的容器部署检查，无需 pnpm 依赖：

```bash
node scripts/smoke-deployment.mjs --check
node scripts/smoke-deployment.mjs
```

`--check` 只核对隔离配置；第二条需要本机 Docker 已启动，会构建当前源码，在随机命名的空数据库上验证迁移、owner 登录、匿名文档、容器重建后的数据保留，以及数据库和文件备份恢复，然后清理这次测试的资源。不会读取已有 `.env`、连接外部数据库、发布端口或配置真实 Bot。源码归档需额外提供 `--sha <该版本的完整 Git SHA>`。这项检查不替代前一发行版本到当前版本的升级演练。

## Issues、贡献与许可

欢迎通过本仓库 Issues 提交可复现问题。请附版本、部署方式、复现步骤和经过脱敏的日志；不要提交 `.env`、数据库、Token、私钥、真实聊天记录或用户身份映射。安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告。

代码使用 [MIT](LICENSE) 许可。首次公开之前的 `docs/releases/` 记录的是此前版本的行为，并不意味着本仓库已经有相同 tag、PR 或发布资产。`.public-manifest.json` 仅用于源码快照完整性核对，不包含实例配置或私有历史。
