import { type ConfigIssue, formatIssues } from "./config/layers.js";
import { parseRepoPolicy } from "./config/loader.js";
import type { HarnessGitHub } from "./github.js";
import { inferRepoPolicy, readRepoFacts } from "./infer.js";
import type { HarnessProjectPatch } from "./store.js";

export const REPO_POLICY_PATH = ".cos/harness.yml";

export interface PolicyFetchInput {
  github: HarnessGitHub;
  repo: string;
  now: Date;
  /** Issues from resolving the project with this repo policy or inferred policy. */
  validate: (
    policy: Record<string, unknown> | null,
    inferred: Record<string, unknown> | null,
  ) => ConfigIssue[];
}

/**
 * Repo policy is read from the default branch only. Without `.cos/harness.yml` the policy is
 * inferred from the repo instead; a failed read or invalid file keeps the last good policy.
 */
export async function fetchRepoPolicy(input: PolicyFetchInput): Promise<HarnessProjectPatch> {
  const { github, repo } = input;
  try {
    const head = await github.getDefaultBranch(repo);
    const text = await github.getFile(repo, REPO_POLICY_PATH, head.sha);
    const base = { defaultBranch: head.branch, policyFetchedAt: input.now };
    if (text === null) {
      let inferred: Record<string, unknown> | null = null;
      let policyError: string | null = null;
      try {
        const facts = await readRepoFacts(github, repo, head.sha);
        inferred = inferRepoPolicy(facts, repo.split("/")[1] ?? repo);
        const issues = input.validate(null, inferred);
        if (issues.length > 0) {
          inferred = null;
          policyError = `推断结果无效，使用默认值：${formatIssues(issues, 3)}`;
        }
      } catch (error) {
        policyError = `推断失败，使用默认值：${(error as Error).message.slice(0, 200)}`;
      }
      return {
        ...base,
        policy: null,
        policySha: head.sha,
        kind: typeof inferred?.kind === "string" ? inferred.kind : null,
        inferredPolicy: inferred,
        policyError,
      };
    }
    const parsed = parseRepoPolicy(text);
    const issues = parsed.ok ? input.validate(parsed.raw, null) : parsed.issues;
    if (!parsed.ok || issues.length > 0) {
      return { ...base, policyError: formatIssues(issues, 5) };
    }
    return {
      ...base,
      policy: parsed.raw,
      policySha: head.sha,
      kind: parsed.policy.kind,
      inferredPolicy: null,
      policyError: null,
    };
  } catch (error) {
    return { policyError: `读取失败：${(error as Error).message.slice(0, 200)}` };
  }
}
