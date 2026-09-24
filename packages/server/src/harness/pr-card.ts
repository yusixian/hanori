import type { HarnessKeyboard } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { encodeCallback } from "./approvals.js";
import { contentHash } from "./card-publisher.js";
import type { RiskTier } from "./config/schema.js";
import type { CheckSummary, ContractResult } from "./contract.js";

export type PrCardStatus =
  | "merged"
  | "closed"
  | "draft"
  | "ci_failed"
  | "ci_pending"
  | "t3"
  | "needs_details"
  | "ready";

export interface PrCardInput {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  tier: RiskTier;
  summary: string | null;
  checks: CheckSummary;
  contract: ContractResult;
  approvalId: string | null;
  detailsViewed: boolean;
  confirmingMerge?: boolean;
  imageUrl: string | null;
  note?: string;
  /** Context and quota line from the linked Lody session (dev-harness.md §5.3). */
  footer?: string | null;
}

export interface RenderedCard {
  status: PrCardStatus;
  html: string;
  keyboard: HarnessKeyboard;
  imageUrl: string | null;
}

export function determinePrStatus(
  input: Pick<PrCardInput, "state" | "merged" | "draft" | "tier" | "checks" | "detailsViewed">,
): PrCardStatus {
  if (input.merged) return "merged";
  if (input.state === "closed") return "closed";
  if (input.draft) return "draft";
  if (input.checks.state === "failure") return "ci_failed";
  if (input.checks.state === "pending") return "ci_pending";
  if (input.tier === "T3") return "t3";
  if (input.tier === "T2" && !input.detailsViewed) return "needs_details";
  return "ready";
}

const HEADLINES: Record<PrCardStatus, string> = {
  merged: "🟣 已合并",
  closed: "⚫ 已关闭",
  draft: "⚪ 草稿",
  ci_failed: "🔴 CI 失败",
  ci_pending: "🟡 等待 CI",
  t3: "🔒 需在 GitHub 合并",
  needs_details: "🟠 查看详情后可合并",
  ready: "🟢 可以合并",
};

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function checksLine(checks: CheckSummary): string {
  switch (checks.state) {
    case "none":
      return "CI：未发现检查";
    case "success":
      return `CI：✅ ${checks.passed}/${checks.total} 通过`;
    case "pending":
      return `CI：⏳ ${checks.pending} 项进行中 · ✅ ${checks.passed}/${checks.total}`;
    case "failure":
      return `CI：❌ ${escapeHtml(clip(checks.failedNames.slice(0, 3).join("、"), 80))} 失败`;
  }
}

export function renderPrCard(input: PrCardInput): RenderedCard {
  const status = determinePrStatus(input);
  const lines = [
    `<b>${HEADLINES[status]} · PR #${input.number} · ${input.tier}</b>`,
    escapeHtml(clip(input.title, 120)),
  ];
  // Without an AI summary the title line already says it; do not repeat it.
  const summary = input.summary?.trim();
  if (summary && clip(summary, 120) !== clip(input.title, 120)) {
    lines.push(`改了什么：${escapeHtml(clip(summary, 160))}`);
  }
  lines.push(checksLine(input.checks));
  if (input.contract.missing.length > 0) {
    lines.push(`缺少：${escapeHtml(clip(input.contract.missing.join("；"), 160))}`);
  }
  if (input.contract.flags.length > 0) {
    lines.push(`⚠️ ${escapeHtml(clip(input.contract.flags.join("；"), 160))}`);
  }
  if (status === "t3") lines.push("风险等级 T3：只通知，请在 GitHub 网页上合并");
  if (input.note) lines.push(escapeHtml(clip(input.note, 200)));
  if (input.footer) lines.push(escapeHtml(input.footer));
  lines.push(
    `<a href="${escapeHtml(input.url)}">${escapeHtml(input.repo)}#${input.number}</a>${
      input.author ? ` · @${escapeHtml(input.author)}` : ""
    }`,
  );

  return {
    status,
    html: lines.join("\n"),
    keyboard: renderKeyboard(input, status),
    imageUrl: input.imageUrl,
  };
}

function renderKeyboard(input: PrCardInput, status: PrCardStatus): HarnessKeyboard {
  const prLink = { text: status === "t3" ? "🔗 在 GitHub 合并" : "🔗 PR", url: input.url };
  const approvalId = input.approvalId;
  if (status === "merged" || status === "closed" || !approvalId) return [[prLink]];
  if (input.confirmingMerge && status === "ready") {
    return [
      [
        { text: "✅ 确认合并", callbackData: encodeCallback(approvalId, "confirm") },
        { text: "取消", callbackData: encodeCallback(approvalId, "cancel") },
      ],
    ];
  }
  const details = { text: "🔍 详情", callbackData: encodeCallback(approvalId, "details") };
  const refresh = { text: "🔄 刷新", callbackData: encodeCallback(approvalId, "refresh") };
  if (status === "ready") {
    return [
      [{ text: "✅ 合并", callbackData: encodeCallback(approvalId, "merge") }, details, prLink],
      [refresh],
    ];
  }
  if (status === "needs_details") {
    return [[{ ...details, text: "🔍 详情（查看后可合并）" }, prLink], [refresh]];
  }
  return [[details, refresh, prLink]];
}

export function cardHash(card: RenderedCard): string {
  return contentHash(card);
}

export function renderPrDetails(input: {
  number: number;
  tier: RiskTier;
  files: ReadonlyArray<{ path: string; tier: RiskTier; rule: string }>;
  checks: CheckSummary;
  contract: ContractResult;
}): string {
  const lines = [`<b>PR #${input.number} 详情 · ${input.tier}</b>`];
  lines.push(`<b>文件（${input.files.length}）</b>`);
  const shown = [...input.files].sort((a, b) => b.tier.localeCompare(a.tier)).slice(0, 25);
  for (const file of shown) {
    const rule = file.rule === "fixed" ? "固定 T3" : file.rule === "default" ? "默认" : "规则";
    lines.push(`${file.tier} <code>${escapeHtml(clip(file.path, 90))}</code>（${rule}）`);
  }
  if (input.files.length > shown.length)
    lines.push(`…另有 ${input.files.length - shown.length} 个文件`);
  lines.push("<b>交付合同</b>");
  for (const item of input.contract.items) {
    lines.push(`${item.ok ? "✅" : item.blocking ? "❌" : "⚠️"} ${escapeHtml(item.label)}`);
  }
  for (const flag of input.contract.flags) lines.push(`⚠️ ${escapeHtml(flag)}`);
  lines.push(checksLine(input.checks));
  if (input.checks.missingRequired.length > 0) {
    lines.push(`未上报的必需检查：${escapeHtml(input.checks.missingRequired.join("、"))}`);
  }
  return lines.join("\n");
}
