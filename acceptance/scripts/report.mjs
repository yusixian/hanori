import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const latest = path.join(root, ".acceptance", "latest");

function resolveRunDir() {
  const stat = fs.lstatSync(latest);
  if (stat.isSymbolicLink()) return path.resolve(path.dirname(latest), fs.readlinkSync(latest));
  return path.join(root, ".acceptance", "runs", fs.readFileSync(latest, "utf8").trim());
}

const runDir = resolveRunDir();
const index = JSON.parse(fs.readFileSync(path.join(runDir, "evidence-index.json"), "utf8"));
const reviewPath = path.join(runDir, "visual-review.json");
const review = fs.existsSync(reviewPath)
  ? JSON.parse(fs.readFileSync(reviewPath, "utf8"))
  : { cases: [] };
const reviewByKey = new Map(review.cases.map((entry) => [`${entry.project}::${entry.id}`, entry]));

const css = fs.readFileSync(path.join(here, "report-assets", "report.css"), "utf8");
const js = fs.readFileSync(path.join(here, "report-assets", "report.js"), "utf8");

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Final status: automation + visual review combined.
function finalStatus(entry, visual) {
  if (entry.status !== "passed") return "FAIL";
  const d = entry.diagnostics;
  const unexpected =
    d.pageErrors.length > 0 ||
    d.consoleErrors.length > 0 ||
    d.failedRequests.length > 0 ||
    d.httpErrors.some((e) => e.status >= 500) ||
    d.horizontalOverflow;
  if (entry.visualRequired === false) return unexpected ? "UNCERTAIN" : "PASS";
  if (!visual) return "UNCERTAIN";
  if (visual.status === "fail") return "FAIL";
  if (visual.status === "blocked") return "BLOCKED";
  if (visual.status === "uncertain") return "UNCERTAIN";
  return unexpected ? "UNCERTAIN" : "PASS";
}

// Tolerate legacy harness evidence fields (badResponses/title/duration/
// horizontalOverflow) so older runs still show up in the run history.
function normalizeEntry(entry) {
  const d = entry.diagnostics ?? {};
  const meta = entry.meta ?? {};
  return {
    ...entry,
    id: entry.id ?? meta.id ?? "unknown",
    feature: entry.feature ?? meta.feature ?? null,
    severity: entry.severity ?? meta.severity ?? null,
    visualRequired: entry.visualRequired ?? meta.visualRequired ?? true,
    steps: entry.steps ?? meta.steps ?? [],
    expected: entry.expected ?? meta.expected ?? [],
    testTitle: entry.testTitle ?? entry.title ?? meta.id ?? "unknown",
    durationMs: entry.durationMs ?? entry.duration ?? 0,
    checkpoints: (entry.checkpoints ?? []).map((c) => ({
      ...c,
      overflow: c.overflow ?? c.horizontalOverflow ?? false,
    })),
    diagnostics: {
      consoleErrors: d.consoleErrors ?? [],
      pageErrors: d.pageErrors ?? [],
      failedRequests: d.failedRequests ?? [],
      httpErrors: d.httpErrors ?? d.badResponses ?? [],
      horizontalOverflow: d.horizontalOverflow ?? false,
    },
  };
}

const STATUS_LABEL = { PASS: "Passed", FAIL: "Failed", UNCERTAIN: "Uncertain", BLOCKED: "Blocked" };
const STATUS_ICON = { PASS: "✓", FAIL: "✕", UNCERTAIN: "?", BLOCKED: "–" };

// Pairing convention: checkpoints named `before:<label>` / `after:<label>` with
// the same label render as a single <img-compare> slider.
function buildShots(entry) {
  const shots = [];
  const pending = new Map(); // label -> { before?, after? }
  for (const cp of entry.checkpoints) {
    const match = /^(before|after):(.+)$/.exec(cp.name);
    if (match) {
      const [, kind, label] = match;
      const pair = pending.get(label) ?? {};
      pair[kind] = cp;
      pending.set(label, pair);
    } else {
      shots.push({ type: "img", path: cp.path, caption: cp.name });
    }
  }
  for (const [label, pair] of pending) {
    if (pair.before && pair.after) {
      shots.unshift({
        type: "compare",
        before: pair.before.path,
        after: pair.after.path,
        caption: `Compare · ${label}`,
      });
    } else {
      for (const lone of [pair.before, pair.after].filter(Boolean)) {
        shots.push({ type: "img", path: lone.path, caption: lone.name });
      }
    }
  }
  if (entry.finalScreenshot) {
    shots.push({ type: "img", path: entry.finalScreenshot, caption: "final" });
  }
  return shots;
}

function renderShot(entry, shot) {
  const caption = `${entry.id} (${entry.project}) · ${shot.caption}`;
  if (shot.type === "compare") {
    return `<figure class="shot compare" data-lightbox="compare" data-before="${escapeHtml(shot.before)}" data-after="${escapeHtml(shot.after)}" data-caption="${escapeHtml(caption)}">
  <img-compare before="${escapeHtml(shot.before)}" after="${escapeHtml(shot.after)}"></img-compare>
  <figcaption>${escapeHtml(shot.caption)}</figcaption>
</figure>`;
  }
  return `<figure class="shot" data-lightbox="img" data-src="${escapeHtml(shot.path)}" data-caption="${escapeHtml(caption)}">
  <img src="${escapeHtml(shot.path)}" loading="lazy" alt="${escapeHtml(shot.caption)}">
  <figcaption>${escapeHtml(shot.caption)}</figcaption>
</figure>`;
}

function renderDiagnostics(d) {
  const lines = [
    d.horizontalOverflow ? "horizontal overflow: true" : "",
    ...d.pageErrors.map((e) => `pageerror: ${e}`),
    ...d.consoleErrors.map((e) => `console.error: ${e}`),
    ...d.failedRequests.map((e) => `requestfailed: ${e}`),
    ...d.httpErrors.map((e) => `http ${e.status}: ${e.url}`),
  ].filter(Boolean);
  if (!lines.length) return "";
  return `<div class="diag">${escapeHtml(lines.join("\n"))}</div>`;
}

const allRows = index.cases.map((raw) => {
  const entry = normalizeEntry(raw);
  const visual = reviewByKey.get(`${entry.project}::${entry.id}`) ?? null;
  return { ...entry, visual, final: finalStatus(entry, visual) };
});
// 有意跳过的用例(如仅桌面/仅移动)不计入结论,也不进面板
const rows = allRows.filter((row) => row.status !== "skipped");
const skippedCount = allRows.length - rows.length;

const counts = { PASS: 0, FAIL: 0, UNCERTAIN: 0, BLOCKED: 0 };
for (const row of rows) counts[row.final] += 1;
const overall =
  counts.FAIL > 0 ? "FAIL" : counts.UNCERTAIN > 0 || counts.BLOCKED > 0 ? "UNCERTAIN" : "PASS";

// Run history: summarize every run with the same verdict rules; the sidebar
// cross-links each run's report.
function summarizeRun(dir) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, "evidence-index.json"), "utf8"));
    if (!idx.cases?.length) return null;
    const revPath = path.join(dir, "visual-review.json");
    const rev = fs.existsSync(revPath)
      ? JSON.parse(fs.readFileSync(revPath, "utf8"))
      : { cases: [] };
    const byKey = new Map(rev.cases.map((e) => [`${e.project}::${e.id}`, e]));
    const c = { PASS: 0, FAIL: 0, UNCERTAIN: 0, BLOCKED: 0 };
    for (const raw of idx.cases) {
      const entry = normalizeEntry(raw);
      if (entry.status === "skipped") continue;
      const visual = byKey.get(`${entry.project}::${entry.id}`) ?? null;
      c[finalStatus(entry, visual)] += 1;
    }
    return {
      runId: idx.runId,
      generatedAt: idx.generatedAt,
      total: idx.cases.length,
      counts: c,
      overall: c.FAIL > 0 ? "FAIL" : c.UNCERTAIN > 0 || c.BLOCKED > 0 ? "UNCERTAIN" : "PASS",
    };
  } catch {
    return null;
  }
}

const runsRoot = path.join(root, ".acceptance", "runs");
const history = fs
  .readdirSync(runsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => summarizeRun(path.join(runsRoot, d.name)))
  .filter(Boolean)
  .sort((a, b) => b.runId.localeCompare(a.runId));

const runHistory = history.length
  ? `<aside class="runs">
  <h2>Run history <span class="n">${history.length}</span></h2>
  ${history
    .map((h, i) => {
      const round = history.length - i;
      const parts = [
        `pass ${h.counts.PASS}`,
        `fail ${h.counts.FAIL}`,
        `uncertain ${h.counts.UNCERTAIN}`,
      ];
      if (h.counts.BLOCKED) parts.push(`blocked ${h.counts.BLOCKED}`);
      return `<a class="run${h.runId === index.runId ? " current" : ""}" href="../${escapeHtml(h.runId)}/report.html">
    <span class="run-head"><strong>Round ${round}</strong><span class="overall-badge ${h.overall}">${STATUS_LABEL[h.overall]}</span></span>
    <span class="run-id">${escapeHtml(h.runId)}</span>
    <span class="run-counts">${parts.join(" · ")}</span>
  </a>`;
    })
    .join("\n")}
</aside>`
  : "";

const casePanels = rows
  .map((row) => {
    const shots = buildShots(row);
    const steps = row.steps ?? [];
    const expected = row.expected ?? [];
    return `<details class="case" data-final="${row.final}">
  <summary>
    <span class="status-icon ${row.final}">${STATUS_ICON[row.final]}</span>
    <span class="case-title">
      <span class="name">${escapeHtml(row.id)}${row.feature ? ` · ${escapeHtml(row.feature)}` : ""}</span>
      <span class="sub">
        <span>${escapeHtml(row.project)}</span>
        ${row.severity ? `<span class="sev ${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span>` : ""}
        <span>automation ${escapeHtml(row.status)}</span>
        <span>${Math.round(row.durationMs / 1000)}s</span>
      </span>
    </span>
    <span class="case-badges">
      ${shots.length ? `<span class="media-badge">${shots.length} img</span>` : ""}
      <span class="chevron">▶</span>
    </span>
  </summary>
  <div class="case-body">
    <dl class="kv">
      ${steps.length ? `<dt>Steps</dt><dd><ol>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol></dd>` : ""}
      ${expected.length ? `<dt>Expected</dt><dd><ul>${expected.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></dd>` : ""}
      <dt>Review</dt><dd class="review-note">${
        row.visual
          ? `${STATUS_LABEL[row.visual.status] ?? row.visual.status}(${row.visual.confidence})${row.visual.notes ? ` — ${escapeHtml(row.visual.notes)}` : ""}`
          : "Not reviewed"
      }</dd>
    </dl>
    ${renderDiagnostics(row.diagnostics)}
    ${shots.length ? `<div class="shots">${shots.map((s) => renderShot(row, s)).join("\n")}</div>` : ""}
  </div>
</details>`;
  })
  .join("\n");

const chip = (filter, label, count) =>
  `<button class="chip" data-filter="${filter}" aria-pressed="${filter === "ALL"}">${filter === "ALL" ? "" : `<span class="dot ${filter}"></span>`}${label} <span class="n">${count}</span></button>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceptance report — ${escapeHtml(index.runId)}</title>
<style>${css}</style>
</head>
<body>
<div class="page">
  <header class="report-head">
    <h1>Acceptance report <span class="overall-badge ${overall}">${STATUS_LABEL[overall]}</span></h1>
    <div class="meta">
      <span>run ${escapeHtml(index.runId)}</span>
      <span>${escapeHtml(index.generatedAt)}</span>
      <span>${rows.length} cases${skippedCount ? ` · ${skippedCount} skipped` : ""}</span>
    </div>
  </header>
  <nav class="chips" aria-label="Filter by outcome">
    ${chip("ALL", "All", rows.length)}
    ${chip("FAIL", "Failed", counts.FAIL)}
    ${chip("UNCERTAIN", "Uncertain", counts.UNCERTAIN)}
    ${chip("BLOCKED", "Blocked", counts.BLOCKED)}
    ${chip("PASS", "Passed", counts.PASS)}
  </nav>
  <div class="layout">
    <main>
${casePanels}
    </main>
    ${runHistory}
  </div>
  <footer class="foot">
    <span>evidence-index.json / visual-review.json / summary.md</span>
    <span>Click an image to open the lightbox; before:/after: checkpoints pair into comparison sliders</span>
  </footer>
</div>
<div class="lightbox" hidden>
  <div class="lightbox-bar">
    <span class="lightbox-counter"></span>
    <button class="lightbox-close" type="button" aria-label="Close">✕</button>
  </div>
  <div class="lightbox-stage">
    <button class="lightbox-nav prev" type="button" aria-label="Previous">‹</button>
    <button class="lightbox-nav next" type="button" aria-label="Next">›</button>
  </div>
  <div class="lightbox-caption"></div>
</div>
<script>${js}</script>
</body>
</html>
`;

fs.writeFileSync(path.join(runDir, "report.html"), html);

const md = `# Acceptance summary — ${index.runId}

- PASS: ${counts.PASS}
- FAIL: ${counts.FAIL}
- UNCERTAIN: ${counts.UNCERTAIN}
- BLOCKED: ${counts.BLOCKED}

| Case | Project | Severity | Automation | Visual | Final |
| --- | --- | --- | --- | --- | --- |
${rows
  .map(
    (row) =>
      `| ${row.id} | ${row.project} | ${row.severity ?? "-"} | ${row.status} | ${row.visual ? `${row.visual.status} (${row.visual.confidence})` : "missing"} | ${row.final} |`,
  )
  .join("\n")}

${
  rows.filter((r) => r.final === "UNCERTAIN" || r.final === "BLOCKED").length
    ? `## Needs human review\n\n${rows
        .filter((r) => r.final === "UNCERTAIN" || r.final === "BLOCKED")
        .map(
          (r) =>
            `- **${r.id}** (${r.project}): ${r.final}${r.visual?.notes ? ` — ${r.visual.notes}` : ""}`,
        )
        .join("\n")}`
    : ""
}
`;
fs.writeFileSync(path.join(runDir, "summary.md"), md);

console.log(`[acceptance:report] ${path.relative(root, runDir)}/report.html`);
console.log(`[acceptance:report] ${path.relative(root, runDir)}/summary.md`);
console.log(
  `[acceptance:report] PASS ${counts.PASS} / FAIL ${counts.FAIL} / UNCERTAIN ${counts.UNCERTAIN} / BLOCKED ${counts.BLOCKED}`,
);
