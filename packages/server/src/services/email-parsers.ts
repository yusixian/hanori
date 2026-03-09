import type { LarkCardMessage } from "./lark-webhook-client.js";

export type PrAction =
  | "approved"
  | "changes_requested"
  | "commented"
  | "merged"
  | "opened"
  | "review_requested"
  | "pushed"
  | "unknown";

export interface PrReviewInfo {
  platform: "github" | "gitlab";
  repo: string;
  title: string;
  prNumber: string;
  reviewer: string;
  action: PrAction;
  url: string | null;
  comment: string | null;
}

const GITHUB_NOTIFICATION_SENDER = "notifications@github.com";
const GITLAB_NOTIFICATION_SENDER = "@gitlab.com";

// GitHub subject: "Re: [owner/repo] PR title (PR #123)" or "[owner/repo] Title (#123)"
const GITHUB_SUBJECT_RE = /\[([^\]]+)]\s*(.+?)\s*\((?:PR )?#(\d+)\)/;
// CI/Actions: "[owner/repo] Run failed: Workflow - branch (sha)"
const GITHUB_CI_SUBJECT_RE =
  /\[([^\]]+)]\s*Run\s+(failed|cancelled|succeeded|completed):\s*(.+?)\s*-\s*(.+?)\s*\(([a-f0-9]+)\)/i;
// GitLab subject: "project | Merge request !123"
const GITLAB_SUBJECT_RE = /^(.+?)\s*\|\s*Merge request !(\d+)/i;

function inferGitHubAction(body: string): PrAction {
  const lower = body.toLowerCase();
  if (lower.includes("approved this pull request")) return "approved";
  if (lower.includes("requested changes")) return "changes_requested";
  if (lower.includes("merged this pull request") || lower.includes("was merged")) return "merged";
  if (lower.includes("opened this pull request")) return "opened";
  if (lower.includes("requested review")) return "review_requested";
  if (lower.includes("pushed")) return "pushed";
  if (
    lower.includes("commented") ||
    lower.includes("left a comment") ||
    lower.includes("review comment")
  )
    return "commented";
  return "unknown";
}

function inferGitLabAction(body: string): PrAction {
  const lower = body.toLowerCase();
  if (lower.includes("approved this merge request")) return "approved";
  if (lower.includes("merged this merge request") || lower.includes("was merged")) return "merged";
  return "commented";
}

function extractGitHubPrUrl(body: string): string | null {
  const match = body.match(/https:\/\/github\.com\/[^\s<>"]+\/pull\/\d+/);
  return match ? match[0] : null;
}

function extractGitHubIssueUrl(body: string): string | null {
  const match = body.match(/https:\/\/github\.com\/[^\s<>"]+\/issues\/\d+/);
  return match ? match[0] : null;
}

function extractGitHubActionsUrl(body: string): string | null {
  const match = body.match(/https:\/\/github\.com\/[^\s<>"]+\/actions\/runs\/\d+/);
  return match ? match[0] : null;
}

function extractGitLabUrl(body: string): string | null {
  const match = body.match(/https:\/\/[^\s<>"]*\/merge_requests\/\d+/);
  return match ? match[0] : null;
}

function extractReviewer(from: string): string {
  // "Name <email>" → Name
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1]!.trim() : (from.split("@")[0] ?? from);
}

function extractComment(textBody: string, maxLen = 500): string | null {
  // Skip common headers/footers, take the meaningful middle part
  const lines = textBody.split("\n");
  const meaningful: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      // Skip empty lines and header lines at start
      if (trimmed.length === 0 || trimmed.startsWith("--") || trimmed.startsWith("___")) continue;
      started = true;
    }
    // Stop at signature/footer
    if (
      trimmed === "--" ||
      trimmed.startsWith("Reply to this email") ||
      trimmed.startsWith("You are receiving")
    )
      break;
    meaningful.push(trimmed);
  }
  const text = meaningful.join("\n").trim();
  if (text.length === 0) return null;
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

export function parsePrReviewEmail(
  from: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): PrReviewInfo | null {
  const body = textBody || htmlBody;

  // GitHub — must have /pull/ URL in body to distinguish from Issue emails
  if (from.includes(GITHUB_NOTIFICATION_SENDER)) {
    const match = GITHUB_SUBJECT_RE.exec(subject);
    if (!match) return null;
    const url = extractGitHubPrUrl(body);
    if (!url && !body.includes("/pull/")) return null;
    return {
      platform: "github",
      repo: match[1]!,
      title: match[2]!,
      prNumber: match[3]!,
      reviewer: extractReviewer(from),
      action: inferGitHubAction(body),
      url,
      comment: extractComment(textBody),
    };
  }

  // GitLab
  if (from.includes(GITLAB_NOTIFICATION_SENDER)) {
    const match = GITLAB_SUBJECT_RE.exec(subject);
    if (!match) return null;
    return {
      platform: "gitlab",
      repo: match[1]!.trim(),
      title: subject,
      prNumber: match[2]!,
      reviewer: extractReviewer(from),
      action: inferGitLabAction(body),
      url: extractGitLabUrl(body),
      comment: extractComment(textBody),
    };
  }

  return null;
}

const ACTION_COLORS: Record<PrAction, string> = {
  approved: "green",
  changes_requested: "red",
  commented: "blue",
  merged: "purple",
  opened: "turquoise",
  review_requested: "orange",
  pushed: "blue",
  unknown: "grey",
};

const ACTION_LABELS: Record<PrAction, string> = {
  approved: "Approved",
  changes_requested: "Changes Requested",
  commented: "Commented",
  merged: "Merged",
  opened: "Opened",
  review_requested: "Review Requested",
  pushed: "Pushed",
  unknown: "Activity",
};

export function buildPrReviewCard(info: PrReviewInfo): LarkCardMessage {
  const elements: LarkCardMessage["elements"] = [];

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `**${info.repo}** #${info.prNumber}\n${info.title}`,
    },
  });

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `Reviewer: **${info.reviewer}**`,
    },
  });

  if (info.comment) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `> ${info.comment.split("\n").join("\n> ")}`,
      },
    });
  }

  if (info.url) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "View PR" },
          url: info.url,
          type: "primary",
        },
      ],
    });
  }

  return {
    header: {
      title: {
        tag: "plain_text",
        content: `${ACTION_LABELS[info.action]} - ${info.platform.toUpperCase()}`,
      },
      template: ACTION_COLORS[info.action],
    },
    config: { wide_screen_mode: true },
    elements,
  };
}

export function buildGenericEmailCard(
  from: string,
  subject: string,
  body: string,
): LarkCardMessage {
  const preview = body.length > 500 ? body.slice(0, 500) + "..." : body;
  return {
    header: {
      title: { tag: "plain_text", content: "New Email" },
      template: "blue",
    },
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `**From:** ${from}\n**Subject:** ${subject}` },
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: preview },
      },
    ],
  };
}

// --- CI/Actions ---

export type CiRunStatus = "failed" | "cancelled" | "succeeded" | "completed";

export interface CiRunInfo {
  platform: "github";
  repo: string;
  workflow: string;
  branch: string;
  commitSha: string;
  status: CiRunStatus;
  url: string | null;
}

export function parseCiRunEmail(
  from: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): CiRunInfo | null {
  if (!from.includes(GITHUB_NOTIFICATION_SENDER)) return null;
  const match = GITHUB_CI_SUBJECT_RE.exec(subject);
  if (!match) return null;
  const body = textBody || htmlBody;
  return {
    platform: "github",
    repo: match[1]!,
    status: match[2]!.toLowerCase() as CiRunStatus,
    workflow: match[3]!.trim(),
    branch: match[4]!.trim(),
    commitSha: match[5]!,
    url: extractGitHubActionsUrl(body),
  };
}

const CI_STATUS_COLORS: Record<CiRunStatus, string> = {
  failed: "red",
  cancelled: "grey",
  succeeded: "green",
  completed: "green",
};

const CI_STATUS_LABELS: Record<CiRunStatus, string> = {
  failed: "CI Failed",
  cancelled: "CI Cancelled",
  succeeded: "CI Passed",
  completed: "CI Passed",
};

export function buildCiRunCard(info: CiRunInfo): LarkCardMessage {
  const elements: LarkCardMessage["elements"] = [];

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `**${info.repo}** · ${info.workflow}`,
    },
  });

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `Branch: **${info.branch}**\nCommit: \`${info.commitSha.slice(0, 7)}\``,
    },
  });

  if (info.url) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "View Run" },
          url: info.url,
          type: "primary",
        },
      ],
    });
  }

  return {
    header: {
      title: {
        tag: "plain_text",
        content: `${CI_STATUS_LABELS[info.status]} - GITHUB`,
      },
      template: CI_STATUS_COLORS[info.status],
    },
    config: { wide_screen_mode: true },
    elements,
  };
}

// --- Issue ---

export type IssueAction = "opened" | "closed" | "commented" | "unknown";

export interface IssueInfo {
  platform: "github";
  repo: string;
  title: string;
  issueNumber: string;
  author: string;
  action: IssueAction;
  url: string | null;
  comment: string | null;
}

function inferIssueAction(body: string): IssueAction {
  const lower = body.toLowerCase();
  if (lower.includes("opened this issue")) return "opened";
  if (lower.includes("closed this") || lower.includes("was closed")) return "closed";
  if (lower.includes("commented") || lower.includes("left a comment")) return "commented";
  return "unknown";
}

export function parseIssueEmail(
  from: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): IssueInfo | null {
  if (!from.includes(GITHUB_NOTIFICATION_SENDER)) return null;
  const match = GITHUB_SUBJECT_RE.exec(subject);
  if (!match) return null;
  const body = textBody || htmlBody;
  if (!body.includes("/issues/")) return null;
  return {
    platform: "github",
    repo: match[1]!,
    title: match[2]!,
    issueNumber: match[3]!,
    author: extractReviewer(from),
    action: inferIssueAction(body),
    url: extractGitHubIssueUrl(body),
    comment: extractComment(textBody),
  };
}

const ISSUE_ACTION_COLORS: Record<IssueAction, string> = {
  opened: "turquoise",
  closed: "purple",
  commented: "blue",
  unknown: "grey",
};

const ISSUE_ACTION_LABELS: Record<IssueAction, string> = {
  opened: "Issue Opened",
  closed: "Issue Closed",
  commented: "Issue Commented",
  unknown: "Issue Activity",
};

export function buildIssueCard(info: IssueInfo): LarkCardMessage {
  const elements: LarkCardMessage["elements"] = [];

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `**${info.repo}** #${info.issueNumber}\n${info.title}`,
    },
  });

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `Author: **${info.author}**`,
    },
  });

  if (info.comment) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `> ${info.comment.split("\n").join("\n> ")}`,
      },
    });
  }

  if (info.url) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "View Issue" },
          url: info.url,
          type: "primary",
        },
      ],
    });
  }

  return {
    header: {
      title: {
        tag: "plain_text",
        content: `${ISSUE_ACTION_LABELS[info.action]} - GITHUB`,
      },
      template: ISSUE_ACTION_COLORS[info.action],
    },
    config: { wide_screen_mode: true },
    elements,
  };
}

// --- Unified entry point ---

export function buildEmailCard(
  from: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): LarkCardMessage {
  const ci = parseCiRunEmail(from, subject, textBody, htmlBody);
  if (ci) return buildCiRunCard(ci);

  const pr = parsePrReviewEmail(from, subject, textBody, htmlBody);
  if (pr) return buildPrReviewCard(pr);

  const issue = parseIssueEmail(from, subject, textBody, htmlBody);
  if (issue) return buildIssueCard(issue);

  return buildGenericEmailCard(from, subject, textBody);
}
