# Hanori · 花织

[中文](readme.md) | English

Hanori is a self-hosted Telegram AI companion built with [grammY](https://grammy.dev/), [Hono](https://hono.dev/), [React 19](https://react.dev/), and [Refine](https://refine.dev/). Its admin panel manages multiple bots with AI conversations and memory, group replies, image and sticker generation, RSS feeds, scheduled reminders, plugins, MCP tools, and a Telegram Mini App.

- [Online documentation](https://bot.cosine.ren/docs)
- [Repository documentation index](docs/README.md) · [Documentation home](packages/docs/content/docs/index.mdx) · [Quickstart](packages/docs/content/docs/getting-started/quickstart.mdx) · [Self-hosting](packages/docs/content/docs/self-hosting/index.mdx) · [Changelog](docs/releases)

## Docker quickstart

For the prebuilt installer and Coolify, 1Panel, and Dokploy templates, see the [self-hosting overview](packages/docs/content/docs/self-hosting/index.mdx#一键安装).

From a fresh checkout, generate the instance secrets with a POSIX shell and OpenSSL. Replace the email and public HTTPS origin with your own. For a local trial, use `http://localhost:43100`.

```bash
./scripts/init-env.sh --email owner@example.com --url https://bot.example.com
node scripts/check-env.mjs
docker compose -p cos-bot-prod -f docker-compose.yml -f docker-compose.direct.yml up -d --build
curl -fsS http://localhost:43100/api/health/ready
```

The configuration check requires Node.js 22.19 or later. For manual setup, copy [.env.selfhost.example](.env.selfhost.example) to `.env`, set its permissions to `0600`, fill in the required values, and run `pnpm deploy:env:check`. The [Docker guide](packages/docs/content/docs/self-hosting/docker.mdx) also covers prebuilt GHCR images and the optional `nsfw` image classifier.

For existing installations, retain the environment file, encryption key, Compose project name, and volumes. Run `./scripts/update-production.sh` to back up, rebuild, and check readiness. Set `DEPLOY_PROJECT_NAME` first if you use a custom project name. See [HTTPS reverse proxy](packages/docs/content/docs/self-hosting/reverse-proxy.mdx) and [backup and upgrades](packages/docs/content/docs/self-hosting/backup-upgrade.mdx). To exercise startup and restoration in an isolated Compose project, run `pnpm deployment:smoke`.

## Local development

Use Node.js 22.19 or later and pnpm 10. Fill in the local database and authentication settings before running migrations.

```bash
pnpm install --frozen-lockfile
cp -n .env.example .env
pnpm dev:db
pnpm db:migrate

pnpm dev        # Server on 43100, panel on 43101, docs on 43102
pnpm dev:docs   # Documentation only, without a database or bot token
pnpm build
pnpm lint
```

### Repository structure

```text
packages/
  shared/         Shared types, validation, and utilities
  database/       Drizzle schema and PostgreSQL migrations
  bot/            grammY runtime, commands, middleware, and tools
  server/         Hono API, authentication, bot lifecycle, and integrations
  panel/          React 19 and Refine admin panel and Telegram Mini App
  docs/           Public Fumadocs site served at /docs
  coding-worker/  Isolated Pi coding worker
```

## Environment variables

See [.env.example](.env.example) and the [configuration guide](packages/docs/content/docs/self-hosting/configuration.mdx) for the full list.

| Setting                                                                                                          | Purpose                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PASSWORD`, `DATABASE_URL`                                                                                    | Compose builds the database URL from the password. Source deployments use the PostgreSQL connection URL.                        |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`                                                                          | An independent authentication secret of at least 32 characters and the panel's public origin.                                   |
| `AUTH_OWNER_EMAIL`, `PANEL_PASSWORD`                                                                             | Email and initial password for the first owner account. Remove the initial password from the environment after the first login. |
| `ENCRYPTION_KEY`                                                                                                 | Encrypts bot tokens and other sensitive fields. Preserve this key across upgrades and restores.                                 |
| `BOT_TOKEN`, `ADMIN_CHAT_IDS`                                                                                    | Optional Telegram bot and administrator settings for initial migration.                                                         |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                       | Optional Google OAuth credentials.                                                                                              |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | Set all five for a GitHub App, or leave all five empty. Store the PEM as one line with literal `\n` separators.                 |

To enable the Pi coding worker, configure `CODING_WORKER_SECRET` and set `COMPOSE_PROFILES=coding` (or `dokploy,coding` on Dokploy). The optional Dev Harness connects Telegram topics to pull requests. Set its configuration path with `HARNESS_CONFIG_PATH` and webhook secret with `HARNESS_GITHUB_WEBHOOK_SECRET`. The Lody bridge uses `HARNESS_LODY_BRIDGE_URL`, `HARNESS_LODY_BRIDGE_SECRET`, and a bridge-only `LODY_CLI_TOKEN`. See [the harness example](harness.example.yaml).

## Contributing and security

- [Contribution guide](CONTRIBUTING.md)
- [Private security reporting](SECURITY.md)
- [MIT License](LICENSE)
