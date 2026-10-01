import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  fileHash,
  isPublicPath,
  sanitizePublicFile,
  scanPublicFile,
} from "./lib/public-export.mjs";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    ref: { type: "string", default: "HEAD" },
    worktree: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });

if (values.help) {
  process.stdout.write(
    "Usage: pnpm public:export --out /tmp/public-snapshot [--ref HEAD | --worktree]\nWrites a new directory with reviewed paths only, no Git history. --worktree is for local review, not release.\n",
  );
} else {
  if (!values.out) throw new Error("Provide --out with a NEW snapshot directory.");
  if (values.worktree && values.ref !== "HEAD") throw new Error("Choose --ref or --worktree.");
  const output = resolve(values.out);
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  const destination = resolve(parent, output.split(sep).at(-1));
  const rel = relative(root, destination);
  if (!rel || (!rel.startsWith(`..${sep}`) && !rel.startsWith(`.open-source${sep}`))) {
    throw new Error("Output must be outside the source tree or inside .open-source/.");
  }
  const commit = git("rev-parse", "--verify", "--end-of-options", `${values.ref}^{commit}`)
    .toString()
    .trim();
  const entries = git("ls-tree", "-rz", "--full-tree", commit)
    .toString()
    .split("\0")
    .filter(Boolean);
  const files = new Map(
    entries.map((entry) => {
      const [metadata, path] = entry.split("\t");
      const [mode, , blob] = metadata.split(" ");
      return [path, { mode, blob }];
    }),
  );
  // Untracked files never enter a review snapshot, except these explicit publication assets.
  const templates = new Map([
    ["open-source/readme.md", "readme.md"],
    ["open-source/AGENTS.md", "AGENTS.md"],
    ["open-source/CONTRIBUTING.md", "CONTRIBUTING.md"],
    ["open-source/SECURITY.md", "SECURITY.md"],
    ["open-source/ci.yml", ".github/workflows/ci.yml"],
  ]);
  const additions = [
    ".gitleaks.toml",
    "scripts/init-env.mjs",
    "scripts/init-env.test.mjs",
    "scripts/smoke-deployment.mjs",
    "scripts/smoke-deployment.test.mjs",
    "packages/shared/src/brand.ts",
    "packages/panel/src/components/hanori-mark.tsx",
    "packages/panel/src/pages/settings.css",
    "packages/panel/src/pages/settings.browser.test.tsx",
    "packages/docs/public/docs/brand/hanori-sakura-v1.webp",
    "packages/docs/public/docs/brand/README.md",
    "scripts/update-production.test.mjs",
    "packages/docs/content/docs/integrations/dev-harness.mdx",
  ];
  if (values.worktree) {
    for (const path of [...templates.keys(), ...additions]) {
      if (!files.has(path)) files.set(path, { mode: "100644" });
    }
  }
  const contents = new Map();
  const findings = [];
  for (const [path, entry] of files) {
    const target = templates.get(path) ?? path;
    if (!templates.has(path) && !isPublicPath(path)) continue;
    if (!/^(?:100644|100755)$/.test(entry.mode)) throw new Error(`Unsupported file type: ${path}`);
    let data;
    if (values.worktree) {
      const source = resolve(root, path);
      const resolved = await realpath(source);
      if (!resolved.startsWith(`${root}${sep}`) || !(await lstat(source)).isFile())
        throw new Error(`Unsafe source: ${path}`);
      data = await readFile(source);
    } else data = git("cat-file", "blob", entry.blob);
    data = sanitizePublicFile(target, data);
    findings.push(...scanPublicFile(target, data));
    contents.set(target, { data, mode: parseInt(entry.mode.slice(-3), 8) });
  }
  for (const path of templates.values()) {
    if (!contents.has(path)) throw new Error(`Snapshot source is missing public template: ${path}`);
  }
  if (findings.length) {
    for (const finding of findings)
      process.stderr.write(`${finding.path}:${finding.line} [${finding.rule}]\n`);
    throw new Error("Public snapshot blocked. Resolve findings; matched values are never printed.");
  }
  // Refuse any existing directory. Never overlay or erase an existing public checkout.
  await mkdir(destination);
  try {
    const manifest = {
      format: 1,
      productVersion: JSON.parse(contents.get("package.json").data).version,
      reviewOnly: Boolean(values.worktree),
      files: {},
    };
    for (const [path, { data, mode }] of [...contents].sort(([a], [b]) => a.localeCompare(b))) {
      await mkdir(dirname(resolve(destination, path)), { recursive: true });
      await writeFile(resolve(destination, path), data, { mode, flag: "wx" });
      manifest.files[path] = fileHash(data);
    }
    await writeFile(
      resolve(destination, ".public-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(
    `Exported ${contents.size} files; no Git history or runtime data. ${values.worktree ? "Review snapshot only. " : ""}Run public:check and review the diff before publication.\n`,
  );
}
