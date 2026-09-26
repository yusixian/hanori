import type { HarnessInlineButton, HarnessKeyboard } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { encodeCallback } from "./approvals.js";
import type { CardContent } from "./card-publisher.js";
import type { ChangeKind, ReleasePlan } from "./release-plan.js";

export const RELEASE_STATES = {
  planned: "release_planned",
  building: "release_building",
  published: "release_published",
  failed: "release_failed",
  timedOut: "release_timed_out",
  cancelled: "release_cancelled",
} as const;
export type ReleaseState = (typeof RELEASE_STATES)[keyof typeof RELEASE_STATES];

export interface ReleaseRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  url: string;
}

/** What the card shows; persisted as the card message's `ref`. */
export interface ReleaseSnapshot {
  plan: ReleasePlan;
  /** The `/release` argument, reapplied on refresh. */
  arg: string;
  prepAt: string | null;
  taggedAt: string | null;
  /** False once a poll found the Actions API closed to the App. */
  actionsReadable: boolean;
  run: ReleaseRun | null;
  release: { url: string; draft: boolean } | null;
  note: string | null;
}

export interface ReleaseCardInput {
  projectKey: string;
  state: string;
  snapshot: ReleaseSnapshot;
  approvalId: string | null;
  confirming?: boolean;
  maxChanges?: number;
}

const HEADLINES: Record<ReleaseState, string> = {
  release_planned: "🚀 发版计划",
  release_building: "🟡 构建中",
  release_published: "✅ 已发布",
  release_failed: "❌ 构建失败",
  release_timed_out: "⏱ 跟踪超时",
  release_cancelled: "⚫ 已取消",
};

const KIND_LABELS: Record<ChangeKind, string> = {
  breaking: "breaking",
  feat: "feat",
  fix: "fix",
  other: "无 fix/feat",
};

const short = (sha: string) => sha.slice(0, 7);

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function actionsUrl(repo: string): string {
  return `https://github.com/${repo}/actions`;
}

function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

function headline(input: ReleaseCardInput): string {
  const { snapshot, state } = input;
  const base = HEADLINES[state as ReleaseState] ?? state;
  const text =
    state === RELEASE_STATES.published && snapshot.release?.draft
      ? "✅ Release 草稿已生成"
      : state === RELEASE_STATES.published && !snapshot.release
        ? "✅ 构建成功"
        : base;
  return `<b>${text} · ${escapeHtml(input.projectKey)} ${escapeHtml(snapshot.plan.tag)}</b>`;
}

function versionLine(plan: ReleasePlan): string {
  const from = plan.previous ? escapeHtml(plan.previous.tag) : "（无 tag）";
  const reason = plan.bump
    ? `${plan.bump}${plan.highest ? ` · 最高改动 ${KIND_LABELS[plan.highest]}` : ""}`
    : "指定版本";
  return `版本：${from} → <b>${escapeHtml(plan.tag)}</b>（${reason}）`;
}

function changeLines(plan: ReleasePlan, max: number): string[] {
  if (plan.commitCount === 0) return ["⚠️ 上次发版后没有新提交"];
  const numbered = plan.changes.filter((change) => change.number !== null).length;
  const lines = [`<b>改动</b>（${numbered} 个 PR · ${plan.commitCount} 个提交）`];
  const shown = plan.changes.slice(0, max);
  for (const change of shown) {
    const ref = change.number
      ? `<a href="https://github.com/${escapeHtml(plan.repo)}/pull/${change.number}">#${change.number}</a> `
      : "";
    lines.push(`• ${ref}${escapeHtml(clip(change.title, 90))}`);
  }
  if (plan.changes.length > shown.length) {
    lines.push(`…另有 ${plan.changes.length - shown.length} 项`);
  }
  return lines;
}

function workflowLine(plan: ReleasePlan): string {
  if (plan.workflows.length === 0) {
    return "⚠️ 未发现由 tag 触发的 workflow，打 tag 后不会自动构建";
  }
  const described = plan.workflows.map(
    (workflow) => `${workflow.file}（push tags: ${workflow.patterns.join(", ")}）`,
  );
  return `发版 workflow：${escapeHtml(described.join("、"))}`;
}

function releaseKitLine(plan: ReleasePlan): string | null {
  const kit = plan.releaseKit;
  if (!kit) return null;
  const parts = ["release-kit：已配置"];
  if (kit.pendingChanges !== null) parts.push(`待发布片段 ${kit.pendingChanges} 条`);
  if (kit.breakingPre1) parts.push(`0.x breaking → ${kit.breakingPre1}`);
  return parts.join(" · ");
}

function trackingLines(input: ReleaseCardInput): string[] {
  const { snapshot } = input;
  const { plan } = snapshot;
  const lines: string[] = [];
  if (snapshot.run) {
    const status = snapshot.run.conclusion ?? snapshot.run.status;
    lines.push(
      `构建：<a href="${escapeHtml(snapshot.run.url)}">${escapeHtml(snapshot.run.name ?? "workflow")}</a> · ${escapeHtml(status)}`,
    );
  } else if (!snapshot.actionsReadable) {
    lines.push(
      `构建：GitHub App 无 Actions 读权限，请在 <a href="${actionsUrl(escapeHtml(plan.repo))}">Actions</a> 查看；这里只等待 Release`,
    );
  } else if (input.state === RELEASE_STATES.building) {
    lines.push("构建：等待 workflow 启动");
  }
  if (snapshot.release) {
    lines.push(
      `Release：<a href="${escapeHtml(snapshot.release.url)}">${escapeHtml(plan.tag)}</a>${snapshot.release.draft ? "（草稿）" : ""}`,
    );
  }
  return lines;
}

export function renderReleaseCard(input: ReleaseCardInput): CardContent {
  const { snapshot, state } = input;
  const { plan } = snapshot;
  const planned = state === RELEASE_STATES.planned;
  const lines = [headline(input)];
  lines.push(
    `<a href="https://github.com/${escapeHtml(plan.repo)}">${escapeHtml(plan.repo)}</a> · ${escapeHtml(plan.defaultBranch)} @<a href="${commitUrl(escapeHtml(plan.repo), plan.targetSha)}">${short(plan.targetSha)}</a>`,
  );
  lines.push(versionLine(plan));
  if (plan.previous) {
    lines.push(
      `上个 tag：${escapeHtml(plan.previous.tag)} @${short(plan.previous.sha)}${plan.previous.hasRelease ? " · 已有 GitHub Release" : " · 没有 GitHub Release"}`,
    );
  }
  if (input.confirming && planned) {
    lines.push(
      "",
      "<b>确认打 tag？</b>",
      `仓库：${escapeHtml(plan.repo)}`,
      `Tag：<code>${escapeHtml(plan.tag)}</code>（annotated）`,
      `提交：<code>${plan.targetSha}</code>`,
      plan.workflows.length > 0
        ? `会触发 ${escapeHtml(plan.workflows.map((workflow) => workflow.file).join("、"))}。tag 创建后不会被删除或移动。`
        : "没有 workflow 会被触发。tag 创建后不会被删除或移动。",
    );
  } else {
    lines.push(`Tag：<code>${escapeHtml(plan.tag)}</code> → <code>${short(plan.targetSha)}</code>`);
    if (planned) lines.push(...changeLines(plan, input.maxChanges ?? 15));
    lines.push(workflowLine(plan));
    const kit = releaseKitLine(plan);
    if (kit && planned) lines.push(escapeHtml(kit));
    if (!planned) lines.push(...trackingLines(input));
    if (planned && snapshot.prepAt)
      lines.push("📝 已派发准备任务：合并发版 PR 后点「刷新」再确认发布");
  }
  if (snapshot.note) lines.push(`⚠️ ${escapeHtml(clip(snapshot.note, 200))}`);
  return { html: lines.join("\n"), keyboard: renderKeyboard(input), imageUrl: null };
}

function renderKeyboard(input: ReleaseCardInput): HarnessKeyboard {
  const { snapshot, state, approvalId } = input;
  const { plan } = snapshot;
  const links: HarnessInlineButton[] = [];
  if (snapshot.release) links.push({ text: "🔗 Release", url: snapshot.release.url });
  if (snapshot.run) links.push({ text: "🔗 构建", url: snapshot.run.url });
  else if (state !== RELEASE_STATES.planned && state !== RELEASE_STATES.cancelled) {
    links.push({ text: "🔗 Actions", url: actionsUrl(plan.repo) });
  }
  if (!approvalId || state === RELEASE_STATES.cancelled) return links.length > 0 ? [links] : [];
  const button = (text: string, verb: Parameters<typeof encodeCallback>[1]) => ({
    text,
    callbackData: encodeCallback(approvalId, verb),
  });
  if (state !== RELEASE_STATES.planned) {
    return state === RELEASE_STATES.published && snapshot.release && !snapshot.release.draft
      ? [links]
      : [[...links, button("🔄 刷新", "refresh")]];
  }
  if (input.confirming) {
    return [[button("✅ 确认打 tag", "confirm"), button("返回", "back")]];
  }
  const actions =
    plan.commitCount > 0 ? [[button("📝 准备发版", "start"), button("🏷 确认发布", "merge")]] : [];
  return [...actions, [button("🔄 刷新", "refresh"), button("✖️ 取消", "cancel")]];
}
