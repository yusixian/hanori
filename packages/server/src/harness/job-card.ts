import type { HarnessInlineButton, HarnessKeyboard } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { encodeCallback } from "./approvals.js";
import { renderFooter } from "./quota.js";
import { REQUEST_STATES as S } from "./states.js";
import type { HarnessRequestRecord } from "./store.js";
import type { HarnessJobRecord } from "./work-store.js";

export const REQUEST_HEADLINES: Record<string, string> = {
  [S.open]: "🟢 PR 待处理",
  [S.prReady]: "🟢 PR 待合并",
  [S.received]: "⚪ 待开始",
  [S.queued]: "⏳ 排队中",
  [S.starting]: "🔵 启动中",
  [S.running]: "🔵 进行中",
  [S.revising]: "✏️ 修订中",
  [S.needsSpec]: "📝 需要写 spec",
  [S.needsAttention]: "👀 需要你看一下",
  [S.cancelled]: "⚫ 已取消",
  [S.failed]: "🔴 失败",
};

export interface JobCardInput {
  request: Pick<HarnessRequestRecord, "state" | "title" | "issueNumber" | "repo" | "stateReason">;
  job: HarnessJobRecord | null;
  machineLabel: string | null;
  now: Date;
  cards: { showDuration: boolean; showQuota: boolean; showContext: boolean };
  approvalId: string | null;
  sessionUrl: string | null;
  queuedSince?: Date | null;
}

export function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分钟`;
}

/** Coarse steps, so a long wait edits the card every few minutes rather than every tick. */
export function queueAge(ms: number): string | null {
  if (ms < 60_000) return null;
  const step = ms < 5 * 60_000 ? 60_000 : ms < 3_600_000 ? 5 * 60_000 : 30 * 60_000;
  return `已排队 ${formatElapsed(Math.floor(ms / step) * step)}`;
}

export function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

export function sessionLink(template: string | null, sessionId: string | null): string | null {
  return template && sessionId
    ? template.replaceAll("{sessionId}", encodeURIComponent(sessionId))
    : null;
}

function openButton(input: JobCardInput): HarnessInlineButton | null {
  if (!input.job?.sessionId) return null;
  const url = sessionLink(input.sessionUrl, input.job.sessionId);
  if (url) return { text: "💬 打开会话", url };
  return input.approvalId
    ? { text: "💬 打开会话", callbackData: encodeCallback(input.approvalId, "open") }
    : null;
}

function keyboard(input: JobCardInput): HarnessKeyboard {
  const { state } = input.request;
  const id = input.approvalId;
  if (!id) return [];
  const abort = { text: "✖️ 取消", callbackData: encodeCallback(id, "abort") };
  const start = { text: "▶️ 开始", callbackData: encodeCallback(id, "start") };
  const open = openButton(input);
  switch (state) {
    case S.received:
      return [[start, abort]];
    case S.queued:
      return [[abort]];
    case S.needsAttention:
      return input.job?.state === "running"
        ? [[abort, ...(open ? [open] : [])]]
        : [[{ ...start, text: "🔁 重新排队" }, abort]];
    case S.starting:
    case S.running:
    case S.revising:
    case S.needsSpec:
      return [[abort, ...(open ? [open] : [])]];
    default:
      return [];
  }
}

export function renderJobCard(input: JobCardInput): { html: string; keyboard: HarnessKeyboard } {
  const { request, job, now } = input;
  const title = escapeHtml((request.title ?? "未命名请求").slice(0, 120));
  const issue = request.issueNumber
    ? `<a href="${escapeHtml(issueUrl(request.repo, request.issueNumber))}">#${request.issueNumber}</a> `
    : "";
  const lines = [`<b>${REQUEST_HEADLINES[request.state] ?? request.state}</b> · ${issue}${title}`];
  if (job && job.state !== "lost") {
    const parts = [
      `机器 ${escapeHtml(input.machineLabel ?? job.lodyMachine)}`,
      `模型 ${escapeHtml(job.modelName ?? job.model ?? "默认")}`,
    ];
    if (input.cards.showDuration && job.startedAt) {
      const end = job.endedAt ?? now;
      parts.push(`已用 ${formatElapsed(end.getTime() - job.startedAt.getTime())}`);
    }
    lines.push(parts.join(" · "));
    const footer = renderFooter(job, input.cards);
    if (footer) lines.push(escapeHtml(footer));
  }
  if (request.stateReason) lines.push(escapeHtml(request.stateReason.slice(0, 300)));
  const queued =
    request.state === S.queued && input.queuedSince
      ? queueAge(now.getTime() - input.queuedSince.getTime())
      : null;
  if (queued) lines.push(queued);
  return { html: lines.join("\n"), keyboard: keyboard(input) };
}

export function renderReminder(input: {
  kind: "idle" | "run";
  issueNumber: number | null;
  title: string | null;
  elapsedMs: number;
  approvalId: string;
  openButton: HarnessInlineButton | null;
}): { html: string; keyboard: HarnessKeyboard } {
  const subject = `${input.issueNumber ? `#${input.issueNumber} ` : ""}${escapeHtml((input.title ?? "").slice(0, 80))}`;
  const text =
    input.kind === "idle"
      ? `⏰ ${subject} 已 ${formatElapsed(input.elapsedMs)}没有进展`
      : `⏰ ${subject} 已运行 ${formatElapsed(input.elapsedMs)}`;
  return {
    html: `${text}\n超时只提醒，不会自动取消。`,
    keyboard: [
      [
        { text: "⏳ 继续等", callbackData: encodeCallback(input.approvalId, "wait") },
        { text: "✖️ 取消", callbackData: encodeCallback(input.approvalId, "abort") },
        ...(input.openButton ? [input.openButton] : []),
      ],
    ],
  };
}
