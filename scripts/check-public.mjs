import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileHash, isPublicPath, parsePublicJson, scanPublicFile } from "./lib/public-export.mjs";

const { values } = parseArgs({ options: { dir: { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  process.stdout.write(
    "Usage: pnpm public:check --dir /tmp/public-snapshot\nChecks snapshot paths, hashes and known credential/privacy patterns; not a complete secret audit.\n",
  );
} else {
  if (!values.dir) throw new Error("Provide --dir.");
  const root = resolve(values.dir);
  const manifestPath = resolve(root, ".public-manifest.json");
  if (!(await lstat(manifestPath)).isFile()) throw new Error("Unsupported manifest file.");
  const manifest = parsePublicJson(await readFile(manifestPath, "utf8"), ".public-manifest.json");
  if (manifest.format !== 1 || !manifest.files || typeof manifest.files !== "object")
    throw new Error("Unsupported snapshot manifest.");
  const permitted = new Set([
    "readme.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ".github/workflows/ci.yml",
  ]);
  const found = new Set();
  const problems = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) {
        problems.push(`${path} [symlink]`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(resolve(directory, entry.name), `${path}/`);
        continue;
      }
      if (path === ".public-manifest.json") continue;
      found.add(path);
      if (!isPublicPath(path) && !permitted.has(path)) problems.push(`${path} [unapproved-path]`);
      const data = await readFile(resolve(root, path));
      if (fileHash(data) !== manifest.files[path]) problems.push(`${path} [changed-or-unlisted]`);
      for (const finding of scanPublicFile(path, data))
        problems.push(`${path}:${finding.line} [${finding.rule}]`);
    }
  }
  await walk(root);
  for (const path of Object.keys(manifest.files))
    if (!found.has(path)) problems.push(`${path} [missing]`);
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    throw new Error("Snapshot verification failed; matched values are not printed.");
  }
  process.stdout.write(
    `Verified ${found.size} snapshot files. ${manifest.reviewOnly ? "Review-only snapshot; do not release. " : ""}Pattern checks cannot prove that all secrets are absent.\n`,
  );
}
