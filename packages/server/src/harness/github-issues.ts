/** Read-only issue, pull request, and commit shapes the topic assistant queries. */
export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  isPullRequest: boolean;
  /** Null for issues. */
  merged: boolean | null;
  labels: string[];
  author: string | null;
  comments: number;
  updatedAt: string;
  url: string;
}

export interface IssueComment {
  author: string | null;
  createdAt: string;
  body: string;
}

export interface IssueDetail extends IssueSummary {
  body: string | null;
  closedAt: string | null;
  /** The latest comments, oldest first. */
  recentComments: IssueComment[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  labels: string[];
  author: string | null;
  headRef: string;
  updatedAt: string;
  url: string;
}

export interface CommitSummary {
  sha: string;
  /** First line only. */
  message: string;
  author: string | null;
  date: string | null;
}

export interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  updated_at: string;
  closed_at?: string | null;
  body?: string | null;
  pull_request?: { merged_at?: string | null } | null;
}

function labelNames(labels: RawIssue["labels"]): string[] {
  return (labels ?? []).flatMap((label) =>
    typeof label === "string" ? [label] : label.name ? [label.name] : [],
  );
}

export function toIssueSummary(issue: RawIssue): IssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    isPullRequest: Boolean(issue.pull_request),
    merged: issue.pull_request ? Boolean(issue.pull_request.merged_at) : null,
    labels: labelNames(issue.labels),
    author: issue.user?.login ?? null,
    comments: issue.comments ?? 0,
    updatedAt: issue.updated_at,
    url: issue.html_url,
  };
}

export interface RawIssueComment {
  user?: { login?: string } | null;
  created_at: string;
  body?: string | null;
}

export function toIssueDetail(issue: RawIssue, comments: RawIssueComment[]): IssueDetail {
  return {
    ...toIssueSummary(issue),
    body: issue.body ?? null,
    closedAt: issue.closed_at ?? null,
    recentComments: comments.map((comment) => ({
      author: comment.user?.login ?? null,
      createdAt: comment.created_at,
      body: comment.body ?? "",
    })),
  };
}

export interface RawPullRequestListItem {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  html_url: string;
  user?: { login?: string } | null;
  head: { ref: string };
  labels?: RawIssue["labels"];
  updated_at: string;
}

export function toPullRequestSummary(pr: RawPullRequestListItem): PullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft ?? false,
    merged: Boolean(pr.merged_at),
    mergedAt: pr.merged_at ?? null,
    labels: labelNames(pr.labels),
    author: pr.user?.login ?? null,
    headRef: pr.head.ref,
    updatedAt: pr.updated_at,
    url: pr.html_url,
  };
}

export interface RawCommit {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } | null };
  author?: { login?: string } | null;
}

export function toCommitSummary(item: RawCommit): CommitSummary {
  return {
    sha: item.sha.slice(0, 7),
    message: item.commit.message.split("\n", 1)[0]!,
    author: item.author?.login ?? item.commit.author?.name ?? null,
    date: item.commit.author?.date ?? null,
  };
}
