import type { PullRequestInfo } from "./github.js";

/**
 * Untracked PRs get a card only when they come from the harness itself or someone the owner trusts:
 * a same-repo branch with the harness prefix, a trusted author, or a `<labelPrefix>track` label that
 * only collaborators can apply. Fork PRs from strangers never reach the AI summary.
 */
export function acceptsPullRequest(
  github: {
    acceptPullRequests: string;
    branchPrefix: string;
    labelPrefix: string;
    trustedAuthors: string[];
  },
  repo: string,
  pr: Pick<PullRequestInfo, "headRepo" | "headRef" | "author" | "labels">,
): boolean {
  if (github.acceptPullRequests === "all") return true;
  if (pr.labels.includes(`${github.labelPrefix}track`)) return true;
  if (pr.headRepo?.toLowerCase() !== repo.toLowerCase()) return false;
  if (pr.headRef.startsWith(github.branchPrefix)) return true;
  const author = pr.author?.toLowerCase();
  return (
    author !== undefined && github.trustedAuthors.some((login) => login.toLowerCase() === author)
  );
}
