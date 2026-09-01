#!/usr/bin/env node
/**
 * Prune old acceptance runs.
 *
 *   node acceptance/scripts/clean.mjs [--keep N] [--all] [--dry-run]
 *
 * Retention: keep the newest N runs (default ACCEPTANCE_KEEP_RUNS or 10),
 * always protect the run that .acceptance/latest points to.
 * `--all` removes everything except the latest run.
 * run.mjs calls pruneRuns() automatically after each run with the same policy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const runsRoot = path.join(root, ".acceptance", "runs");
const latest = path.join(root, ".acceptance", "latest");

export function resolveLatestRunDir() {
  try {
    const stat = fs.lstatSync(latest);
    if (stat.isSymbolicLink()) {
      return path.resolve(path.dirname(latest), fs.readlinkSync(latest));
    }
    return path.join(root, ".acceptance", "runs", fs.readFileSync(latest, "utf8").trim());
  } catch {
    return null;
  }
}

export function pruneRuns({ keep = 10, dryRun = false } = {}) {
  if (!fs.existsSync(runsRoot)) return { removed: [], kept: [] };
  const protectedDir = resolveLatestRunDir();
  const runs = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(runsRoot, d.name);
      return { dir, name: d.name, mtimeMs: fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  const kept = [];
  runs.forEach((run, index) => {
    const isProtected =
      protectedDir !== null && path.resolve(run.dir) === path.resolve(protectedDir);
    if (isProtected || index < keep) {
      kept.push(run.name);
      return;
    }
    removed.push(run.name);
    if (!dryRun) fs.rmSync(run.dir, { force: true, recursive: true });
  });
  return { removed, kept };
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const keepFlag = args.indexOf("--keep");
  const keep = args.includes("--all")
    ? 1
    : keepFlag !== -1
      ? Number(args[keepFlag + 1])
      : Number(process.env.ACCEPTANCE_KEEP_RUNS ?? 10);
  if (!Number.isFinite(keep) || keep < 1) {
    console.error(`invalid keep value: ${keep}`);
    process.exit(1);
  }
  const { removed, kept } = pruneRuns({ dryRun, keep });
  console.log(
    `[acceptance:clean] ${dryRun ? "dry-run, nothing deleted" : "done"} — kept ${kept.length}, ${dryRun ? "would remove" : "removed"} ${removed.length}`,
  );
  for (const name of removed) console.log(`  - ${name}`);
}
