# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev              # Start server (tsx --watch) + panel (Vite) concurrently
pnpm dev:db           # Start PostgreSQL via docker-compose.dev.yml

# Build
pnpm build            # Build all packages (tsdown for backend, Vite for panel)

# Database
pnpm db:generate      # Generate Drizzle migrations
pnpm db:migrate       # Run Drizzle migrations

# Quality
pnpm lint             # oxlint (no ESLint/Prettier)
pnpm fmt:check        # oxfmt format check
pnpm fmt              # oxfmt auto-fix formatting
pnpm typecheck        # tsc -b (monorepo composite build)

# Docker
pnpm docker:up        # Production build + run
pnpm docker:down      # Stop containers

# Per-package (from root)
pnpm --filter @cos-tool-bot/<package> dev
pnpm --filter @cos-tool-bot/<package> build
pnpm --filter @cos-tool-bot/<package> typecheck
```

## Architecture

pnpm monorepo with 5 packages. A grammy Telegram Bot + Hono API server + React management panel.

```
shared    ← Pure types (BotStatus, LogLevel, LogEntry, BotRecord, BotWithStatus) + utilities (parseParams)
database  ← Drizzle ORM schema (bots, botLogs, settings tables) + PostgreSQL client
bot       ← grammy Bot, createBot(config) factory function
server    ← Hono API, BotPool multi-bot lifecycle, DbLogger, exports AppType
panel     ← React 19 + Refine v4 SPA (Login, Bots, Logs)
```

Dependency flow: `panel → server → bot → shared`, `server → database → shared`.

### Type-Safe API Pattern (Hono RPC)

The server's `createApp()` in `packages/server/src/app.ts` uses **chained** `.route()` calls to preserve Hono's type inference. The return type is exported as `AppType`. The panel imports `AppType` as a **devDependency** (types only, never bundled) and creates a typed RPC client via `hc<AppType>()` in `packages/panel/src/lib/client.ts`.

**Critical**: When adding new routes, they must be chained in `createApp()` to be included in `AppType`. Route handler functions must return `new Hono().verb(...)` (chained) — not assign to a variable and return it separately, or types will be lost.

### Bot Command Pattern

Commands live in `packages/bot/src/commands/`. Admin commands use `createAuthGuard(adminIds)` from `packages/bot/src/guards/auth.ts`. The restart command uses a callback pattern: `config.onRestart?.()`, handled by BotManager in the server package.

### Lark Webhook Bot

项目支持 Lark/飞书自定义机器人（Webhook 推送模式）。核心实现在 `packages/server/src/services/` 下：

- `lark-webhook-client.ts` — Webhook 客户端，支持签名校验（HmacSHA256）、发送文本/卡片消息
- `lark-bot-manager.ts` — 生命周期管理（start/stop/restart），集成 DbLogger 和可选的邮件监控
- `imap-email-monitor.ts` — IMAP 邮件监控，将邮件转发到 Lark 群
- `email-parsers.ts` — 邮件内容解析，支持 GitHub PR（approved/changes_requested/commented/merged/opened/review_requested/pushed）、CI Run、Issue 三类邮件，自动生成对应 Lark 卡片

Webhook 频率限制：100 次/分钟，5 次/秒，请求体 ≤ 20KB。安全配置支持签名校验、IP 白名单、自定义关键词三种方式。

### Logging & SSE

`DbLogger` writes to both pino stdout and the `botLogs` database table. The panel receives real-time logs via SSE at `GET /api/logs/stream` using fetch + ReadableStream (not EventSource).

## Pre-commit Checklist

**Every commit MUST pass lint and format checks.** Pre-commit hooks (simple-git-hooks + lint-staged) run automatically, but you should also verify manually before committing:

```bash
pnpm lint             # must pass with no errors
pnpm fmt:check        # must pass with no format issues
pnpm typecheck        # must pass with no type errors
```

If format check fails, run `pnpm fmt` to auto-fix, then re-stage the changed files.

## Conventions

- **ESM only** — all packages use `"type": "module"`, imports require `.js` extensions in non-bundled code
- **Build tools** — tsdown for backend packages, Vite for panel
- **Linting** — oxlint only, no ESLint or Prettier
- **Formatting** — oxfmt (with Tailwind class sorting via `.oxfmtrc.json`)
- **TypeScript** — strict mode, `module: "ESNext"`, `moduleResolution: "bundler"`
- **Panel styling** — Tailwind CSS v4, utility classes via `clsx` + `tailwind-merge`
- **State** — Refine v4 for data/auth, jotai for local state
- **No test framework** — currently no tests configured
