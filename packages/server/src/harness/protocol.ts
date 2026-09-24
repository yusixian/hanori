import type { HarnessReply, HarnessReplyRequest } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { errorText } from "./pr-actions.js";
import { quoteAsData } from "./prompts.js";
import { APPROVAL_ACTIONS, encodeCallback, ensureApproval, jobBinding } from "./approvals.js";
import { REMINDER_KIND } from "./job-monitor.js";
import { JOB_STATES, REQUEST_STATES as S, WHOLE_REPO, isTerminal } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessJobRecord } from "./work-store.js";
import { RELAY_MARKER, type HarnessWork } from "./work.js";

export const QUESTION_KIND = "question";
const PROTOCOL_LINE = /^\s*(Areas|Question|Needs spec)\s*:\s*(.*)$/i;
const MAX_QUESTION = 2_000;

export interface ProtocolMessage {
  areas?: string[];
  question?: string;
  needsSpec?: string;
}

/** Lines must start with the keyword; a question runs until the next protocol line. */
export function parseProtocol(body: string): ProtocolMessage {
  const result: ProtocolMessage = {};
  let question: string[] | null = null;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const match = PROTOCOL_LINE.exec(line);
    if (match) {
      if (question) question = null;
      const keyword = match[1]!.toLowerCase();
      const value = match[2]!.trim();
      if (keyword === "areas" && !result.areas) {
        result.areas = value
          .split(/[,，\s]+/)
          .map((area) => area.trim())
          .filter(Boolean);
      } else if (keyword === "question" && result.question === undefined) {
        question = [value];
        result.question = value;
      } else if (keyword === "needs spec" && result.needsSpec === undefined) {
        result.needsSpec = value;
      }
      continue;
    }
    if (question) {
      question.push(line);
      result.question = question.join("\n").trim();
    }
  }
  if (result.question) result.question = result.question.slice(0, MAX_QUESTION);
  return result;
}

interface CommentPayload {
  body?: string;
  id?: number;
  author_association?: string;
  user?: { login?: string; type?: string };
}

/**
 * Only the lead session (running with the owner's `gh` login) or the owner can speak the
 * protocol: the repository owner, or a login listed in `github.trustedAuthors`. Bots, including
 * this harness's own relays, never do.
 */
export function isTrustedCommenter(
  comment: CommentPayload,
  config: Pick<ProjectEffectiveConfig, "github">,
): boolean {
  if (comment.user?.type === "Bot") return false;
  if (comment.body?.includes(RELAY_MARKER)) return false;
  if (comment.author_association === "OWNER") return true;
  const login = comment.user?.login?.toLowerCase();
  return (
    login !== undefined &&
    config.github.trustedAuthors.some((author) => author.toLowerCase() === login)
  );
}

export async function handleIssueComment(
  work: HarnessWork,
  payload: Record<string, unknown>,
  projectKey: string,
): Promise<void> {
  if (payload.action !== "created") return;
  const issue = payload.issue as { number?: number; pull_request?: unknown } | undefined;
  const comment = (payload.comment ?? {}) as CommentPayload;
  if (typeof issue?.number !== "number" || !comment.body) return;
  const { service } = work;
  const config = work.requireConfig(projectKey);
  const repo = config.project.repo;
  const target = issue.pull_request
    ? await service.store.findRequestByPr(repo, issue.number)
    : await service.store.findRequestByIssue(repo, issue.number);
  if (!target || target.type !== "bug" || isTerminal(target.state)) return;
  const message = parseProtocol(comment.body);
  if (!message.areas && message.question === undefined && message.needsSpec === undefined) return;
  if (!isTrustedCommenter(comment, config)) {
    await service.recordEvent({
      type: "protocol.ignored",
      projectKey,
      requestId: target.id,
      payload: { number: issue.number, author: comment.user?.login ?? null },
    });
    return;
  }
  await work.withRequest(target.id, async () => {
    const request = (await service.store.getRequest(target.id)) ?? target;
    if (message.areas) await declareAreas(work, config, request, message.areas);
    if (message.needsSpec !== undefined) await needsSpec(work, request, message.needsSpec);
    if (message.question) {
      await forwardQuestion(work, request, issue.number!, comment.id ?? null, message.question);
    }
    const fresh = await service.store.getRequest(target.id);
    if (fresh && !fresh.prNumber) await work.refreshCard(fresh);
  });
  if (target.prNumber) {
    const fresh = await service.store.getRequest(target.id);
    if (fresh) await work.refreshCard(fresh);
  }
}

async function declareAreas(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  names: string[],
) {
  const known = Object.keys(config.policy.areas);
  const valid = names.filter((name) => known.includes(name));
  const areas = valid.length > 0 ? [...new Set(valid)] : [WHOLE_REPO];
  await work.service.store.updateRequest(request.id, { areas });
  await work.service.recordEvent({
    type: "protocol.areas",
    projectKey: request.projectKey,
    requestId: request.id,
    payload: { areas, ignored: names.filter((name) => !known.includes(name)) },
  });
  void work.scheduler.tick();
}

async function needsSpec(work: HarnessWork, request: HarnessRequestRecord, reason: string) {
  const { service } = work;
  const text = reason || "未说明原因";
  const moved = await service.store.transitionRequest(
    request.id,
    [S.queued, S.starting, S.running, S.revising, S.prReady, S.needsAttention],
    S.needsSpec,
    { stateReason: `需要写 spec：${text.slice(0, 200)}` },
  );
  if (!moved) return;
  await service.recordEvent({
    type: "protocol.needs_spec",
    projectKey: request.projectKey,
    requestId: request.id,
    payload: { reason: text.slice(0, 500) },
  });
  await service.telegram?.send(service.file.telegram.chatId, {
    html: `📝 ${request.issueNumber ? `#${request.issueNumber} ` : ""}需要先写 spec：${escapeHtml(
      text.slice(0, 500),
    )}\n大需求流程将在后续阶段开放，目前请在 GitHub 上处理。`,
    threadId: service.projectThread(request.projectKey),
    replyToMessageId: request.cardMessageId ?? undefined,
  });
}

async function forwardQuestion(
  work: HarnessWork,
  request: HarnessRequestRecord,
  number: number,
  commentId: number | null,
  question: string,
) {
  const { service } = work;
  const telegram = service.telegram;
  if (!telegram) return;
  const chatId = service.file.telegram.chatId;
  const sent = await telegram.send(chatId, {
    html: `❓ #${number} 的问题：\n<blockquote>${escapeHtml(question)}</blockquote>\n回复这条消息作答。`,
    threadId: service.projectThread(request.projectKey),
    replyToMessageId: request.cardMessageId ?? undefined,
  });
  await service.store.recordMessage({
    chatId,
    messageId: sent.messageId,
    requestId: request.id,
    kind: QUESTION_KIND,
    ref: { number, commentId },
  });
  await service.recordEvent({
    type: "protocol.question",
    projectKey: request.projectKey,
    requestId: request.id,
    payload: { number, commentId, messageId: sent.messageId },
  });
}

/** Replies to a card whose session has ended: explain, and offer a new attempt when allowed. */
async function offerRequeue(
  work: HarnessWork,
  request: HarnessRequestRecord,
  job: HarnessJobRecord | null,
  reply: HarnessReplyRequest,
): Promise<HarnessReply> {
  const { service } = work;
  if (!job || [S.queued, S.starting].includes(request.state as never)) {
    return { html: "会话还没有开始，开始后再回复这张卡片。" };
  }
  if (![S.needsAttention, S.received].includes(request.state as never) || !service.telegram) {
    return { html: "这个请求的会话已经结束，回复没有发送。" };
  }
  const config = work.requireConfig(request.projectKey);
  const approval = await ensureApproval(service.store, request, {
    action: APPROVAL_ACTIONS.reminder,
    binding: jobBinding(request, job.sessionId),
    ttl: config.approvals.ttl,
    now: service.now(),
    reuse: false,
  });
  const sent = await service.telegram.send(reply.chatId, {
    html: "这个请求的会话已经结束，回复没有发送。重新排队会开一个新会话，再把反馈回复到卡片上即可。",
    keyboard: [[{ text: "🔁 重新排队", callbackData: encodeCallback(approval.id, "start") }]],
    threadId: reply.threadId,
    replyToMessageId: reply.messageId,
  });
  await service.store.recordMessage({
    chatId: reply.chatId,
    messageId: sent.messageId,
    requestId: request.id,
    kind: REMINDER_KIND,
    ref: { kind: "requeue", approvalId: approval.id },
  });
  return { html: "" };
}

function relayComment(title: string, text: string): string {
  return `${RELAY_MARKER}\n**${title}** (via Telegram)\n\n${quoteAsData(text)}`;
}

/** Owner replies to a question or a card: posted to GitHub, then sent to the session. */
export async function handleOwnerReply(
  work: HarnessWork,
  reply: HarnessReplyRequest,
): Promise<HarnessReply | null> {
  const { service } = work;
  if (!service.port.isHarnessChat(reply.chatId) || !service.port.isOwner(reply.userId)) return null;
  const question = await service.store.findMessage(reply.chatId, reply.replyToMessageId);
  const target = question
    ? await service.store.getRequest(question.requestId)
    : await service.store.findRequestByCard(reply.chatId, reply.replyToMessageId);
  if (!target) return null;
  if (target.type !== "bug") return { html: "这张卡片没有关联的执行会话。" };
  if (isTerminal(target.state)) return { html: "这个请求已经结束。" };
  const text = reply.text.trim();
  if (!text) return { html: "目前只支持文字回复。" };
  return work
    .withRequest(target.id, async () => {
      const request = (await service.store.getRequest(target.id)) ?? target;
      const job = await service.store.latestJob(request.id);
      if (job?.state !== JOB_STATES.running) return offerRequeue(work, request, job, reply);
      const config = work.requireConfig(request.projectKey);
      const isQuestion = question?.kind === QUESTION_KIND;
      const number = isQuestion
        ? Number((question.ref as { number?: number } | null)?.number)
        : (request.prNumber ?? request.issueNumber);
      try {
        if (number) {
          await work.github.createComment(
            config.project.repo,
            number,
            relayComment(isQuestion ? "Owner answer" : "Owner feedback", text),
          );
        }
        if (!isQuestion && request.prNumber) {
          await work.github.addLabels(config.project.repo, request.prNumber, [
            `${config.github.labelPrefix}revise`,
          ]);
        }
      } catch (error) {
        return { html: `写入 GitHub 失败：${escapeHtml(errorText(error))}` };
      }
      const kind = isQuestion || !request.prNumber ? "answer" : "revise";
      const sent = await work.sendToSession(request, kind, { ownerText: text });
      if (!sent.ok) return { html: `已写入 GitHub，但发送到会话失败：${escapeHtml(sent.message)}` };
      if (kind === "revise") {
        await service.store.transitionRequest(
          request.id,
          [S.prReady, S.needsAttention, S.revising],
          S.revising,
          { stateReason: null },
        );
      }
      await service.recordEvent({
        type: isQuestion ? "owner.answer" : "owner.feedback",
        projectKey: request.projectKey,
        requestId: request.id,
        actorId: reply.userId,
        payload: { number, kind },
      });
      const fresh = await service.store.getRequest(request.id);
      if (fresh && !fresh.prNumber) await work.refreshCard(fresh);
      return { html: "" };
    })
    .then(async (result) => {
      const fresh = await service.store.getRequest(target.id);
      if (fresh?.prNumber) await work.refreshCard(fresh);
      return result;
    });
}
