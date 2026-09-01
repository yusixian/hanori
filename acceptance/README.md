# UI acceptance harness

This repository's isolated Playwright acceptance environment covers the admin panel on desktop and mobile.

## Isolation

`pnpm acceptance` owns its test environment:

- independent `cos-bot-acceptance` Compose project with PostgreSQL database
  `cos_tool_bot_acceptance` on port `55434` by default
- API and built panel on `http://localhost:3100`
- throwaway owner credentials and encryption keys
- one inactive fake Telegram bot, with `BOT_TOKEN` empty
- a whitelisted child-process environment that excludes local integration credentials

Do not point this harness at a development or production database, and do not add real bot or integration credentials to its environment.

## Running

```bash
pnpm acceptance
pnpm acceptance --skip-build              # reuse packages/panel/dist
pnpm acceptance -- --grep "login"         # forward arguments to Playwright
```

- Desktop (1440×900) and mobile (390×844) projects run automatically.
- Override the dedicated database port with `ACCEPTANCE_DB_PORT` if needed.
- `ACCEPTANCE_VIDEO=on` keeps video for every case (use when validating motion).
- Artifacts land in `.acceptance/runs/<runId>/`; `.acceptance/latest` points at the newest run.
- Write visual verdicts to `.acceptance/runs/<runId>/visual-review.json` (see `visual-review.schema.json`), then `pnpm acceptance:report` emits `report.html` and `summary.md`.

## Cleanup

Old runs are pruned automatically after each run — the newest `ACCEPTANCE_KEEP_RUNS` (default `10`) are kept, and the run pointed to by `.acceptance/latest` is always protected. Set `ACCEPTANCE_KEEP_RUNS=0` to disable auto-cleanup. Manual pruning:

```bash
pnpm acceptance:clean              # same retention policy
pnpm acceptance:clean --keep 5     # keep only the newest 5 runs
pnpm acceptance:clean --all        # keep only the latest run
pnpm acceptance:clean --dry-run    # preview what would be removed
```

## Case conventions

```ts
import { expect, test } from "../fixtures";

test("...", async ({ page, acceptance }) => {
  acceptance.meta({
    id: "stable-case-id",
    feature: "Feature",
    severity: "P1",
    steps: ["..."],
    expected: ["..."],
    allowHttpStatuses: [401], // statuses this case triggers on purpose
  });
  await acceptance.checkpoint("modal-open"); // plain checkpoint → lightbox thumbnail
  await acceptance.checkpoint("before:layout"); // paired with the next one
  await acceptance.checkpoint("after:layout"); // → <img-compare> slider in the report
});
```

`report.html` is a self-contained dark report: collapsible case panels, status filter chips, an image lightbox (←/→/Esc), a run-history sidebar, and `before:`/`after:` checkpoint pairs rendered as draggable comparison sliders (a dependency-free `<img-compare>` Web Component in `scripts/report-assets/report.js`, reusable on its own). UI copy in the report is easy to localize — edit the strings in `scripts/report.mjs` to match your team.
