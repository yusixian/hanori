import { parse as parseYaml } from "yaml";
import type { HarnessGitHub } from "./github.js";

export type Bump = "major" | "minor" | "patch";
export type ChangeKind = "breaking" | "feat" | "fix" | "other";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type ReleaseArg =
  | { kind: "auto" }
  | { kind: "bump"; bump: Bump }
  | { kind: "version"; version: SemVer };

export interface ReleaseChange {
  number: number | null;
  title: string;
  kind: ChangeKind;
}

export interface ReleaseWorkflow {
  file: string;
  patterns: string[];
}

export interface ReleasePlan {
  repo: string;
  defaultBranch: string;
  targetSha: string;
  previous: { tag: string; version: string; sha: string; hasRelease: boolean } | null;
  version: string;
  tag: string;
  /** Null when the owner named the version. */
  bump: Bump | null;
  highest: ChangeKind | null;
  /** Newest first, bounded. */
  changes: ReleaseChange[];
  commitCount: number;
  /** Workflows whose `on.push.tags` matches the tag. */
  workflows: ReleaseWorkflow[];
  releaseKit: ReleaseKitInfo | null;
}

export interface ReleaseKitInfo {
  breakingPre1: Bump | null;
  /** `versioning.tag`, e.g. `v{version}`. */
  tagTemplate: string | null;
  pendingChanges: number | null;
}

const MAX_TAGS = 500;
const MAX_PR_LOOKUPS = 30;
export const MAX_PLAN_CHANGES = 40;
const MAX_WORKFLOW_FILES = 20;
const WORKFLOW_DIR = ".github/workflows";
const STABLE = /^(v?)(\d+)\.(\d+)\.(\d+)$/;
const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:\s/;
const SQUASH_NUMBER = /\s\(#(\d+)\)$/;
const MERGE_NUMBER = /^Merge pull request #(\d+)\b/;

export const RELEASE_USAGE = "用法：/release [patch|minor|major|x.y.z]（在项目话题中）";

export function parseVersion(text: string): SemVer | null {
  const match = STABLE.exec(text.trim());
  if (!match) return null;
  return { major: Number(match[2]), minor: Number(match[3]), patch: Number(match[4]) };
}

export function formatVersion(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareVersions(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function bumpVersion(version: SemVer, bump: Bump): SemVer {
  if (bump === "major") return { major: version.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: version.major, minor: version.minor + 1, patch: 0 };
  return { ...version, patch: version.patch + 1 };
}

/** Accepts what `/release` accepts, so a suggested command can be checked before it is offered. */
export function parseReleaseArgs(args: string): ReleaseArg | null {
  const text = args.trim().toLowerCase();
  if (!text) return { kind: "auto" };
  if (text === "patch" || text === "minor" || text === "major") return { kind: "bump", bump: text };
  const version = parseVersion(text);
  return version ? { kind: "version", version } : null;
}

export function classifyChange(title: string, body = ""): ChangeKind {
  if (/^BREAKING[ -]CHANGE:/m.test(body)) return "breaking";
  const match = CONVENTIONAL.exec(title.trim());
  if (!match) return "other";
  if (match[2]) return "breaking";
  const type = match[1]!.toLowerCase();
  if (type === "feat") return "feat";
  if (type === "fix" || type === "perf" || type === "revert") return "fix";
  return "other";
}

const RANK: Record<ChangeKind, number> = { other: 0, fix: 1, feat: 2, breaking: 3 };

export function highestChange(kinds: readonly ChangeKind[]): ChangeKind | null {
  return kinds.reduce<ChangeKind | null>(
    (best, kind) => (best === null || RANK[kind] > RANK[best] ? kind : best),
    null,
  );
}

/**
 * fix → patch, feat → minor, breaking → major; before 1.0 a breaking change bumps minor unless
 * release-kit's `versioning.pre1.breaking` says otherwise. No fix or feat still ships as a patch.
 */
export function bumpFor(kind: ChangeKind | null, current: SemVer, breakingPre1: Bump | null): Bump {
  if (kind === "breaking") return current.major === 0 ? (breakingPre1 ?? "minor") : "major";
  if (kind === "feat") return "minor";
  return "patch";
}

/** GitHub filter patterns: `*`, `**`, `[...]`, and `?`/`+` quantifying the preceding character. */
function globToRegExp(glob: string): RegExp | null {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    const close = char === "[" ? glob.indexOf("]", i + 2) : -1;
    if (char === "*") {
      const double = glob[i + 1] === "*";
      source += double ? ".*" : "[^/]*";
      if (double) i++;
    } else if (char === "?" || char === "+") source += char;
    else if (close !== -1) {
      source += `[${glob.slice(i + 1, close).replace(/[\\^\]]/g, "\\$&")}]`;
      i = close;
    } else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

export function tagMatches(patterns: readonly string[], tag: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (globToRegExp(negated ? pattern.slice(1) : pattern)?.test(tag)) matched = !negated;
  }
  return matched;
}

const asList = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];

/** `on.push.tags` of a workflow file, or null when a tag push does not trigger it. */
export function workflowTagPatterns(text: string): string[] | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  const on = (doc as { on?: unknown } | null)?.on;
  if (!on || typeof on !== "object" || Array.isArray(on)) return null;
  const push = (on as { push?: unknown }).push;
  if (!push || typeof push !== "object") return null;
  const patterns = asList((push as { tags?: unknown }).tags);
  return patterns.length > 0 ? patterns : null;
}

async function detectWorkflows(
  github: HarnessGitHub,
  repo: string,
  ref: string,
  tag: string,
  preferred: string | null,
): Promise<ReleaseWorkflow[]> {
  const entries = (await github.listDirectory(repo, WORKFLOW_DIR, ref)) ?? [];
  const files = entries
    .filter((entry) => entry.type === "file" && /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b === preferred) - Number(a === preferred))
    .slice(0, MAX_WORKFLOW_FILES);
  const found: ReleaseWorkflow[] = [];
  for (const file of files) {
    const text = await github.getFile(repo, `${WORKFLOW_DIR}/${file}`, ref);
    const patterns = text ? workflowTagPatterns(text) : null;
    if (patterns && tagMatches(patterns, tag)) found.push({ file, patterns });
  }
  return found;
}

interface ReleaseKitYaml {
  changes?: unknown;
  versioning?: { tag?: unknown; pre1?: { breaking?: unknown } };
}

/** Only the fields `/release` needs; release-kit itself is never run. */
async function readReleaseKit(
  github: HarnessGitHub,
  repo: string,
  ref: string,
): Promise<ReleaseKitInfo | null> {
  const text =
    (await github.getFile(repo, "release-kit.yaml", ref)) ??
    (await github.getFile(repo, "release-kit.yml", ref));
  if (text === null) return null;
  let config: ReleaseKitYaml = {};
  try {
    config = (parseYaml(text) as ReleaseKitYaml | null) ?? {};
  } catch {
    config = {};
  }
  const breaking = config.versioning?.pre1?.breaking;
  const tag = config.versioning?.tag;
  const changesDir =
    typeof config.changes === "string" && !config.changes.includes("..")
      ? config.changes.replace(/^\.\//, "").replace(/\/$/, "")
      : ".release/changes";
  const fragments = await github.listDirectory(repo, changesDir, ref);
  const bumps: readonly unknown[] = ["major", "minor", "patch"] satisfies Bump[];
  return {
    breakingPre1: bumps.includes(breaking) ? (breaking as Bump) : null,
    tagTemplate: typeof tag === "string" && tag.includes("{version}") ? tag : null,
    pendingChanges: fragments
      ? fragments.filter((entry) => entry.type === "file" && entry.name.endsWith(".md")).length
      : null,
  };
}

function fromCommit(message: string): ReleaseChange {
  const [subject = "", ...rest] = message.split("\n");
  const body = rest.join("\n");
  const merge = MERGE_NUMBER.exec(subject);
  if (merge) {
    const title = rest.map((line) => line.trim()).find(Boolean) ?? subject;
    return { number: Number(merge[1]), title, kind: classifyChange(title, body) };
  }
  const squash = SQUASH_NUMBER.exec(subject);
  const title = squash ? subject.slice(0, squash.index) : subject;
  return { number: squash ? Number(squash[1]) : null, title, kind: classifyChange(title, body) };
}

/** Newest first: each commit's merged PR when GitHub knows one (bounded), else the commit itself. */
async function collectChanges(
  github: HarnessGitHub,
  repo: string,
  branch: string,
  commits: ReadonlyArray<{ sha: string; message: string }>,
): Promise<ReleaseChange[]> {
  const seen = new Map<number, ReleaseChange>();
  const changes: ReleaseChange[] = [];
  let lookups = 0;
  for (const commit of [...commits].reverse()) {
    const own = fromCommit(commit.message);
    let change = own;
    if (lookups < MAX_PR_LOOKUPS) {
      lookups++;
      const pulls = await github.releases.listCommitPullRequests(repo, commit.sha);
      const pull = pulls.find((candidate) => candidate.mergedAt && candidate.baseRef === branch);
      if (pull) {
        const kind = highestChange([classifyChange(pull.title), own.kind])!;
        change = { number: pull.number, title: pull.title, kind };
      }
    }
    if (change.number !== null) {
      const existing = seen.get(change.number);
      if (existing) {
        existing.kind = highestChange([existing.kind, change.kind])!;
        continue;
      }
      seen.set(change.number, change);
    }
    changes.push(change);
  }
  return changes;
}

export type PlanResult = { ok: true; plan: ReleasePlan } | { ok: false; message: string };

/** Reads the default branch through the GitHub App; nothing is written. */
export async function computeReleasePlan(
  github: HarnessGitHub,
  input: { repo: string; arg: ReleaseArg; preferredWorkflow: string | null },
): Promise<PlanResult> {
  const { repo, arg } = input;
  const { branch, sha } = await github.getDefaultBranch(repo);
  const releaseKit = await readReleaseKit(github, repo, sha);
  const [tagPrefix = "", tagSuffix = ""] = releaseKit?.tagTemplate?.split("{version}") ?? [];
  const stable = (await github.releases.listTags(repo, MAX_TAGS)).flatMap((tag) => {
    const { name } = tag;
    const fits = name.startsWith(tagPrefix) && name.endsWith(tagSuffix);
    const core = fits ? name.slice(tagPrefix.length, name.length - tagSuffix.length) : "";
    const version = fits ? parseVersion(core) : null;
    return version ? [{ ...tag, version }] : [];
  });
  const latest = stable.reduce<(typeof stable)[number] | null>(
    (best, tag) => (!best || compareVersions(tag.version, best.version) > 0 ? tag : best),
    null,
  );
  const base = latest?.version ?? { major: 0, minor: 0, patch: 0 };
  const prefix = latest ? (latest.name.startsWith("v") ? "v" : "") : "v";

  let commits: Array<{ sha: string; message: string }>;
  let commitCount: number;
  if (latest) {
    const compared = await github.releases.compare(repo, latest.name, sha);
    commits = compared.status === "ahead" || compared.status === "diverged" ? compared.commits : [];
    commitCount = commits.length === 0 ? 0 : compared.totalCommits;
  } else {
    commits = (await github.listCommits(repo, MAX_PLAN_CHANGES)).reverse();
    commitCount = commits.length;
  }
  const changes = await collectChanges(github, repo, branch, commits);
  const highest = highestChange(changes.map((change) => change.kind));

  let bump: Bump | null = null;
  let next: SemVer;
  if (arg.kind === "version") {
    if (latest && compareVersions(arg.version, base) <= 0) {
      return {
        ok: false,
        message: `${formatVersion(arg.version)} 不高于当前版本 ${latest.name}`,
      };
    }
    next = arg.version;
  } else {
    bump =
      arg.kind === "bump" ? arg.bump : bumpFor(highest, base, releaseKit?.breakingPre1 ?? null);
    next = bumpVersion(base, bump);
  }
  const version = formatVersion(next);
  const tag = releaseKit?.tagTemplate?.replace("{version}", version) ?? `${prefix}${version}`;
  const previous = latest
    ? {
        tag: latest.name,
        version: formatVersion(latest.version),
        sha: latest.sha,
        hasRelease: (await github.releases.getReleaseByTag(repo, latest.name)) !== null,
      }
    : null;
  return {
    ok: true,
    plan: {
      repo,
      defaultBranch: branch,
      targetSha: sha,
      previous,
      version,
      tag,
      bump,
      highest,
      changes: changes.slice(0, MAX_PLAN_CHANGES),
      commitCount,
      workflows: await detectWorkflows(github, repo, sha, tag, input.preferredWorkflow),
      releaseKit,
    },
  };
}
