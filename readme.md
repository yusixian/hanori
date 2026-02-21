# cos-tool-bot

pnpm monorepo 结构的 Telegram Bot，使用 [grammY](https://grammy.dev/) 框架 + [Hono](https://hono.dev/) API 服务 + [React](https://react.dev/) + [Refine](https://refine.dev/) 管理面板。

## 项目结构

```
packages/
  shared/    # 领域类型 + 工具函数
  database/  # Drizzle ORM schema + PostgreSQL 客户端
  bot/       # grammY Bot（createBot 工厂函数）
  server/    # Hono API 入口 + BotManager + DbLogger
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
BOT_TOKEN=             # Telegram Bot Token
ADMIN_IDS=[]           # 管理员 Chat ID 数组
DATABASE_URL=          # PostgreSQL 连接字符串
PANEL_PASSWORD=        # 管理面板登录密码
```

## 部署

```bash
docker compose up -d
```

详见 `docker-compose.yml` 和 `Dockerfile`。

## Claude Code 用户

项目包含 `.claude/skills/grammy/` 本地 skill，提供 grammY 框架的离线 API 参考文档，开发 Bot 时可供 Claude Code 查阅。
