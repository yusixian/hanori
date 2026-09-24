import { randomUUID } from "node:crypto";
import type { HarnessCommandRequest, HarnessReply } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { errorText } from "./pr-actions.js";
import { REQUEST_STATES as S, isTerminal } from "./states.js";
import type { HarnessWork } from "./work.js";

const MAX_TITLE = 80;
const MAX_BODY = 20_000;

export function issueTitle(text: string): string {
  const first = text.split(/\r?\n/, 1)[0]!.trim();
  return first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1)}…` : first;
}

/**
 * Telegram file ids are listed as references only: download URLs embed the Bot token and must
 * never be written to GitHub.
 */
export function bugIssueBody(input: {
  text: string;
  requestId: string;
  attachments: ReadonlyArray<{ kind: string; fileId: string }>;
}): string {
  const lines = [
    input.text.slice(0, MAX_BODY),
    "",
    "---",
    "Reported from Telegram via Dev Harness.",
  ];
  if (input.attachments.length > 0) {
    lines.push(
      "",
      "Attachments (Telegram file ids; the files are in the project topic):",
      ...input.attachments.map((file) => `- ${file.kind}: \`${file.fileId}\``),
    );
  }
  lines.push("", `<!-- dev-harness:request:${input.requestId} -->`);
  return lines.join("\n");
}

function initialState(work: HarnessWork, projectKey: string): string {
  return work.requireConfig(projectKey).guardrails.autonomy.bugStartsImmediately
    ? S.queued
    : S.received;
}

export async function handleBugCommand(
  work: HarnessWork,
  request: HarnessCommandRequest,
  projectKey: string | undefined,
): Promise<HarnessReply> {
  if (!projectKey) return { html: "请在项目话题中使用 /bug。" };
  const text = request.args.trim();
  if (!text) return { html: "用法：/bug &lt;问题描述&gt;（可以附一张截图）" };
  const { service } = work;
  const config = work.requireConfig(projectKey);
  const id = randomUUID();
  let issue: { number: number; url: string };
  try {
    issue = await work.github.createIssue(config.project.repo, {
      title: issueTitle(text),
      body: bugIssueBody({ text, requestId: id, attachments: request.attachments ?? [] }),
      labels: [`${config.github.labelPrefix}bug`],
    });
  } catch (error) {
    return { html: `创建 issue 失败：${escapeHtml(errorText(error))}` };
  }
  const created = await service.store.insertRequest({
    id,
    projectKey,
    type: "bug",
    state: initialState(work, projectKey),
    repo: config.project.repo,
    issueNumber: issue.number,
    title: issueTitle(text),
    ownerText: text,
    createdBy: request.userId,
  });
  await service.recordEvent({
    type: "request.created",
    projectKey,
    requestId: id,
    actorId: request.userId,
    payload: { source: "command", issue: issue.number },
  });
  await work.withRequest(id, () =>
    work.refreshCard(created, { replyToMessageId: request.messageId }),
  );
  void work.scheduler.tick();
  return { html: "" };
}

/**
 * With `acceptIssues: harness-only`, only the repository owner or a trusted author may turn an
 * issue into work by labeling it; triage rights alone are not enough.
 */
export function acceptsIssueLabel(
  github: { acceptIssues: string; trustedAuthors: string[] },
  payload: Record<string, unknown>,
): boolean {
  if (github.acceptIssues === "all") return true;
  const sender = (payload.sender as { login?: string } | undefined)?.login?.toLowerCase();
  if (!sender) return false;
  const repository = payload.repository as { owner?: { login?: string } } | undefined;
  if (repository?.owner?.login?.toLowerCase() === sender) return true;
  return github.trustedAuthors.some((login) => login.toLowerCase() === sender);
}

/** An issue labeled `<labelPrefix>bug` by an accepted sender becomes a request, like `/bug`. */
export async function handleIssueEvent(
  work: HarnessWork,
  payload: Record<string, unknown>,
  projectKey: string,
): Promise<void> {
  const issue = payload.issue as
    | {
        number?: number;
        title?: string;
        body?: string | null;
        pull_request?: unknown;
        state?: string;
      }
    | undefined;
  if (!issue || typeof issue.number !== "number" || issue.pull_request) return;
  const { service } = work;
  const config = work.requireConfig(projectKey);
  const repo = config.project.repo;
  const existing = await service.store.findRequestByIssue(repo, issue.number);

  if (payload.action === "closed") {
    if (existing && [S.received, S.queued].includes(existing.state as never)) {
      await work.withRequest(existing.id, () => work.cancel(existing, null, "issue 已关闭"));
    }
    return;
  }
  const label = (payload.label as { name?: string } | undefined)?.name;
  if (payload.action !== "labeled" || label !== `${config.github.labelPrefix}bug`) return;
  if (issue.state === "closed" || (existing && !isTerminal(existing.state))) return;
  // `/bug` labels its own issue at creation; that request may not be stored yet.
  if (issue.body?.includes("<!-- dev-harness:request:")) return;
  if (!acceptsIssueLabel(config.github, payload)) {
    await service.recordEvent({
      type: "issue.ignored",
      projectKey,
      payload: {
        issue: issue.number,
        sender: (payload.sender as { login?: string } | undefined)?.login ?? null,
      },
    });
    return;
  }
  const id = randomUUID();
  const created = await service.store.insertRequest({
    id,
    projectKey,
    type: "bug",
    state: initialState(work, projectKey),
    repo,
    issueNumber: issue.number,
    title: issueTitle(issue.title ?? `Issue #${issue.number}`),
  });
  await service.recordEvent({
    type: "request.created",
    projectKey,
    requestId: id,
    payload: { source: "label", issue: issue.number },
  });
  await work.withRequest(id, () => work.refreshCard(created));
  void work.scheduler.tick();
}
