import type { HarnessCallbackAnswer } from "@cos-tool-bot/bot";
import {
  APPROVAL_ACTIONS,
  APPROVAL_PROBLEM_TEXT,
  type CardVerb,
  checkApproval,
  jobBinding,
} from "./approvals.js";
import { JOB_STATES, REQUEST_STATES as S, isTerminal } from "./states.js";
import type { HarnessApprovalRecord, HarnessRequestRecord } from "./store.js";
import type { HarnessWork } from "./work.js";

export interface JobActionContext {
  approval: HarnessApprovalRecord;
  request: HarnessRequestRecord;
  actorId: number;
  chatId: number;
  messageId: number;
}

/** Job card and reminder buttons; the caller holds the request lock. */
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

  switch (verb) {
    case "open": {
      if (!job?.sessionId) return { text: "会话尚未创建" };
      return {
        text: `Lody 会话 ${job.sessionId}（${job.lodyMachine}）。请在 Lody 桌面端或手机端打开。`,
        alert: true,
      };
    }
    case "start": {
      if (![S.received, S.needsAttention].includes(request.state as never)) {
        return { text: "当前状态不能开始" };
      }
      if (job?.state === JOB_STATES.running) {
        return { text: "会话仍在运行，请直接回复卡片给出反馈" };
      }
      if (!(await service.store.consumeApproval(approval.id, actorId, now))) {
        return { text: APPROVAL_PROBLEM_TEXT.consumed };
      }
      await service.store.transitionRequest(request.id, [request.state], S.queued, {
        stateReason: null,
      });
      if (isReminder) await closeReminder(work, context, "已重新排队");
      const fresh = await service.store.getRequest(request.id);
      if (fresh) await work.refreshCard(fresh);
      void work.scheduler.tick();
      return { text: "已加入队列" };
    }
    case "wait": {
      if (!isReminder || !job) return { text: APPROVAL_PROBLEM_TEXT.missing };
      if (!(await service.store.consumeApproval(approval.id, actorId, now))) {
        return { text: APPROVAL_PROBLEM_TEXT.consumed };
      }
      await service.store.updateJob(job.id, { lastActivityAt: now, idleRemindedAt: null });
      await closeReminder(work, context, "已选择继续等");
      return { text: "好的，继续等" };
    }
    case "abort": {
      if (!(await service.store.consumeApproval(approval.id, actorId, now))) {
        return { text: APPROVAL_PROBLEM_TEXT.consumed };
      }
      const cancelled = await work.cancel(request, actorId, "owner 已取消");
      if (isReminder) await closeReminder(work, context, "已取消请求");
      return { text: cancelled ? "已取消" : "请求已结束" };
    }
    default:
      return { text: APPROVAL_PROBLEM_TEXT.missing };
  }
}

async function closeReminder(work: HarnessWork, context: JobActionContext, note: string) {
  await work.service.telegram
    ?.edit(context.chatId, context.messageId, "text", { html: `⏰ ${note}`, keyboard: [] })
    .catch(() => "missing");
}
