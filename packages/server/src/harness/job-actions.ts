import type { HarnessCallbackAnswer } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import {
  APPROVAL_ACTIONS,
  APPROVAL_PROBLEM_TEXT,
  type CardVerb,
  checkApproval,
  jobBinding,
} from "./approvals.js";
import { JOB_STATES, REQUEST_STATES as S, isTerminal } from "./states.js";
import type { HarnessApprovalRecord, HarnessRequestRecord } from "./store.js";
import type { HarnessJobRecord } from "./work-store.js";
import type { HarnessWork } from "./work.js";

/** Message kinds recorded so owner replies and picker buttons find their request. */
export const PICKER_KIND = "picker";
export const REJECT_PROMPT_KIND = "reject_prompt";

export const CANCEL_CONFIRM_NOTE =
  "确认取消？会停止 Lody 会话并结束跟进；PR 保持打开，需要时在 GitHub 关闭。";

export interface JobActionContext {
  approval: HarnessApprovalRecord;
  request: HarnessRequestRecord;
  actorId: number;
  chatId: number;
  messageId: number;
}

/** Why a request cannot go back to the queue, or null when it can. */
export function requeueProblem(
  request: HarnessRequestRecord,
  job: HarnessJobRecord | null,
): string | null {
  if (![S.received, S.needsAttention].includes(request.state as never)) return "当前状态不能开始";
  if (job?.state === JOB_STATES.running) return "会话仍在运行，请直接回复卡片给出反馈";
  return null;
}

/** Caller holds the request lock and has checked `requeueProblem`. */
export async function requeue(work: HarnessWork, request: HarnessRequestRecord): Promise<boolean> {
  const moved = await work.service.store.transitionRequest(request.id, [request.state], S.queued, {
    stateReason: null,
  });
  if (!moved) return false;
  const fresh = await work.service.store.getRequest(request.id);
  if (fresh) await work.refreshCard(fresh);
  void work.scheduler.tick();
  return true;
}

/** Job card, PR card session row, reminder, and picker buttons; the caller holds the request lock. */
export async function dispatchJobAction(
  work: HarnessWork,
  verb: CardVerb,
  context: JobActionContext,
): Promise<HarnessCallbackAnswer> {
  const { service } = work;
  const { approval, request, actorId } = context;
  const now = service.now();
  const check = checkApproval(approval, now);
  if (!check.ok) {
    if (check.problem === "expired") await work.refreshCard(request);
    return { text: APPROVAL_PROBLEM_TEXT[check.problem] };
  }
  const job = await service.store.latestJob(request.id);
  // Re-check: the button must still describe the current attempt.
  if (approval.headSha !== jobBinding(request, job?.sessionId) || isTerminal(request.state)) {
    await work.refreshCard(request);
    return { text: "请求状态已变化，旧按钮已失效" };
  }
  const isReminder = approval.action === APPROVAL_ACTIONS.reminder;
  const isPicker = approval.action === APPROVAL_ACTIONS.picker;

  switch (verb) {
    case "open": {
      if (!job?.sessionId) return { text: "会话尚未创建" };
      return {
        text: `Lody 会话 ${job.sessionId}（${job.lodyMachine}）。请在 Lody 桌面端或手机端打开。`,
        alert: true,
      };
    }
    case "start": {
      const problem = requeueProblem(request, job);
      if (problem) return { text: problem };
      if (!(await service.store.consumeApproval(approval.id, actorId, now))) {
        return { text: APPROVAL_PROBLEM_TEXT.consumed };
      }
      if (!(await requeue(work, request))) return { text: "请求状态已变化" };
      if (isReminder) await closeMessage(work, context, "⏰ 已重新排队");
      if (isPicker) await closeMessage(work, context, `🔁 已重新排队：${subject(request)}`);
      return { text: "已加入队列" };
    }
    case "wait": {
      if (!isReminder || !job) return { text: APPROVAL_PROBLEM_TEXT.missing };
      if (!(await service.store.consumeApproval(approval.id, actorId, now))) {
        return { text: APPROVAL_PROBLEM_TEXT.consumed };
      }
      await service.store.updateJob(job.id, { lastActivityAt: now, idleRemindedAt: null });
      await closeMessage(work, context, "⏰ 已选择继续等");
      return { text: "好的，继续等" };
    }
    case "abort": {
      if (!(await service.store.consumeApproval(approval.id, actorId, now))) {
        return { text: APPROVAL_PROBLEM_TEXT.consumed };
      }
      const cancelled = await work.cancel(request, actorId, "owner 已取消");
      if (isReminder) await closeMessage(work, context, "⏰ 已取消请求");
      if (isPicker) await closeMessage(work, context, `⚫ 已取消：${subject(request)}`);
      return { text: cancelled ? "已取消" : "请求已结束" };
    }
    case "abortAsk": {
      if (!request.prNumber) return { text: APPROVAL_PROBLEM_TEXT.missing };
      await service.prFlow.sync(request.projectKey, request.prNumber, {
        reason: "cancel_confirm",
        confirmingCancel: true,
        note: CANCEL_CONFIRM_NOTE,
      });
      return { text: "请确认取消" };
    }
    case "back":
      await work.refreshCard(request);
      return { text: "已返回" };
    case "reject":
      return askRejectReason(work, context, job);
    default:
      return { text: APPROVAL_PROBLEM_TEXT.missing };
  }
}

/** The owner's reply to this prompt takes the regular card-reply path, so it becomes a revise turn. */
async function askRejectReason(
  work: HarnessWork,
  context: JobActionContext,
  job: HarnessJobRecord | null,
): Promise<HarnessCallbackAnswer> {
  const { service } = work;
  const { request, chatId } = context;
  if (!request.prNumber || !service.telegram) return { text: APPROVAL_PROBLEM_TEXT.missing };
  if (job?.state !== JOB_STATES.running) return { text: "会话已结束，请先重新排队" };
  const sent = await service.telegram.send(chatId, {
    html: `↩️ 打回 PR #${request.prNumber}：回复这条消息写明原因，会作为修改意见发给会话。`,
    threadId: service.projectThread(request.projectKey),
    replyToMessageId: context.messageId,
    forceReply: { placeholder: "打回原因" },
  });
  await service.store.recordMessage({
    chatId,
    messageId: sent.messageId,
    requestId: request.id,
    kind: REJECT_PROMPT_KIND,
    ref: { number: request.prNumber },
  });
  return { text: "请回复打回原因" };
}

export function subject(request: Pick<HarnessRequestRecord, "issueNumber" | "title">): string {
  const title = (request.title ?? "未命名请求").slice(0, 40);
  return request.issueNumber ? `#${request.issueNumber} ${title}` : title;
}

async function closeMessage(work: HarnessWork, context: JobActionContext, text: string) {
  await work.service.telegram
    ?.edit(context.chatId, context.messageId, "text", { html: escapeHtml(text), keyboard: [] })
    .catch(() => "missing");
}
