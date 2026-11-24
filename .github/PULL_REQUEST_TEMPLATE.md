## Related issue

<!-- Add Closes #123 if this PR resolves the issue, or Refs #123 if it contributes to it. -->

## Summary

<!-- Describe what changed and why. Call out migrations or deployment changes when applicable. -->

## Verification

<!-- Check each item you ran. List skipped or inapplicable checks and the reason under Not verified. -->

- [ ] `pnpm lint` and `pnpm fmt:check`
- [ ] `pnpm typecheck` and `pnpm test` for code changes
- [ ] `pnpm build` for build, bundling or production changes
- [ ] `pnpm test:browser` for panel or Mini App changes
- [ ] Panel and Mini App copy updated in both `en` and `zh-CN`, with `pnpm i18n:check` passing
- [ ] Public guides updated for changes to user-facing behavior, configuration, permissions or deployment
- [ ] `pnpm --filter @cos-tool-bot/docs typecheck`, `pnpm build:docs` and `pnpm test:docs` for public docs changes

### Not verified

<!-- Name each skipped check or untested path and why. -->
