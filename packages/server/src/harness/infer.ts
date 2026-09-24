import { isPlainObject } from "./config/layers.js";
import { DEFAULT_PREFER_SKILLS, type ProjectKind } from "./config/schema.js";
import type { DirectoryEntry, HarnessGitHub } from "./github.js";

/** What inference reads from the default branch; kept small so a refresh stays a few requests. */
export interface RepoFacts {
  root: DirectoryEntry[];
  packageJson: string | null;
  projectSwift: string | null;
  /** Default skill names the repo defines itself under `.agents/skills` or `.claude/skills`. */
  repoSkills: string[];
}

type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const SKILL_DIRS = [".agents/skills", ".claude/skills"];
const APP_FRAMEWORKS = [
  "next",
  "nuxt",
  "astro",
  "gatsby",
  "react-scripts",
  "@sveltejs/kit",
  "@remix-run/react",
  "@react-router/dev",
];
const SERVER_FRAMEWORKS = ["express", "fastify", "hono", "koa", "@nestjs/core"];
const FRONTEND_LIBS = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "solid-js",
  "vite",
  ...APP_FRAMEWORKS,
];
const ACCEPTANCE_SCRIPTS = ["test:e2e", "test:desktop", "e2e"];

function has(root: readonly DirectoryEntry[], name: string, type?: DirectoryEntry["type"]) {
  return root.some((entry) => entry.name === name && (!type || entry.type === type));
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function detectPackageManager(pkg: Record<string, unknown>, root: readonly DirectoryEntry[]) {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") {
    return declared;
  }
  if (has(root, "pnpm-lock.yaml")) return "pnpm";
  if (has(root, "yarn.lock")) return "yarn";
  if (has(root, "bun.lock") || has(root, "bun.lockb")) return "bun";
  return "npm";
}

function runScript(manager: PackageManager, script: string): string {
  if (manager === "pnpm" || manager === "yarn") return `${manager} ${script}`;
  return `${manager} run ${script}`;
}

function inferJavaScript(pkg: Record<string, unknown>, root: readonly DirectoryEntry[]) {
  const manager = detectPackageManager(pkg, root);
  const scripts = stringRecord(pkg.scripts);
  const deps = { ...stringRecord(pkg.dependencies), ...stringRecord(pkg.devDependencies) };
  const uses = (names: readonly string[]) => names.some((name) => name in deps);
  const kind: ProjectKind =
    "electron" in deps
      ? "electron"
      : (pkg.bin !== undefined || pkg.exports !== undefined) && !uses(APP_FRAMEWORKS)
        ? "library"
        : uses(SERVER_FRAMEWORKS) && !uses(FRONTEND_LIBS)
          ? "service"
          : "web";
  // npm init writes a failing placeholder test script.
  const usable = (name: string) =>
    scripts[name] !== undefined && !scripts[name]!.includes("no test specified");
  const quick = ["lint", "typecheck", "test"].filter(usable);
  const full = ["verify", "check"].find(usable);
  const acceptance = ACCEPTANCE_SCRIPTS.find(usable);
  return {
    kind,
    verify: {
      quick: quick.length > 0 ? quick.map((name) => runScript(manager, name)).join(" && ") : null,
      full: full ? runScript(manager, full) : null,
      acceptance: acceptance ? runScript(manager, acceptance) : null,
    },
  };
}

function swiftProjectName(projectSwift: string | null, repoName: string): string {
  const match = projectSwift ? /Project\s*\(\s*name:\s*"([^"]+)"/.exec(projectSwift) : null;
  return match?.[1] ?? repoName;
}

function inferNonJavaScript(facts: RepoFacts, repoName: string) {
  const { root } = facts;
  const tuist = has(root, "Tuist.swift") || has(root, "Project.swift") || has(root, "Tuist", "dir");
  if (tuist) {
    const name = swiftProjectName(facts.projectSwift, repoName);
    const workspace = `-workspace ${name}.xcworkspace -scheme ${name}`;
    return {
      kind: "native" as const,
      verify: {
        quick: `tuist install && tuist generate --no-open && xcodebuild ${workspace} -configuration Debug build`,
        full: `xcodebuild test ${workspace}`,
        acceptance: null,
      },
    };
  }
  const xcode = root.some((entry) => /\.(xcodeproj|xcworkspace)$/.test(entry.name));
  if (xcode) return { kind: "native" as const, verify: null };
  if (has(root, "Package.swift")) {
    return { kind: "library" as const, verify: { quick: "swift build && swift test" } };
  }
  if (has(root, "Cargo.toml")) return { kind: "library" as const, verify: { quick: "cargo test" } };
  if (has(root, "go.mod")) return { kind: "service" as const, verify: { quick: "go test ./..." } };
  return null;
}

function withoutNulls(verify: { [name: string]: string | null | undefined } | null) {
  if (!verify) return null;
  const entries = Object.entries(verify).filter(([, value]) => typeof value === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * Pure: turns default-branch facts into a partial `.cos/harness.yml`. Only fields it is confident
 * about are set, so everything else keeps the built-in defaults and `sourceOf` stays honest.
 */
export function inferRepoPolicy(facts: RepoFacts, repoName: string): Record<string, unknown> {
  const pkg = parseJson(facts.packageJson);
  const inferred = pkg ? inferJavaScript(pkg, facts.root) : inferNonJavaScript(facts, repoName);
  const policy: Record<string, unknown> = {};
  if (inferred) {
    policy.kind = inferred.kind;
    const verify = withoutNulls(inferred.verify);
    if (verify) policy.verify = verify;
  }
  const own = new Set(facts.repoSkills);
  if (DEFAULT_PREFER_SKILLS.some((skill) => own.has(skill))) {
    policy.prompts = { preferSkills: DEFAULT_PREFER_SKILLS.filter((skill) => !own.has(skill)) };
  }
  return policy;
}

/** At most 2 + 2 directory listings and one SKILL.md read per default skill the repo shadows. */
export async function readRepoFacts(
  github: HarnessGitHub,
  repo: string,
  ref: string,
): Promise<RepoFacts> {
  const root = (await github.listDirectory(repo, "", ref)) ?? [];
  const packageJson = has(root, "package.json")
    ? await github.getFile(repo, "package.json", ref)
    : null;
  const projectSwift =
    !packageJson && has(root, "Project.swift")
      ? await github.getFile(repo, "Project.swift", ref)
      : null;
  const repoSkills = new Set<string>();
  for (const dir of SKILL_DIRS) {
    if (!has(root, dir.split("/")[0]!, "dir")) continue;
    const entries = (await github.listDirectory(repo, dir, ref)) ?? [];
    for (const entry of entries) {
      if (entry.type !== "dir" || repoSkills.has(entry.name)) continue;
      if (!DEFAULT_PREFER_SKILLS.includes(entry.name)) continue;
      if ((await github.getFile(repo, `${dir}/${entry.name}/SKILL.md`, ref)) !== null) {
        repoSkills.add(entry.name);
      }
    }
  }
  return { root, packageJson, projectSwift, repoSkills: [...repoSkills] };
}
