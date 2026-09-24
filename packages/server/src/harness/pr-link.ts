import type { ProjectEffectiveConfig } from "./config/schema.js";
import type { PullRequestInfo } from "./github.js";
import { acceptsPullRequest } from "./intake.js";
import { REQUEST_STATES as S, isTerminal } from "./states.js";
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
 * branch on the same repository, then by `Fixes #<issue>` from an accepted (trusted) PR.
 */
export async function findLinkedRequest(
  store: HarnessStore,
  config: ProjectEffectiveConfig,
  pr: PullRequestInfo,
): Promise<HarnessRequestRecord | null> {
  const repo = config.project.repo;
  const linkable = (request: HarnessRequestRecord | null) =>
    request &&
    request.type === "bug" &&
    request.repo.toLowerCase() === repo.toLowerCase() &&
    request.prNumber === null &&
    !isTerminal(request.state)
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

const KEPT_WHILE_OPEN: readonly string[] = [
  S.received,
  S.queued,
  S.starting,
  S.needsAttention,
  S.needsSpec,
];

/**
 * Open-PR state for a request. Bug requests keep their own stage while the PR stays open; a push
 * from the working session (or first linking, which counts as one) moves it to `pr_ready`.
 */
export function openStateFor(request: HarnessRequestRecord, headChanged: boolean): string {
  if (request.type !== "bug") return S.open;
  if (isTerminal(request.state) && request.state !== S.closed) return request.state;
  if (KEPT_WHILE_OPEN.includes(request.state)) return request.state;
  if (request.state === S.revising || request.state === S.running) {
    return headChanged ? S.prReady : request.state;
  }
  return S.prReady;
}
