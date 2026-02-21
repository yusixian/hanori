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
shared    ← Pure types (BotStatus, LogLevel, LogEntry) + utilities (parseParams)
database  ← Drizzle ORM schema (botLogs, settings tables) + PostgreSQL client
bot       ← grammy Bot, createBot(config) factory function
server    ← Hono API, BotManager lifecycle, DbLogger, exports AppType
panel     ← React 19 + Refine v4 SPA (Login, Dashboard, Logs)
```

Dependency flow: `panel → server → bot → shared`, `server → database → shared`.

### Type-Safe API Pattern (Hono RPC)

The server's `createApp()` in `packages/server/src/app.ts` uses **chained** `.route()` calls to preserve Hono's type inference. The return type is exported as `AppType`. The panel imports `AppType` as a **devDependency** (types only, never bundled) and creates a typed RPC client via `hc<AppType>()` in `packages/panel/src/lib/client.ts`.

**Critical**: When adding new routes, they must be chained in `createApp()` to be included in `AppType`. Route handler functions must return `new Hono().verb(...)` (chained) — not assign to a variable and return it separately, or types will be lost.

### Bot Command Pattern

Commands live in `packages/bot/src/commands/`. Admin commands use `createAuthGuard(adminIds)` from `packages/bot/src/guards/auth.ts`. The restart command uses a callback pattern: `config.onRestart?.()`, handled by BotManager in the server package.

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

## Environment

Copy `.env.example` to `.env`. Required vars: `DATABASE_URL`, `BOT_TOKEN`, `JWT_SECRET`, `PANEL_PASSWORD`. See `.env.example` for all options including S3 backup and log retention settings.
