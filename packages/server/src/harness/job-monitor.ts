import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { APPROVAL_ACTIONS, encodeCallback, ensureApproval } from "./approvals.js";
import type { ProjectEffectiveConfig } from "./config/schema.js";
import { durationMs } from "./config/units.js";
import { renderReminder, sessionLink } from "./job-card.js";
import { type LodyMachine, findMachine } from "./lody.js";
import { quotaSnapshot, renderFooter, weeklyWarnings } from "./quota.js";
import { formatDateTime } from "./render.js";
import { ACTIVE_STATES, JOB_STATES, REQUEST_STATES as S, isTerminal } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessWork } from "./work.js";
import type { HarnessJobPatch, HarnessJobRecord } from "./work-store.js";

export const REMINDER_KIND = "reminder";

function latest(...dates: Array<Date | null | undefined>): Date {
  return new Date(Math.max(...dates.map((date) => date?.getTime() ?? 0)));
}

export async function pollJobs(work: HarnessWork): Promise<void> {
  const { service } = work;
  const jobs = await service.store.listJobs([JOB_STATES.running]);
  if (jobs.length === 0) return;
  const now = service.now();
  const listed = await service.lody().listMachines();
  const machines = listed.ok ? listed.value : [];
  for (const job of jobs) {
    if (job.nextPollAt && job.nextPollAt > now) continue;
    await work.withRequest(job.requestId, () => pollJob(work, job, machines));
  }
}

async function pollJob(work: HarnessWork, stale: HarnessJobRecord, machines: LodyMachine[]) {
  const { service } = work;
  const request = await service.store.getRequest(stale.requestId);
  const job = await service.store.latestJob(stale.requestId);
  if (!request || !job || job.id !== stale.id || job.state !== JOB_STATES.running) return;
  const now = service.now();
  if (isTerminal(request.state)) {
    await service.store.updateJob(job.id, { state: JOB_STATES.done, endedAt: now });
    return;
  }
  const config = work.config(request.projectKey);
  if (!config || !job.sessionId) return;
  const { poll } = config.executors.lody;
  const patch: HarnessJobPatch = {};
  const shown = await service.lody().showSession(job.sessionId);
  if (shown.ok) {
    const session = shown.value;
    patch.sessionStatus = session.status;
    if (session.model?.name) patch.modelName = session.model.name;
    if (session.context) {
      patch.contextUsed = session.context.used;
      patch.contextSize = session.context.size;
    }
    patch.lastActivityAt = latest(job.lastActivityAt, session.lastMessageAt);
    patch.nextPollAt = new Date(
      now.getTime() + durationMs(session.status === "running" ? poll.active : poll.idle),
    );
  } else {
    patch.nextPollAt = new Date(now.getTime() + durationMs(poll.idle));
  }
  const machine = findMachine(machines, job.lodyMachine);
  if (machine) patch.quota = quotaSnapshot(machine, job.provider, patch.modelName ?? job.model);
  const footerBefore = renderFooter(job, config.telegram.cards);
  const updated = { ...job, ...patch };
  await service.store.updateJob(job.id, patch);

  if (shown.ok && shown.value.archived) {
    await service.store.updateJob(job.id, { state: JOB_STATES.done, endedAt: now });
    await service.store.transitionRequest(
      request.id,
      [...ACTIVE_STATES, S.prReady],
      S.needsAttention,
      { stateReason: "Lody 会话已在别处归档，可以重新排队开新会话" },
    );
  } else if ((ACTIVE_STATES as readonly string[]).includes(request.state)) {
    if (await checkGuardrails(work, config, request, updated)) return;
  }
  const fresh = (await service.store.getRequest(request.id)) ?? request;
  if (!fresh.prNumber || renderFooter(updated, config.telegram.cards) !== footerBefore) {
    await work.refreshCard(fresh);
  }
}

/** Returns true when the request was cancelled. Reminders never cancel on their own. */
async function checkGuardrails(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
): Promise<boolean> {
  const { service } = work;
  const now = service.now();
  const { time } = config.guardrails;
  const startedAt = job.startedAt ?? job.createdAt;
  const runningFor = now.getTime() - startedAt.getTime();
  if (time.hardCancelAfter && runningFor >= durationMs(time.hardCancelAfter)) {
    await work.cancel(request, null, `运行超过 ${time.hardCancelAfter}，已自动取消`);
    return true;
  }
  // One reminder per idle stretch; progress or [继续等] (which counts as activity) re-arms it.
  const lastProgress = latest(job.lastActivityAt, request.lastPushAt, startedAt);
  const remindedThisStretch = job.idleRemindedAt !== null && job.idleRemindedAt >= lastProgress;
  if (
    !remindedThisStretch &&
    now.getTime() - lastProgress.getTime() >= durationMs(time.idleRemindAfter)
  ) {
    await sendReminder(work, config, request, job, "idle", now.getTime() - lastProgress.getTime());
    await service.store.updateJob(job.id, { idleRemindedAt: now });
  }
  if (!job.runRemindedAt && runningFor >= durationMs(time.runRemindAfter)) {
    await sendReminder(work, config, request, job, "run", runningFor);
    await service.store.updateJob(job.id, { runRemindedAt: now });
  }
  return false;
}

async function sendReminder(
  work: HarnessWork,
  config: ProjectEffectiveConfig,
  request: HarnessRequestRecord,
  job: HarnessJobRecord,
  kind: "idle" | "run",
  elapsedMs: number,
) {
  const { service } = work;
  const telegram = service.telegram;
  if (!telegram) return;
  const now = service.now();
  const approval = await ensureApproval(service.store, request, {
    action: APPROVAL_ACTIONS.reminder,
    binding: `session:${job.sessionId}`,
    ttl: config.approvals.ttl,
    now,
    reuse: false,
  });
  const url = sessionLink(config.executors.lody.sessionUrl, job.sessionId);
  const reminder = renderReminder({
    kind,
    issueNumber: request.issueNumber,
    title: request.title,
    elapsedMs,
    approvalId: approval.id,
    openButton: url
      ? { text: "💬 打开会话", url }
      : { text: "💬 打开会话", callbackData: encodeCallback(approval.id, "open") },
  });
  const chatId = service.file.telegram.chatId;
  const sent = await telegram.send(chatId, {
    ...reminder,
    threadId: service.projectThread(request.projectKey),
    replyToMessageId: request.cardMessageId ?? undefined,
  });
  await service.store.recordMessage({
    chatId,
    messageId: sent.messageId,
    requestId: request.id,
    kind: REMINDER_KIND,
    ref: { kind, approvalId: approval.id, jobId: job.id },
  });
  await service.recordEvent({
    type: `reminder.${kind}`,
    projectKey: request.projectKey,
    requestId: request.id,
    approvalId: approval.id,
    payload: { elapsedMs },
  });
}

function generalThread(overview: "general" | number): number | undefined {
  return overview === "general" ? undefined : overview;
}

/** One General-topic warning per machine, limit, and reset window. */
export async function warnQuota(work: HarnessWork): Promise<void> {
  const { service } = work;
  const telegram = service.telegram;
  if (!telegram) return;
  const config = service.globalView().config;
  const listed = await service.lody().listMachines();
  if (!listed.ok) return;
  for (const entry of Object.values(config.machines)) {
    if (!entry.enabled) continue;
    const machine = findMachine(listed.value, entry.lody);
    if (!machine) continue;
    for (const { limit, window, threshold } of weeklyWarnings(
      machine,
      config.guardrails.quota.warnAt.week,
    )) {
      const resets = window.resetsAt?.getTime() ?? 0;
      const key = `quota-warn:${machine.id}:${limit.key}:${window.label ?? ""}:${resets}`;
      const fresh = await service.store.recordDelivery(key, {
        type: "quota.warned",
        payload: { machine: machine.name, limit: limit.key, usedPercent: window.usedPercent },
      });
      if (!fresh) continue;
      const name = [limit.providerId, window.label ?? limit.limitName].filter(Boolean).join(" · ");
      const resetText = window.resetsAt
        ? `，${formatDateTime(window.resetsAt, config.telegram.notify.timezone)} 重置`
        : "";
      await telegram.send(config.telegram.chatId, {
        html: `⚠️ ${escapeHtml(machine.name)} ${escapeHtml(name)} 本周额度已用 ${window.usedPercent}%（提醒阈值 ${threshold}%）${resetText}`,
        threadId: generalThread(config.telegram.topics.overview),
      });
    }
  }
}
