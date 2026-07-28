# AGENTS.md

This is the canonical repository guide for coding agents. Read it before changing the project.
Use [CLAUDE.md](CLAUDE.md) for additional background, but treat the current source tree,
`package.json`, and this file as the source of truth when documentation drifts.

## Working Agreement

- Inspect `git status` before editing and preserve unrelated, staged, and untracked work.
- Keep changes narrowly scoped. Reuse existing services, components, helpers, and domain types before
  introducing a parallel abstraction.
- Read the nearest relevant documentation before changing a subsystem. If a nested `AGENTS.md` is
  added later, it extends or overrides this root guide for that directory.
- Do not commit, push, open a pull request, deploy, modify production data, or perform other remote
  mutations unless the user explicitly asks for that action.
- Never commit secrets, tokens, credentials, private keys, local databases, backups, or generated
  runtime data. Local secrets belong in `.env`; keep `.env.example` safe and non-secret.

## Project Overview

`cos-tool-bot` is a Node.js and TypeScript pnpm monorepo for operating multiple Telegram bots, a
Hono API, a React administration panel and Telegram Mini App, and optional integrations such as
Lark webhooks, GitHub App access, MCP, AI generation, and an isolated Pi coding worker.

Runtime requirements are Node.js `>=22.19.0` and pnpm `10.5.2`. All packages are ESM.

## Repository Map

```text
packages/
  shared/         Pure cross-package contracts, validation, command metadata, and utilities
  database/       Drizzle schema, PostgreSQL client, and ordered migrations
  bot/            grammY runtime, commands, middleware, AI handlers, and Telegram tools
  server/         Composition root, Hono API, auth, BotPool lifecycle, persistence, integrations
  panel/          React 19 + Refine admin SPA and Telegram Mini App
  coding-worker/  Optional isolated Pi worker; no direct database or GitHub credentials
scripts/          Local Mini App orchestration and production update helpers
docs/             Setup, deployment, security, feature, and operations runbooks
```

Primary dependency flow:

```text
panel --types--> server --> bot --> shared
                   |         database --> shared
                   +-------> database

coding-worker is an isolated runtime reached through the server's authenticated worker client.
```

Useful subsystem documentation:

- [docs/SETUP.md](docs/SETUP.md) — authentication, environment, and initial setup
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker deployment, backups, and recovery
- [docs/TELEGRAM_MINI_APP.md](docs/TELEGRAM_MINI_APP.md) — Mini App behavior and rollout
- [docs/PI_CODING_AGENT.md](docs/PI_CODING_AGENT.md) — coding-worker trust and isolation model
- [docs/GITHUB_APP.md](docs/GITHUB_APP.md) — GitHub App permissions and configuration

## Common Commands

Run commands from the repository root unless a guide says otherwise.

```bash
pnpm install                 # install workspace dependencies from the lockfile
pnpm dev                     # server :3000 + panel Vite dev server
pnpm dev:db                  # start development PostgreSQL with Compose
pnpm dev:coding-worker       # run the optional worker in host development mode
pnpm build                   # build every package

pnpm db:generate             # generate a Drizzle migration from schema changes
pnpm db:migrate              # apply pending migrations

pnpm lint                    # oxlint
pnpm fmt:check               # verify oxfmt formatting
pnpm fmt                     # apply oxfmt formatting
pnpm typecheck               # TypeScript project references
pnpm i18n:check              # ensure en and zh-CN resources stay aligned
pnpm test                    # Vitest unit tests
pnpm test:coverage           # focused coverage thresholds configured in vitest.config.ts
pnpm test:browser            # Chromium browser tests for the panel
```

Use package filters for focused work, for example:

```bash
pnpm --filter @cos-tool-bot/server typecheck
pnpm --filter @cos-tool-bot/panel build
pnpm exec vitest run packages/server/src/services/example.test.ts
```

## Core Development Rules

### TypeScript and package boundaries

- Use strict TypeScript and ESM. Internal relative imports in TypeScript use `.js` extensions.
- Put shared domain contracts in `packages/shared`; do not make it depend on runtime packages.
- Respect package ownership. Telegram update handling belongs in `bot`; persistence and process
  orchestration belong in `server`; browser UI belongs in `panel`.
- Do not edit `dist/`, `*.tsbuildinfo`, Drizzle metadata snapshots, or other generated artifacts by
  hand. Regenerate them with the owning command when they are tracked and required.

### Hono RPC

- `packages/server/src/app.ts` must keep API middleware and `.route()` registrations in the chained
  `new Hono()` expression so `AppType` preserves route inference.
- Route factories should return a chained Hono instance. The panel imports `AppType` as a
  development-only type and creates the client with `hc<AppType>()`; never introduce a runtime
  server dependency into the browser bundle.
- Preserve auth middleware ordering and tenant scoping when adding or moving routes. Sensitive
  operations must fail closed.

### Telegram commands and runtime

- Command metadata belongs in the shared `TELEGRAM_COMMAND_CATALOG`.
- Register runtime handlers through `ActiveCommandRegistry` so registration, `/help`, and
  `setMyCommands` remain consistent.
- Admin-only commands use the existing auth guard. Lifecycle actions should flow through BotPool or
  the existing callback/service boundary instead of creating a second bot instance.
- Preserve per-chat serialization and cancellation behavior in message and AI flows; add behavioral
  tests for concurrency, retries, recovery, or fallback changes.

### Database and migrations

- Change `packages/database/src/schema.ts`, then run `pnpm db:generate`. Review the generated SQL and
  migration journal together; never renumber or rewrite an already-deployed migration casually.
- Run `pnpm db:migrate` against an appropriate development database for schema changes. Include
  compatibility or backfill logic when existing rows require it.
- Do not point development or tests at production. Back up authoritative data before any explicitly
  requested migration or deployment operation.

### Panel and Mini App

- Keep visible copy in both `packages/panel/src/i18n/locales/en` and `zh-CN`, then run
  `pnpm i18n:check`.
- Reuse the existing component, hook, Refine, Jotai, and Tailwind patterns. Validate interaction and
  authorization behavior in browser tests when unit tests cannot represent the real flow.
- A normal browser page load does not prove Telegram Mini App identity. Acceptance of protected
  paths requires signed Telegram `initData` from the real WebView and the appropriate role.

### Coding worker and external access

- Treat `packages/coding-worker` and its Compose network as a security boundary. Pi itself is not a
  sandbox; do not bypass the authenticated Unix-socket/worker lifecycle or expose host secrets.
- GitHub credentials, push, pull-request creation, and other remote mutations remain in the trusted
  server and explicit confirmation flows, never in the worker.
- Preserve cancellation, bounded timeouts, one-job-per-boot behavior, clean-worktree checks, and
  exact-state confirmation when changing coding or GitHub workflows.

## Privacy and Security Invariants

- Generic persistent Bot logs must not contain group message text, captions, media filenames,
  sticker-pack names, AI prompts or responses, tool arguments or results, or raw Telegram updates.
  Log structured identifiers, event/media kinds, lengths, timings, and outcomes instead.
- Content may enter only a purpose-specific store whose feature, access policy, and retention rules
  explicitly require it. Redact sensitive data before exposing logs or run records to the panel.
- Keep authorization checks server-side even when the UI hides a control. Always scope reads and
  writes by Bot or tenant where applicable.
- Do not weaken security headers, session-cookie attributes, Telegram signature validation,
  encryption, SSRF/network restrictions, or secret handling to make a test pass.

## Testing and Verification

Add or update tests in the same change when behavior changes. Prefer behavior-oriented test names
and colocated `*.test.ts` / `*.browser.test.tsx` files.

During development, run the narrowest relevant test and package typecheck first. Before handing off
a code change, run the relevant build or runtime check plus the repository gates affected by it. A
full validation baseline is:

```bash
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm i18n:check
pnpm test
pnpm test:browser            # required for panel or Mini App behavior changes
pnpm build                   # required for package exports, bundling, or production paths
```

Report exactly what ran and distinguish local checks from CI. If a check cannot run because of an
environment or infrastructure limitation, state that limitation rather than claiming success.

## Telegram Mini App Local Development

Prefer the unified workflow instead of starting the database, server, panel, and Cloudflare Tunnel
in separate terminals:

```bash
pnpm dev:mini-app          # start Compose, migrate, then run Server, Panel, and Tunnel
pnpm dev:mini-app:status   # inspect the managed process, Compose, Tunnel, and HTTP status
pnpm dev:mini-app:stop     # stop only this workflow's processes; preserve the database volume
```

Do not run the unified workflow alongside manually started Server, Panel, or connectors for the same
named tunnel. Tunnel setup, environment overrides, manual fallback steps, and troubleshooting are in
[docs/TELEGRAM_MINI_APP_LOCAL_DEV.md](docs/TELEGRAM_MINI_APP_LOCAL_DEV.md).

## CI and Self-hosted Runner

`.github/workflows/ci.yml` runs lint, format check, typecheck, i18n validation, unit tests, and
Chromium browser tests on a self-hosted macOS ARM64 runner labeled `cos-tool-bot`. Jobs remain queued
while that service is offline.

Before an explicitly requested push or pull request that should trigger CI, check the targeted
runner service:

```bash
cd ~/actions-runner/cos-tool-bot
./svc.sh status
./svc.sh start
```

One machine may host several independent runner installations. Do not stop, reconfigure, or delete a
different project's runner. See [readme.md](readme.md) for logs and re-registration instructions.
