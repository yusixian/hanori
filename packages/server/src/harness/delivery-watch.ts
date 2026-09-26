import type {
  HarnessCallbackAnswer,
  HarnessCallbackRequest,
  HarnessKeyboard,
} from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { durationMs } from "./config/units.js";
import { sessionLink } from "./job-card.js";
import type { LodySession } from "./lody.js";
import { errorText } from "./pr-actions.js";
import { handleOwnerReply } from "./protocol.js";
import type { HarnessService } from "./service.js";
import { JOB_STATES, REQUEST_STATES as S } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import { finishTask, resumeTask } from "./task.js";
import type { HarnessWork } from "./work.js";
import type { HarnessJobRecord } from "./work-store.js";

/** Lody reports `running` during a turn and `idle` once the agent has stopped (CLI 0.100.0). */
const IDLE = "idle";
const RUNNING = "running";
const EXCERPT_LIMIT = 280;
export const UNDELIVERED_KIND = "undelivered";
export const CONTINUE_CALLBACK = "hx:u:c";
/** Sent to the session as the owner's answer when "继续" is tapped. */
export const CONTINUE_TEXT =
  "继续完成这个任务：按 issue 的要求完成修复并验证，然后提交 PR。如果被阻塞，请用 Question: 说明需要我决定什么。";
const TASK_CONTINUE_TEXT =
  "继续完成原任务并验证：改代码时提交 PR，调查或报告任务请返回结论。如果被阻塞，请用 Question: 说明需要我决定什么。";

const GAPS = {
  noPr: "Lody 会话已停下，但还没有提交 PR",
  draft: "Lody 会话已停下，但 PR 仍是草稿",
  failed: "Lody 任务回合失败，请查看会话后继续或重试",
  canceled: "Lody 任务回合已取消，尚未确认完成",
  timeout: "等待 Lody 任务回合结束超时，尚未确认完成",
} as const;
const GAP_REASONS: readonly string[] = Object.values(GAPS);

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > EXCERPT_LIMIT ? `${single.slice(0, EXCERPT_LIMIT - 1)}…` : single;
}

async function deliveryGap(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
): Promise<string | null> {
  if (request.prNumber === null) return GAPS.noPr;
  const repo = config.project.repo;
  const draft =
    work.service.prFlow.knownDraft(repo, request.prNumber) ??
    (await work.github.getPullRequest(repo, request.prNumber)).draft;
  return draft ? GAPS.draft : null;
}

/**
 * Flags a session that went idle without delivering: `idle` on two polls in a row and quiet for
 * `undeliveredAfter`, so the pause between two turns is not mistaken for the end. A reported turn
 * end (`work.turnEnded`) is final, so one idle status is enough. The flag lifts itself once the
 * session runs again or the delivery shows up. A task without a PR is finished instead of
 * flagged. Returns true on a state change.
 */
export async function checkDelivery(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
  session: LodySession,
): Promise<boolean> {
  const { service } = work;
  if (request.state === S.completed) return resumeTask(work, request, job, session);
  const watched = request.prNumber === null ? S.running : S.prReady;
  if (request.state === S.needsAttention && GAP_REASONS.includes(request.stateReason ?? "")) {
    const resumed = session.status === RUNNING;
    const recoveredTask =
      request.type === "task" &&
      request.prNumber === null &&
      job.sessionId &&
      work.turnEnded(job.sessionId);
    if (!resumed && !recoveredTask && (await deliveryGap(work, config, request))) return false;
    const moved = await service.store.transitionRequest(request.id, [S.needsAttention], watched, {
      stateReason: null,
    });
    if (moved) {
      await service.recordEvent({
        type: "session.delivery_resumed",
        projectKey: request.projectKey,
        requestId: request.id,
        payload: { resumed },
      });
    }
    return moved;
  }
  if (request.state !== watched || !job.sessionId || session.status !== IDLE) return false;
  const outcome = work.turnStatus(job.sessionId);
  const interrupted = request.type === "task" && outcome && outcome !== "completed";
  if (
    !interrupted &&
    !work.turnEnded(job.sessionId) &&
    !settledIdle(config, request, job, session, service.now())
  ) {
    return false;
  }
  const gap = interrupted ? GAPS[outcome] : await deliveryGap(work, config, request);
  if (!gap) return false;
  if (request.type === "task" && gap === GAPS.noPr) return finishTask(work, config, request, job);
  const moved = await service.store.transitionRequest(request.id, [watched], S.needsAttention, {
    stateReason: gap,
  });
  if (!moved) return false;
  const last = await service
    .lody()
    .lastAssistantMessage(job.sessionId)
    .catch((error) => ({ ok: false as const, message: errorText(error) }));
  const excerpt = last.ok && last.value ? clip(last.value) : null;
  await service.recordEvent({
    type: "session.undelivered",
    projectKey: request.projectKey,
    requestId: request.id,
    payload: {
      gap: interrupted ? outcome : gap === GAPS.noPr ? "no_pr" : "draft",
      excerptLength: excerpt?.length ?? 0,
      ...(last.ok ? {} : { historyError: last.message }),
    },
  });
  await notify(work, config, request, job, gap, excerpt);
  return true;
}

function settledIdle(
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
  session: LodySession,
  now: Date,
): boolean {
  if (job.sessionStatus !== IDLE) return false;
  const lastProgress = Math.max(
    ...[
      job.lastActivityAt,
      session.lastMessageAt,
      job.startedAt ?? job.createdAt,
      request.lastPushAt,
    ].map((date) => date?.getTime() ?? 0),
  );
  return now.getTime() - lastProgress >= durationMs(config.guardrails.time.undeliveredAfter);
}

async function notify(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
  gap: string,
  excerpt: string | null,
) {
  const { service } = work;
  const telegram = service.telegram;
  if (!telegram) return;
  const subject = `${request.issueNumber ? `#${request.issueNumber} ` : ""}${(request.title ?? "").slice(0, 80)}`;
  const lines = [`⏸ ${escapeHtml(subject)}\n${gap}`];
  if (excerpt) lines.push(`最后一条回复：「${escapeHtml(excerpt)}」`);
  lines.push("点「继续」让会话接着做，或回复这条消息说明要求；也可以在卡片上取消。");
  const url = sessionLink(config.executors.lody.sessionUrl, job.sessionId);
  const chatId = service.file.telegram.chatId;
  const sent = await telegram.send(chatId, {
    html: lines.join("\n"),
    keyboard: noticeKeyboard(url, true),
    threadId: service.projectThread(request.projectKey),
    replyToMessageId: request.cardMessageId ?? undefined,
  });
  await service.store.recordMessage({
    chatId,
    messageId: sent.messageId,
    requestId: request.id,
    kind: UNDELIVERED_KIND,
    ref: { jobId: job.id, sessionUrl: url },
  });
}

function noticeKeyboard(url: string | null, canContinue: boolean): HarnessKeyboard {
  const row = [];
  if (canContinue) row.push({ text: "▶️ 继续", callbackData: CONTINUE_CALLBACK });
  if (url) row.push({ text: "💬 打开会话", url });
  return row.length > 0 ? [row] : [];
}

/**
 * The "继续" button on an undelivered notice: answers the session exactly as a reply to the
 * notice would, then drops the button so a second tap does not send the nudge twice.
 */
export async function continueUndelivered(
  service: HarnessService,
  request: HarnessCallbackRequest,
): Promise<HarnessCallbackAnswer> {
  if (!service.port.isHarnessChat(request.chatId) || !service.port.isOwner(request.userId)) {
    return { text: "无权限" };
  }
  const notice = await service.store.findMessage(request.chatId, request.messageId);
  if (notice?.kind !== UNDELIVERED_KIND) return { text: "按钮已失效" };
  const target = await service.store.getRequest(notice.requestId);
  if (target?.state !== S.needsAttention || !GAP_REASONS.includes(target.stateReason ?? "")) {
    await dropContinue(service, request, notice.ref);
    return { text: "会话已经不在停下状态" };
  }
  const running = (await service.store.latestJob(target.id))?.state === JOB_STATES.running;
  const reply = await handleOwnerReply(service.work, {
    chatId: request.chatId,
    threadId: request.threadId,
    userId: request.userId,
    messageId: request.messageId,
    replyToMessageId: request.messageId,
    text: target.type === "task" ? TASK_CONTINUE_TEXT : CONTINUE_TEXT,
  });
  if (reply?.html) return { text: reply.html.replace(/<[^>]+>/g, ""), alert: true };
  await dropContinue(service, request, notice.ref);
  await service.recordEvent({
    type: "button.continue",
    projectKey: target.projectKey,
    requestId: target.id,
    actorId: request.userId,
  });
  return { text: running ? "已让会话继续" : "会话已结束，已在卡片下提供重新排队" };
}

async function dropContinue(
  service: HarnessService,
  request: HarnessCallbackRequest,
  ref: unknown,
): Promise<void> {
  const url = (ref as { sessionUrl?: unknown } | null)?.sessionUrl;
  await service.telegram
    ?.editKeyboard(
      request.chatId,
      request.messageId,
      noticeKeyboard(typeof url === "string" ? url : null, false),
    )
    .catch(() => {});
}
