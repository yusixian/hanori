import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { stringify } from "yaml";
import { LAYER_LABELS, type LayerName } from "./config/layers.js";
import type { LodyLimit, LodyMachine, LodyResult, LodyWindow } from "./lody.js";

export const MESSAGE_LIMIT = 3800;

export function renderUsageHint(projectKey: string | undefined): string {
  const scope = projectKey ? `当前话题绑定项目 <b>${escapeHtml(projectKey)}</b>。` : "";
  return [
    `${scope}这个群只处理 Dev Harness 命令，不闲聊。`,
    "可用：/bug 描述 · /status 状态 · /quota 额度 · /harness config|set|unset|diff|export|reload",
    "回复卡片即是反馈。/feature 与普通消息分诊将在后续阶段开放。",
  ].join("\n");
}

export function formatDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function topicLink(chatId: number, threadId: number): string {
  const internal = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${internal}/${threadId}`;
}

function windowName(window: LodyWindow): string {
  const base =
    window.span === "fiveHour"
      ? "5 小时"
      : window.span === "week"
        ? "本周"
        : `${Math.round(window.durationSeconds / 3600)} 小时`;
  return window.label ? `${base} · ${window.label}` : base;
}

function renderWindow(window: LodyWindow, limit: LodyLimit, timeZone: string): string {
  const name =
    limit.limitName && !window.label
      ? `${windowName(window)} · ${limit.limitName}`
      : windowName(window);
  if (window.expired) return `  ${escapeHtml(name)} ${window.usedPercent}% · 已过期`;
  const resets = window.resetsAt ? ` · ${formatDateTime(window.resetsAt, timeZone)} 重置` : "";
  return `  ${escapeHtml(name)} ${window.usedPercent}%${resets}`;
}

export function machineBadge(machine: LodyMachine): string {
  return machine.online ? "🟢 在线" : "⚪ 离线";
}

export function renderQuota(input: {
  result: LodyResult<LodyMachine[]>;
  machines: LodyMachine[];
  timeZone: string;
}): string {
  if (!input.result.ok) {
    return `<b>额度</b>\n执行层未配置：${escapeHtml(input.result.message)}`;
  }
  if (input.machines.length === 0) return "<b>额度</b>\nLody 中没有可显示的机器";
  const lines = ["<b>额度</b>"];
  for (const machine of input.machines) {
    lines.push("", `<b>${escapeHtml(machine.name)}</b> ${machineBadge(machine)}`);
    const byProvider = new Map<string, LodyLimit[]>();
    for (const limit of machine.limits) {
      if (limit.windows.length === 0) continue;
      byProvider.set(limit.providerId, [...(byProvider.get(limit.providerId) ?? []), limit]);
    }
    if (byProvider.size === 0) lines.push("  暂无额度数据（agent 运行后更新）");
    for (const [provider, limits] of byProvider) {
      const plan = limits.find((limit) => limit.planName)?.planName;
      lines.push(`${escapeHtml(provider)}${plan ? ` · ${escapeHtml(plan)}` : ""}`);
      for (const limit of limits) {
        for (const window of limit.windows) lines.push(renderWindow(window, limit, input.timeZone));
      }
    }
  }
  return lines.join("\n");
}

export function renderExecutionLine(
  result: LodyResult<LodyMachine[]>,
  machines: LodyMachine[],
): string {
  if (!result.ok) {
    return result.reason === "unavailable"
      ? `执行层未配置（${escapeHtml(result.message)}）`
      : `执行层不可用：${escapeHtml(result.message)}`;
  }
  if (machines.length === 0) return "执行层：Lody 中没有匹配的机器";
  return `执行机：${machines.map((m) => `${escapeHtml(m.name)} ${machineBadge(m)}`).join(" · ")}`;
}

export function toYaml(value: unknown): string {
  return stringify(value, { lineWidth: 100 }).trimEnd();
}

export function renderConfigValue(path: string, value: unknown, source: LayerName): string {
  const body = value === undefined ? "（未设置）" : toYaml(value);
  return [
    `<b>${escapeHtml(path)}</b> · 来源：${LAYER_LABELS[source]}`,
    `<pre>${escapeHtml(body)}</pre>`,
  ].join("\n");
}

export function renderIssues(
  title: string,
  issues: ReadonlyArray<{ path: string; message: string }>,
) {
  const shown = issues.slice(0, 15);
  const lines = [`<b>${escapeHtml(title)}</b>`];
  for (const issue of shown) {
    lines.push(`• <code>${escapeHtml(issue.path)}</code>：${escapeHtml(issue.message)}`);
  }
  if (issues.length > shown.length) lines.push(`…另有 ${issues.length - shown.length} 项`);
  return lines.join("\n");
}
