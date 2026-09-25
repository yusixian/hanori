import type { HarnessCallbackAnswer, HarnessCallbackRequest } from "@cos-tool-bot/bot";
import {
  APPROVAL_ACTIONS,
  APPROVAL_PROBLEM_TEXT,
  type CardVerb,
  decodeCallback,
} from "./approvals.js";
import { PICKER_KIND, dispatchJobAction } from "./job-actions.js";
import { REMINDER_KIND } from "./job-monitor.js";
import { errorText } from "./pr-actions.js";
import { prLockKey } from "./pr-flow.js";
import type { HarnessService } from "./service.js";
import type { HarnessApprovalRecord, HarnessRequestRecord } from "./store.js";

/** `callback_data` only names an approval; the persisted record decides what may happen. */
export async function handleHarnessCallback(
  service: HarnessService,
  request: HarnessCallbackRequest,
): Promise<HarnessCallbackAnswer> {
  const decoded = decodeCallback(request.data);
  if (!decoded) return { text: APPROVAL_PROBLEM_TEXT.missing };
  if (!service.port.isHarnessChat(request.chatId) || !service.port.isOwner(request.userId)) {
    return { text: "无权限" };
  }
  const approval = await service.store.getApproval(decoded.approvalId);
  const target = approval ? await service.store.getRequest(approval.requestId) : null;
  let answer: HarnessCallbackAnswer;
  if (!approval || !target || !(await belongsToMessage(service, approval, target, request))) {
    answer = { text: APPROVAL_PROBLEM_TEXT.missing };
  } else if (!service.projectKeys().includes(target.projectKey)) {
    answer = { text: "该项目已不在配置中" };
  } else {
    answer = await run(service, approval, target, decoded.verb, request).catch((error) => ({
      text: `操作失败：${errorText(error)}`,
      alert: true,
    }));
  }
  await service.recordEvent({
    type: `button.${decoded.verb}`,
    projectKey: target?.projectKey ?? null,
    requestId: target?.id ?? null,
    approvalId: decoded.approvalId,
    actorId: request.userId,
    payload: { outcome: answer.text ?? null },
  });
  service.logger.info(
    `Dev Harness button ${decoded.verb} by ${request.userId}: ${answer.text ?? "ok"}`,
  );
  return answer;
}

async function belongsToMessage(
  service: HarnessService,
  approval: HarnessApprovalRecord,
  target: HarnessRequestRecord,
  request: HarnessCallbackRequest,
): Promise<boolean> {
  if (approval.action === APPROVAL_ACTIONS.reminder) {
    const message = await service.store.findMessage(request.chatId, request.messageId);
    return message?.kind === REMINDER_KIND && message.requestId === target.id;
  }
  if (approval.action === APPROVAL_ACTIONS.picker) {
    const message = await service.store.findMessage(request.chatId, request.messageId);
    const listed = (message?.ref as { approvals?: unknown } | null)?.approvals;
    return message?.kind === PICKER_KIND && Array.isArray(listed) && listed.includes(approval.id);
  }
  if (target.cardMessageId !== request.messageId) return false;
  return approval.action !== APPROVAL_ACTIONS.merge || target.prNumber !== null;
}

/** Re-reads both records under the lock that owns the card, so no sync interleaves. */
function run(
  service: HarnessService,
  approval: HarnessApprovalRecord,
  target: HarnessRequestRecord,
  verb: CardVerb,
  request: HarnessCallbackRequest,
): Promise<HarnessCallbackAnswer> {
  const reread = async () => {
    const fresh = await service.store.getApproval(approval.id);
    const freshTarget = await service.store.getRequest(target.id);
    return fresh && freshTarget ? { fresh, freshTarget } : null;
  };
  if (approval.action === APPROVAL_ACTIONS.merge) {
    return service.prFlow.lock.run(prLockKey(target.repo, target.prNumber!), async () => {
      const records = await reread();
      if (!records) return { text: APPROVAL_PROBLEM_TEXT.missing };
      return service.prActions.dispatch(verb, records.fresh, records.freshTarget, request.userId);
    });
  }
  return service.work.withRequest(target.id, async () => {
    const records = await reread();
    if (!records) return { text: APPROVAL_PROBLEM_TEXT.missing };
    return dispatchJobAction(service.work, verb, {
      approval: records.fresh,
      request: records.freshTarget,
      actorId: request.userId,
      chatId: request.chatId,
      messageId: request.messageId,
    });
  });
}
