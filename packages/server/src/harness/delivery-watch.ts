import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { durationMs } from "./config/units.js";
import { sessionLink } from "./job-card.js";
import type { LodySession } from "./lody.js";
import { errorText } from "./pr-actions.js";
import { REQUEST_STATES as S } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessWork } from "./work.js";
import type { HarnessJobRecord } from "./work-store.js";

/** Lody reports `running` during a turn and `idle` once the agent has stopped (CLI 0.100.0). */
const IDLE = "idle";
const RUNNING = "running";
const EXCERPT_LIMIT = 280;
export const UNDELIVERED_KIND = "undelivered";

const GAPS = {
  noPr: "Lody 会话已停下，但还没有提交 PR",
  draft: "Lody 会话已停下，但 PR 仍是草稿",
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
 * `undeliveredAfter`, so the pause between two turns is not mistaken for the end. The flag lifts
 * itself once the session runs again or the delivery shows up. Returns true on a state change.
 */
export async function checkDelivery(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
  session: LodySession,
): Promise<boolean> {
  const { service } = work;
  const watched = request.prNumber === null ? S.running : S.prReady;
  if (request.state === S.needsAttention && GAP_REASONS.includes(request.stateReason ?? "")) {
    const resumed = session.status === RUNNING;
    if (!resumed && (await deliveryGap(work, config, request))) return false;
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
  if (request.state !== watched || !job.sessionId) return false;
  if (session.status !== IDLE || job.sessionStatus !== IDLE) return false;
  const now = service.now();
  const lastProgress = Math.max(
    ...[
      job.lastActivityAt,
      session.lastMessageAt,
      job.startedAt ?? job.createdAt,
      request.lastPushAt,
    ].map((date) => date?.getTime() ?? 0),
  );
  if (now.getTime() - lastProgress < durationMs(config.guardrails.time.undeliveredAfter)) {
    return false;
  }
  const gap = await deliveryGap(work, config, request);
  if (!gap) return false;
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
      gap: gap === GAPS.noPr ? "no_pr" : "draft",
      excerptLength: excerpt?.length ?? 0,
      ...(last.ok ? {} : { historyError: last.message }),
    },
  });
  await notify(work, config, request, job, gap, excerpt);
  return true;
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
  lines.push("回复这条消息可以让会话继续，或在卡片上取消。");
  const url = sessionLink(config.executors.lody.sessionUrl, job.sessionId);
  const chatId = service.file.telegram.chatId;
  const sent = await telegram.send(chatId, {
    html: lines.join("\n"),
    keyboard: url ? [[{ text: "💬 打开会话", url }]] : [],
    threadId: service.projectThread(request.projectKey),
    replyToMessageId: request.cardMessageId ?? undefined,
  });
  await service.store.recordMessage({
    chatId,
    messageId: sent.messageId,
    requestId: request.id,
    kind: UNDELIVERED_KIND,
    ref: { jobId: job.id },
  });
}
