import { randomUUID } from "node:crypto";
import type { HarnessCommandRequest, HarnessReply } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { issueTitle } from "./bug.js";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { sessionLink } from "./job-card.js";
import type { LodySession } from "./lody.js";
import { errorText } from "./pr-actions.js";
import { harnessBranch } from "./prompts.js";
import { forwardQuestion, needsSpec, parseProtocol } from "./protocol.js";
import { REQUEST_STATES as S } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessWork } from "./work.js";
import type { HarnessJobRecord } from "./work-store.js";

export const TASK_RESULT_KIND = "task_result";
/** Characters of escaped result text; the rest of the message stays under Telegram's 4096. */
export const TASK_RESULT_LIMIT = 3_500;
export const TASK_QUESTION_REASON = "任务在等你回答问题";
const LEADING_PROTOCOL = /^(Question|Needs spec)\s*:/i;

/**
 * `/task <说明>` in a project topic: a Lody task without a GitHub issue. It is queued and
 * dispatched like `/bug`; a PR on `harness/<id>` hands it to the PR card, otherwise the
 * session's final message is posted as the result.
 */
export async function handleTaskCommand(
  work: HarnessWork,
  request: HarnessCommandRequest,
  projectKey: string | undefined,
): Promise<HarnessReply> {
  if (!projectKey) return { html: "请在项目话题中使用 /task，任务会在那个项目的仓库里执行。" };
  const text = request.args.trim();
  if (!text) return { html: "用法：/task &lt;任务说明&gt;（不会创建 issue；改代码时会开 PR）" };
  const { service } = work;
  const config = work.requireConfig(projectKey);
  const id = randomUUID();
  const created = await service.store.insertRequest({
    id,
    projectKey,
    type: "task",
    state: config.guardrails.autonomy.bugStartsImmediately ? S.queued : S.received,
    repo: config.project.repo,
    title: issueTitle(text),
    ownerText: text,
    createdBy: request.userId,
  });
  await service.recordEvent({
    type: "request.created",
    projectKey,
    requestId: id,
    actorId: request.userId,
    payload: { source: "command", kind: "task", length: text.length },
  });
  await work.withRequest(id, () =>
    work.refreshCard(created, { replyToMessageId: request.messageId }),
  );
  void work.scheduler.tick();
  return { html: "" };
}

/** Escapes, then clips so the escaped text fits `max`; never splits an entity or a code point. */
export function clipEscaped(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    const piece = escapeHtml(char);
    if (out.length + piece.length > max - 1) return `${out}…`;
    out += piece;
  }
  return out;
}

export function renderTaskResult(title: string | null, text: string | null): string {
  const body = text?.trim()
    ? `<blockquote expandable>${clipEscaped(text.trim(), TASK_RESULT_LIMIT)}</blockquote>`
    : "（没有读到会话的最后一条回复，请打开会话查看。）";
  return [
    `✅ 任务完成 · <b>${escapeHtml((title ?? "未命名任务").slice(0, 80))}</b>`,
    body,
    "回复这条消息可以让同一个会话继续。",
  ].join("\n");
}

/**
 * Caller holds the request lock; the task's turn is over (reported end or idle debounce) and no
 * PR was seen. A PR on the task branch hands over to the PR card; `Question:` / `Needs spec:` at
 * the start of the final message go to the topic; anything else is posted as the result.
 */
export async function finishTask(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
): Promise<boolean> {
  const { service } = work;
  const branch = harnessBranch(config.github.branchPrefix, request.id);
  const github = service.github?.available ? service.github : null;
  const number = github ? await github.findOpenPullRequest(config.project.repo, branch) : null;
  if (number !== null) {
    await service.prFlow.sync(request.projectKey, number, { reason: "task_turn" });
    return true;
  }
  const last = await service
    .lody()
    .lastAssistantMessage(job.sessionId!)
    .catch((error) => ({ ok: false as const, message: errorText(error) }));
  const text = last.ok ? last.value : null;
  const lead = text?.trimStart() ?? "";
  const protocol = LEADING_PROTOCOL.test(lead) ? parseProtocol(lead) : {};
  if (protocol.needsSpec !== undefined) {
    await needsSpec(work, request, protocol.needsSpec);
    return true;
  }
  if (protocol.question) {
    const moved = await service.store.transitionRequest(request.id, [S.running], S.needsAttention, {
      stateReason: TASK_QUESTION_REASON,
    });
    if (moved) await forwardQuestion(work, request, null, null, protocol.question);
    return moved;
  }
  // Keep the request pollable if Telegram rejects the result. The request lock serializes retries.
  if (!service.telegram) return false;
  await postResult(work, config, request, job, text);
  const moved = await service.store.transitionRequest(request.id, [S.running], S.completed, {
    stateReason: null,
  });
  if (!moved) return false;
  await service.store.updateJob(job.id, { endedAt: service.now() });
  await service.recordEvent({
    type: "task.completed",
    projectKey: request.projectKey,
    requestId: request.id,
    payload: {
      resultLength: text?.length ?? 0,
      ...(last.ok ? {} : { historyError: last.message }),
    },
  });
  return true;
}

async function postResult(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
  text: string | null,
) {
  const { service } = work;
  const telegram = service.telegram;
  if (!telegram) return;
  const url = sessionLink(config.executors.lody.sessionUrl, job.sessionId);
  const chatId = service.file.telegram.chatId;
  const sent = await telegram.send(chatId, {
    html: renderTaskResult(request.title, text),
    keyboard: url ? [[{ text: "💬 打开会话", url }]] : [],
    threadId: service.projectThread(request.projectKey),
    replyToMessageId: request.cardMessageId ?? undefined,
  });
  await service.store.recordMessage({
    chatId,
    messageId: sent.messageId,
    requestId: request.id,
    kind: TASK_RESULT_KIND,
    ref: { jobId: job.id },
  });
}

/** A completed task's session started a turn on its own (e.g. a sub-session reported back). */
export async function resumeTask(
  work: HarnessWork,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
  session: LodySession,
): Promise<boolean> {
  if (session.status !== "running") return false;
  const { service } = work;
  const moved = await service.store.transitionRequest(request.id, [S.completed], S.running);
  if (!moved) return false;
  await service.store.updateJob(job.id, {
    endedAt: null,
    startedAt: service.now(),
    runRemindedAt: null,
    idleRemindedAt: null,
  });
  await service.recordEvent({
    type: "task.resumed",
    projectKey: request.projectKey,
    requestId: request.id,
    payload: { source: "session" },
  });
  return true;
}
