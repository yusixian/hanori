import type { HarnessCommandRequest, HarnessKeyboard, HarnessReply } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import {
  APPROVAL_ACTIONS,
  type CardVerb,
  encodeCallback,
  ensureApproval,
  jobBinding,
} from "./approvals.js";
import { PICKER_KIND, requeue, requeueProblem, subject } from "./job-actions.js";
import { REQUEST_HEADLINES, formatElapsed, issueUrl } from "./job-card.js";
import { MESSAGE_LIMIT, topicLink } from "./render.js";
import type { HarnessService } from "./service.js";
import { JOB_STATES, REQUEST_STATES as S, TERMINAL_STATES } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";

const IN_FLIGHT_STATES = Object.values(S).filter(
  (state) => !(TERMINAL_STATES as readonly string[]).includes(state),
);
const MAX_CHOICES = 8;
const SHORT_ID = 8;
/** Only ids and numbers are kept in events; free text typed after the command is not. */
const TARGET = /^(#?\d{1,9}|[\w-]{4,40})$/;

type Control = "cancel" | "retry";

const COPY: Record<Control, { verb: CardVerb; icon: string; name: string; empty: string }> = {
  cancel: { verb: "abort", icon: "✖️", name: "取消", empty: "没有可以取消的请求" },
  retry: { verb: "start", icon: "🔁", name: "重新排队", empty: "没有需要重新排队的请求" },
};

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID);
}

/** In-flight requests in the topic's project, or in every project from General. */
async function inFlight(service: HarnessService, projectKey: string | undefined) {
  const keys = projectKey ? [projectKey] : service.projectKeys();
  const requests = await service.store.listRequestsByState(IN_FLIGHT_STATES);
  return requests.filter((request) => keys.includes(request.projectKey));
}

function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

async function requestLine(service: HarnessService, request: HarnessRequestRecord) {
  const headline = REQUEST_HEADLINES[request.state] ?? request.state;
  const refs = [
    request.issueNumber
      ? `<a href="${escapeHtml(issueUrl(request.repo, request.issueNumber))}">#${request.issueNumber}</a>`
      : null,
    escapeHtml((request.title ?? "未命名请求").slice(0, 60)),
    request.prNumber
      ? `<a href="${escapeHtml(prUrl(request.repo, request.prNumber))}">PR #${request.prNumber}</a>`
      : null,
  ].filter(Boolean);
  const meta = [`${formatElapsed(service.now().getTime() - request.createdAt.getTime())}前`];
  const job = request.type === "bug" ? await service.store.latestJob(request.id) : null;
  const config = service.work.config(request.projectKey);
  if (job && job.state !== JOB_STATES.lost && config) {
    meta.push(escapeHtml(service.work.machineLabel(config, job)));
  }
  meta.push(`<code>${shortId(request.id)}</code>`);
  return `• ${headline} · ${refs.join(" ")}\n  ${meta.join(" · ")}`;
}

function fit(lines: string[]): string {
  let text = "";
  for (const [index, line] of lines.entries()) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > MESSAGE_LIMIT - 40) return `${text}\n…另有 ${lines.length - index} 行未显示`;
    text = next;
  }
  return text;
}

export async function listRequests(
  service: HarnessService,
  projectKey: string | undefined,
): Promise<HarnessReply> {
  const requests = await inFlight(service, projectKey);
  if (requests.length === 0) return { html: "当前没有进行中的请求。" };
  const chatId = service.file.telegram.chatId;
  const lines: string[] = [`<b>进行中的请求（${requests.length}）</b>`];
  const keys = projectKey ? [projectKey] : service.projectKeys();
  for (const key of keys) {
    const group = requests.filter((request) => request.projectKey === key);
    if (group.length === 0) continue;
    if (!projectKey) {
      const threadId = service.projectThread(key);
      const name = threadId
        ? `<a href="${topicLink(chatId, threadId)}">${escapeHtml(key)}</a>`
        : escapeHtml(key);
      lines.push("", `<b>${name}</b>`);
    }
    for (const request of group) lines.push(await requestLine(service, request));
  }
  lines.push("", "/cancel 或 /retry 后跟 ID 或 #编号 可直接操作。");
  return { html: fit(lines) };
}

/** `#12` or `12` matches an issue or PR number; anything else is an id prefix. */
function matches(request: HarnessRequestRecord, target: string): boolean {
  const number = /^#?(\d+)$/.exec(target)?.[1];
  if (number) {
    const value = Number(number);
    return request.issueNumber === value || request.prNumber === value;
  }
  return target.length >= 4 && request.id.toLowerCase().startsWith(target.toLowerCase());
}

async function candidates(
  service: HarnessService,
  control: Control,
  projectKey: string | undefined,
  target: string,
) {
  const requests = (await inFlight(service, projectKey)).filter((r) => r.type === "bug");
  if (target) return requests.filter((request) => matches(request, target));
  if (control === "cancel") return requests;
  const retryable: HarnessRequestRecord[] = [];
  for (const request of requests) {
    if (request.state !== S.needsAttention) continue;
    const job = await service.store.latestJob(request.id);
    if (!requeueProblem(request, job)) retryable.push(request);
  }
  return retryable;
}

/**
 * `/cancel` and `/retry`: a single match acts at once through the same transitions as the card
 * buttons when it was named or is the topic's only one; otherwise a picker offers the matches and
 * its buttons go through the button path.
 */
export async function runControl(
  service: HarnessService,
  control: Control,
  request: HarnessCommandRequest,
  projectKey: string | undefined,
): Promise<HarnessReply> {
  const target = request.args.trim().split(/\s+/, 1)[0] ?? "";
  const found = await candidates(service, control, projectKey, target);
  const copy = COPY[control];
  let outcome: string;
  let reply: HarnessReply;
  if (found.length === 0) {
    outcome = "none";
    reply = {
      html: target
        ? `没有找到匹配 <code>${escapeHtml(target)}</code> 的进行中请求。`
        : `${copy.empty}。`,
    };
  } else if (found.length === 1 && (target || projectKey)) {
    ({ reply, outcome } = await act(service, control, found[0]!, request.userId));
  } else {
    outcome = "picker";
    reply = await sendPicker(service, control, found, request);
  }
  await service.recordEvent({
    type: `command.${control}`,
    projectKey: projectKey ?? null,
    requestId: outcome === "picker" ? null : (found[0]?.id ?? null),
    actorId: request.userId,
    payload: {
      target: TARGET.test(target) ? target : target ? "unparsed" : null,
      matches: found.length,
      outcome,
    },
  });
  return reply;
}

async function act(
  service: HarnessService,
  control: Control,
  target: HarnessRequestRecord,
  actorId: number,
): Promise<{ reply: HarnessReply; outcome: string }> {
  const { work } = service;
  const label = escapeHtml(subject(target));
  const result = (outcome: string, html: string) => ({ outcome, reply: { html } });
  return work.withRequest(target.id, async () => {
    const fresh = await service.store.getRequest(target.id);
    if (!fresh || !IN_FLIGHT_STATES.includes(fresh.state as never)) {
      return result("ended", `${label} 已经结束。`);
    }
    if (control === "cancel") {
      const cancelled = await work.cancel(fresh, actorId, "owner 已取消（/cancel）");
      return cancelled
        ? result("cancelled", `⚫ 已取消 ${label}`)
        : result("ended", `${label} 已经结束。`);
    }
    const problem = requeueProblem(fresh, await service.store.latestJob(fresh.id));
    if (problem) return result("refused", `${label}：${problem}`);
    if (!(await requeue(work, fresh))) return result("changed", `${label} 的状态已变化。`);
    return result("requeued", `🔁 已重新排队 ${label}`);
  });
}

async function sendPicker(
  service: HarnessService,
  control: Control,
  found: HarnessRequestRecord[],
  request: HarnessCommandRequest,
): Promise<HarnessReply> {
  const copy = COPY[control];
  const shown = found.slice(0, MAX_CHOICES);
  const approvals: string[] = [];
  const keyboard: HarnessKeyboard = [];
  for (const target of shown) {
    const config = service.work.requireConfig(target.projectKey);
    const job = await service.store.latestJob(target.id);
    const approval = await ensureApproval(service.store, target, {
      action: APPROVAL_ACTIONS.picker,
      binding: jobBinding(target, job?.sessionId),
      ttl: config.approvals.ttl,
      now: service.now(),
      reuse: false,
    });
    approvals.push(approval.id);
    keyboard.push([
      {
        text: `${copy.icon} ${subject(target).slice(0, 30)}`,
        callbackData: encodeCallback(approval.id, copy.verb),
      },
    ]);
  }
  const more =
    found.length > shown.length
      ? `\n另有 ${found.length - shown.length} 个未列出，请用 ID 指定。`
      : "";
  const telegram = service.telegram;
  if (!telegram) return { html: "Telegram 尚未就绪。" };
  const sent = await telegram.send(request.chatId, {
    html: `选择要${copy.name}的请求：${more}`,
    keyboard,
    threadId: request.threadId,
    replyToMessageId: request.messageId,
  });
  await service.store.recordMessage({
    chatId: request.chatId,
    messageId: sent.messageId,
    requestId: shown[0]!.id,
    kind: PICKER_KIND,
    ref: { control, approvals },
  });
  return { html: "" };
}
