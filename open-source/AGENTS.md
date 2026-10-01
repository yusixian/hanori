# Repository guide

This is a pnpm ESM monorepo: Node >=22.19, pnpm 10.5.2, TypeScript, Hono, React, Drizzle, grammY.
Current source and package.json take precedence over documentation.

- Keep changes scoped; reuse existing helpers and domain types.
- Do not commit, push, deploy, publish a release or access production data unless requested.
- Never include credentials, runtime data or personal identity maps. Use non-secret examples.
- Keep relative TypeScript imports suffixed with .js and shared independent of runtime packages.
- Preserve chained Hono registrations for RPC type inference, auth ordering and tenant scoping.
- Telegram commands belong in TELEGRAM_COMMAND_CATALOG and ActiveCommandRegistry. Preserve serialization and cancellation.
- Change schema.ts and generate migrations; never rewrite deployed migrations or hand-edit snapshots.
- Keep panel copy in both en and zh-CN. Real Mini App access requires signed Telegram initData.
- Coding worker is a trust boundary. GitHub credentials, push and PR confirmation stay on the server.
- Update affected public guides in packages/docs/content/docs with behavior and configuration changes.
- Run relevant tests first, then lint, fmt:check, typecheck, i18n:check and test; add test:browser for panel changes and build for production paths. Report limitations.
- Public CI uses GitHub-hosted runners without production credentials. Do not run public PR code on a maintainer's self-hosted machine.
- Product version is the root package.json version; deployment APP_VERSION remains a full Git SHA.
- Release sources are docs/releases/vX.Y.Z.md. Generated MDX changelogs must not be committed.
- Preserve Compose project/volume names, database name, auth organization slug and ENCRYPTION_KEY during display-name changes.
