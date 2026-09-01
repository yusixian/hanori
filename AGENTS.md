# AGENTS.md

Repository guide for coding agents. When documentation drifts, the current source tree and
`package.json` win.

## Working Agreement

- Keep changes narrowly scoped; reuse existing services, helpers, and domain types before adding a
  parallel abstraction.
- Do not commit, push, open a PR, deploy, or touch production data unless explicitly asked.
- Never commit secrets or runtime data. Local secrets live in `.env`; keep `.env.example` non-secret.

## Repository Map

pnpm monorepo (Node >= 22.19.0, pnpm 10.5.2, ESM everywhere): multiple Telegram bots, a Hono API,
a React admin panel + Telegram Mini App, plus optional Lark webhooks, GitHub App, MCP, AI
generation, and an isolated Pi coding worker.

```text
packages/
  shared/         Pure cross-package contracts, validation, command metadata, utilities
  database/       Drizzle schema, PostgreSQL client, ordered migrations
  bot/            grammY runtime, commands, middleware, AI handlers, Telegram tools
  server/         Composition root, Hono API, auth, BotPool lifecycle, integrations
  panel/          React 19 + Refine admin SPA and Telegram Mini App
  coding-worker/  Isolated Pi worker; no direct database or GitHub credentials
scripts/          Mini App orchestration and production update helpers
docs/             Subsystem runbooks: SETUP, DEPLOYMENT, TELEGRAM_MINI_APP,
                  PI_CODING_AGENT, GITHUB_APP, GITHUB_ACCESS
```

Dependency flow: `panel --types--> server --> bot --> shared`; `server --> database --> shared`.
The coding worker is reached only through the server's authenticated worker client.

## Commands

```bash
pnpm dev                     # server :3000 + panel Vite dev server
pnpm dev:db                  # development PostgreSQL via Compose
pnpm db:generate             # Drizzle migration from schema changes
pnpm db:migrate              # apply pending migrations

pnpm lint                    # oxlint
pnpm fmt / fmt:check         # oxfmt
pnpm typecheck               # tsc -b (project references)
pnpm i18n:check              # en / zh-CN resources aligned
pnpm test                    # Vitest unit tests
pnpm test:browser            # Chromium browser tests for the panel
pnpm build                   # build every package
pnpm acceptance              # isolated UI acceptance run (Playwright, desktop + mobile)
pnpm acceptance:report       # regenerate report for the latest run
pnpm acceptance:open         # open the latest HTML report
pnpm acceptance:clean        # prune old runs (keeps newest ACCEPTANCE_KEEP_RUNS, default 10)
```

Focused runs: `pnpm --filter @cos-tool-bot/<pkg> <script>`,
`pnpm exec vitest run <path/to/file.test.ts>`.

Mini App local dev uses the unified workflow — `pnpm dev:mini-app` / `:status` / `:stop` — never
alongside manually started server/panel/tunnel. Details:
[docs/TELEGRAM_MINI_APP_LOCAL_DEV.md](docs/TELEGRAM_MINI_APP_LOCAL_DEV.md).

## Development Rules

- Strict TypeScript, ESM; internal relative imports use `.js` extensions. `shared` must not depend
  on runtime packages. Never hand-edit `dist/`, `*.tsbuildinfo`, or Drizzle metadata snapshots.
- **Hono RPC**: keep middleware and `.route()` registrations chained in the `new Hono()` expression
  in `packages/server/src/app.ts`, and route factories returning a chained instance, or `AppType`
  inference breaks. The panel imports `AppType` as a dev-only type (`hc<AppType>()`); never add a
  runtime server dependency to the browser bundle. Preserve auth middleware ordering and tenant
  scoping; sensitive operations fail closed.
- **Telegram commands**: metadata lives in the shared `TELEGRAM_COMMAND_CATALOG`; register handlers
  through `ActiveCommandRegistry` so registration, `/help`, and `setMyCommands` stay aligned.
  Admin commands use the existing auth guard; lifecycle actions go through BotPool. Preserve
  per-chat serialization and cancellation in message/AI flows; add behavioral tests when changing
  concurrency, retries, recovery, or fallback.
- **Database**: edit `packages/database/src/schema.ts`, then `pnpm db:generate`; review the SQL and
  journal together. Never rewrite a deployed migration. Migrate against a dev database only.
- **Panel / Mini App**: keep visible copy in both `en` and `zh-CN` locales, then `pnpm i18n:check`.
  Protected Mini App paths require signed Telegram `initData` from the real WebView — a plain
  browser load proves nothing.
- **Coding worker**: `packages/coding-worker` and its Compose network are a security boundary; Pi is
  not a sandbox. GitHub credentials, push, and PR creation stay in the trusted server with explicit
  confirmation flows — never in the worker. Preserve cancellation, bounded timeouts,
  one-job-per-boot, clean-worktree checks, and exact-state confirmation.

- **Acceptance harness**: `acceptance/` holds the Playwright harness (config, fixtures, specs,
  report scripts). `pnpm acceptance` spins up an isolated environment — dedicated database
  `cos_tool_bot_acceptance`, server on :3100 with throwaway credentials, no `BOT_TOKEN` — builds
  the panel, and runs `acceptance/specs/` against desktop (1440×900) and mobile (390×844)
  projects. Run artifacts land in `.acceptance/runs/<run>/` (gitignored); cases declare
  `acceptance.meta({ id, feature, severity, steps, expected })` and capture
  `acceptance.checkpoint()` screenshots. `.acceptance/plan.md` tracks prioritized UI findings.
  Do not point the harness at a dev/prod database or a real bot token.

## Privacy and Security Invariants

- Generic persistent Bot logs must not contain group message text, captions, media filenames,
  sticker-pack names, AI prompts/responses, tool arguments/results, or raw Telegram updates. Log
  structured identifiers, kinds, lengths, timings, and outcomes instead. Content may enter only a
  purpose-specific store whose retention rules require it.
- Keep authorization server-side even when the UI hides a control; scope reads/writes by Bot or
  tenant. Never weaken security headers, cookie attributes, Telegram signature validation, or
  SSRF/network restrictions to make a test pass.

## Verification

Update tests in the same change when behavior changes (colocated `*.test.ts` /
`*.browser.test.tsx`). Run the narrowest relevant test first; before handoff run the affected
repository gates: `lint`, `fmt:check`, `typecheck`, `i18n:check`, `test`, plus `test:browser` for
panel/Mini App changes and `build` for export/bundling/production paths. Report exactly what ran;
state limitations instead of claiming success.

## CI

`.github/workflows/ci.yml` runs all gates on a self-hosted macOS runner labeled `cos-tool-bot`;
jobs queue indefinitely while it is offline. Before a requested push/PR, check
`cd ~/actions-runner/cos-tool-bot && ./svc.sh status` (start with `./svc.sh start`). Other runner
installations on the machine belong to other projects — leave them alone. See
[readme.md](readme.md) for logs and re-registration.
