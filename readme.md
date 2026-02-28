# cos-tool-bot

pnpm monorepo 结构的 Telegram Bot，使用 [grammY](https://grammy.dev/) 框架 + [Hono](https://hono.dev/) API 服务 + [React](https://react.dev/) + [Refine](https://refine.dev/) 管理面板。

## 项目结构

```
packages/
  shared/    # 领域类型 + 工具函数
  database/  # Drizzle ORM schema + PostgreSQL 客户端
  bot/       # grammY Bot（createBot 工厂函数）
  server/    # Hono API 入口 + BotPool + DbLogger
  panel/     # React 19 + Refine v4 + Tailwind CSS v4 管理面板
```

## 开发

```bash
pnpm install
cp .env.example .env  # 填写环境变量

pnpm dev              # 启动所有服务（server + panel dev）
pnpm build            # 构建所有包
pnpm lint             # oxlint 代码检查
```

## 环境变量

```bash
DATABASE_URL=          # PostgreSQL 连接字符串
JWT_SECRET=            # JWT 签名密钥
PANEL_PASSWORD=        # 管理面板登录密码
ENCRYPTION_KEY=        # Bot Token 加密密钥
BOT_TOKEN=             # (可选) Telegram Bot Token，仅首次迁移用
ADMIN_CHAT_IDS=[]      # (可选) 管理员 Chat ID 数组，仅首次迁移用
```

## 部署

```bash
docker compose up -d
```

详见 `docker-compose.yml` 和 `Dockerfile`。

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
