import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileHash, isPublicPath, parsePublicJson } from "./lib/public-export.mjs";

const { values } = parseArgs({
  options: {
    snapshot: { type: "string" },
    into: { type: "string" },
    apply: { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage: pnpm public:sync --snapshot /tmp/snapshot --into /path/to/public-checkout [--apply]\nDefaults to a plan. Requires a clean public feature branch with an existing public manifest; never commits or pushes.\n",
  );
} else {
  if (!values.snapshot || !values.into) throw new Error("Provide --snapshot and --into.");
  const snapshot = await realpath(resolve(values.snapshot));
  const target = await realpath(resolve(values.into));
  const sourceRoot = await realpath(resolve(import.meta.dirname, ".."));
  const git = (...args) =>
    execFileSync("git", ["-C", target, ...args], { encoding: "utf8" }).trim();
  if (target === sourceRoot || (await realpath(git("rev-parse", "--show-toplevel"))) !== target)
    throw new Error("Use a separate public repository root.");
  if (
    (await realpath(resolve(target, git("rev-parse", "--git-common-dir")))) ===
    (await realpath(resolve(sourceRoot, gitForSource())))
  )
    throw new Error("Public checkout must not share the private repository's Git metadata.");
  if (["", "main", "master"].includes(git("branch", "--show-current")))
    throw new Error("Create a public feature branch before applying a snapshot.");
  if (git("status", "--porcelain")) throw new Error("Public checkout must be clean.");
  execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, "check-public.mjs"), "--dir", snapshot],
    { stdio: "pipe" },
  );
  const next = JSON.parse(await readFile(resolve(snapshot, ".public-manifest.json"), "utf8"));
  if (next.reviewOnly)
    throw new Error("Only committed snapshots may be synchronized. --worktree is review-only.");
  const manifestPath = resolve(target, ".public-manifest.json");
  if (!(await lstat(manifestPath)).isFile()) throw new Error("Unsupported manifest file.");
  const previous = parsePublicJson(await readFile(manifestPath, "utf8"), ".public-manifest.json");
  if (previous.format !== 1 || !previous.files)
    throw new Error("Public checkout has no supported baseline manifest.");
  const changes = [];
  const conflicts = [];
  for (const path of new Set([...Object.keys(previous.files), ...Object.keys(next.files)])) {
    if (
      !isPublicPath(path) &&
      ![
        "readme.md",
        "AGENTS.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        ".github/workflows/ci.yml",
      ].includes(path)
    )
      throw new Error(`Unapproved manifest path: ${path}`);
    const destination = resolve(target, path);
    const rel = relative(target, destination);
    if (
      !rel ||
      rel.startsWith(`..${sep}`) ||
      path.includes("\\") ||
      path.split("/").includes(".git")
    )
      throw new Error(`Unsafe manifest path: ${path}`);
    // Reject symlinked parent directories as well as symlinked files.
    let parent = dirname(destination);
    while (parent !== target) {
      try {
        if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Symlinked parent: ${path}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      parent = dirname(parent);
    }
    let current;
    try {
      if (!(await lstat(destination)).isFile()) throw new Error(`Unsupported destination: ${path}`);
      current = fileHash(await readFile(destination));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === next.files[path]) continue;
    if (current !== previous.files[path]) {
      conflicts.push(path);
      continue;
    }
    changes.push({ path, destination, remove: !next.files[path] });
  }
  if (conflicts.length)
    throw new Error(
      `Import public changes into the private source before synchronizing these files:\n${conflicts.join("\n")}`,
    );
  for (const change of changes)
    process.stdout.write(`${change.remove ? "DELETE" : "WRITE"} ${change.path}\n`);
  if (values.apply) {
    for (const change of changes) {
      if (change.remove) await rm(change.destination);
      else {
        await mkdir(dirname(change.destination), { recursive: true });
        const origin = resolve(snapshot, change.path);
        const mode = (await lstat(origin)).mode & 0o777;
        await writeFile(change.destination, await readFile(origin), { mode });
        await chmod(change.destination, mode);
      }
    }
    await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  process.stdout.write(
    `${changes.length} managed file changes. ${values.apply ? "Review git diff before committing." : "Plan only; add --apply to update files."}\n`,
  );

  function gitForSource() {
    return execFileSync("git", ["-C", sourceRoot, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
  }
}
