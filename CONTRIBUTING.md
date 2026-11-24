# Contributing

## Report a problem or propose a feature

Search existing issues, then choose [Bug report, Feature request or Self-hosting help](https://github.com/yusixian/hanori/issues/new/choose). For deployment problems, start with the [self-hosting FAQ](packages/docs/content/docs/self-hosting/troubleshooting.mdx). Share the affected version, deployment method and the smallest reproduction that illustrates the problem. Remove credentials and personal data from logs and screenshots. Follow [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## Develop locally

Use Node.js 22.19 or newer and pnpm 10.5.2. Follow [AGENTS.md](AGENTS.md) for repository conventions.

```bash
pnpm install --frozen-lockfile
pnpm dev:docs
```

The documentation is available at `http://localhost:43102/docs/`. To work on the server or panel, follow [local setup](docs/SETUP.md) to configure a development `.env`, start PostgreSQL with `pnpm dev:db` and apply migrations with `pnpm db:migrate`. Run `pnpm dev` to start the server, panel and docs. For Mini App work, use the separate [Telegram Mini App workflow](docs/TELEGRAM_MINI_APP_LOCAL_DEV.md).

## Submit a pull request

Keep each PR focused, link the relevant issue and add tests for changed behavior. Add database migrations in order and keep generated changelog pages in sync via the docs build.

- Run `pnpm lint` and `pnpm fmt:check`. For code changes run `pnpm typecheck` and `pnpm test`. Run `pnpm build` for bundling or production path changes.
- For panel or Mini App changes run `pnpm test:browser`. Update visible copy in both `en` and `zh-CN` and run `pnpm i18n:check` when copy changes.
- Update [public guides](packages/docs/content/docs/) when behavior, configuration, permissions or deployment changes. For docs changes run `pnpm --filter @cos-tool-bot/docs typecheck`, `pnpm build:docs` and `pnpm test:docs`.
- Report the checks you ran and list any verification gaps in the PR. Verify protected Mini App flows in the real Telegram WebView.

MIT applies to contributions. Submit only code, text and assets you have the right to distribute. External services, models and media have their own terms.
