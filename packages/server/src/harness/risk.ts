import { RISK_TIERS, type RepoPolicy, type RiskTier } from "./config/schema.js";

/** Paths an agent could use to loosen its own limits; not configurable (dev-harness-config.md §2). */
export const FIXED_T3_PATTERNS = [
  ".github/hanori-policy.yml",
  ".cos/**",
  ".github/workflows/**",
  "release-kit.yaml",
  "release-kit.yml",
  "release-kit.json",
  "release-kit.config.*",
] as const;

const globCache = new Map<string, RegExp>();

function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

/** Anchored glob over `/`-separated paths: `**`, `*`, `?`, and `{a,b}`. */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let normalized = pattern.trim().replace(/^\.\//, "").replace(/^\//, "");
  if (normalized.endsWith("/")) normalized += "**";
  let source = "";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        const atSegmentEnd = normalized[index + 2] === "/";
        source += atSegmentEnd ? "(?:.*/)?" : ".*";
        index += atSegmentEnd ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = normalized.indexOf("}", index);
      if (end === -1) {
        source += "\\{";
        continue;
      }
      const options = normalized
        .slice(index + 1, end)
        .split(",")
        .map(escapeRegExp);
      source += `(?:${options.join("|")})`;
      index = end;
    } else {
      source += escapeRegExp(char);
    }
  }
  const regex = new RegExp(`^${source}$`);
  globCache.set(pattern, regex);
  return regex;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export interface ChangedFile {
  filename: string;
  status: string;
  previousFilename?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

export interface FileRisk {
  path: string;
  tier: RiskTier;
  rule: "fixed" | RiskTier | "default";
}

export interface RiskAssessment {
  tier: RiskTier;
  files: FileRisk[];
}

function tierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

export function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

function classifyPath(path: string, risk: RepoPolicy["risk"]): FileRisk {
  if (matchesAny(path, FIXED_T3_PATTERNS)) return { path, tier: "T3", rule: "fixed" };
  for (const tier of [...RISK_TIERS].reverse()) {
    if (matchesAny(path, risk[tier])) return { path, tier, rule: tier };
  }
  return { path, tier: risk.default, rule: "default" };
}

/** A PR is as risky as its riskiest path; renames count both the old and new location. */
export function assessRisk(
  files: readonly ChangedFile[],
  risk: RepoPolicy["risk"],
): RiskAssessment {
  const assessed: FileRisk[] = [];
  for (const file of files) {
    const current = classifyPath(file.filename, risk);
    const previous = file.previousFilename ? classifyPath(file.previousFilename, risk) : undefined;
    assessed.push(
      previous && tierRank(previous.tier) > tierRank(current.tier) ? previous : current,
    );
  }
  const tier = assessed.reduce<RiskTier>((highest, file) => maxTier(highest, file.tier), "T0");
  return { tier: assessed.length > 0 ? tier : risk.default, files: assessed };
}
