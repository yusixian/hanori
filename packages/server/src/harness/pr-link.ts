import type { ProjectEffectiveConfig } from "./config/schema.js";
import type { PullRequestInfo } from "./github.js";
import { acceptsPullRequest } from "./intake.js";
import { REQUEST_STATES as S, isTerminal, isWorkRequest } from "./states.js";
import type { HarnessRequestRecord, HarnessStore } from "./store.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function requestIdFromBranch(prefix: string, branch: string): string | null {
  const match = new RegExp(`^${escapeRegExp(prefix)}(${UUID})(?:$|[-/])`, "i").exec(branch);
  return match?.[1]?.toLowerCase() ?? null;
}

export function closingIssues(body: string | null): number[] {
  if (!body) return [];
  return [...body.matchAll(CLOSING_KEYWORD)].map((match) => Number(match[1]));
}

/**
 * Links a PR opened by a harness session to its request: first by the `harness/<requestId>`
 * branch on the same repository (the only link a `/task` has), then by `Fixes #<issue>` from an
 * accepted (trusted) PR. A completed task still links: its session may open the PR later.
 */
export async function findLinkedRequest(
  store: HarnessStore,
  config: ProjectEffectiveConfig,
  pr: PullRequestInfo,
): Promise<HarnessRequestRecord | null> {
  const repo = config.project.repo;
  const linkable = (request: HarnessRequestRecord | null) =>
    request &&
    isWorkRequest(request) &&
    request.repo.toLowerCase() === repo.toLowerCase() &&
    request.prNumber === null &&
    (!isTerminal(request.state) || request.state === S.completed)
      ? request
      : null;
  if (pr.headRepo?.toLowerCase() === repo.toLowerCase()) {
    const id = requestIdFromBranch(config.github.branchPrefix, pr.headRef);
    const byBranch = id ? linkable(await store.getRequest(id)) : null;
    if (byBranch) return byBranch;
  }
  if (!acceptsPullRequest(config.github, repo, pr)) return null;
  for (const issue of closingIssues(pr.body)) {
    const byIssue = linkable(await store.findRequestByIssue(repo, issue));
    if (byIssue) return byIssue;
  }
  return null;
}
