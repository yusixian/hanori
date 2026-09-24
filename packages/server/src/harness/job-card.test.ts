import { describe, expect, it } from "vitest";
import { chooseMachine } from "./scheduler.js";
import { formatElapsed, renderJobCard } from "./job-card.js";
import { resolveProjectConfig } from "./config/resolve.js";
import { extractJson, parseMachineList } from "./lody.js";
import { providerForAgent, quotaBlocks, renderFooter, startOfDay } from "./quota.js";
import { readFileSync } from "node:fs";
import type { HarnessJobRecord } from "./work-store.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const machines = parseMachineList(
  extractJson(
    readFileSync(new URL("./__fixtures__/lody-machine-list.txt", import.meta.url), "utf8"),
  ),
  NOW,
);
const APPROVAL = "AbCdEfGhIjKlMnOpQrStUv";

function job(overrides: Partial<HarnessJobRecord> = {}): HarnessJobRecord {
  return {
    id: "j",
    requestId: "r",
    attempt: 1,
    executor: "lody",
    state: "running",
    machineKey: "mbp",
    lodyMachine: "MBP-64G.local",
    provider: "claude",
    role: "worker",
    agent: "Claude Code",
    model: "sonnet",
    sessionId: "sess-1",
    leaseUntil: null,
    sessionStatus: "running",
    modelName: "Sonnet 5",
    contextUsed: 430,
    contextSize: 1000,
    quota: {
      provider: "claude",
      windows: [
        { span: "fiveHour", label: null, usedPercent: 6, expired: false },
        { span: "week", label: null, usedPercent: 52, expired: false },
      ],
    },
    startedAt: new Date(NOW.getTime() - 75 * 60_000),
    lastActivityAt: null,
    nextPollAt: null,
    idleRemindedAt: null,
    runRemindedAt: null,
    endedAt: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const cards = { showDuration: true, showQuota: true, showContext: true };
const request = {
  state: "running",
  title: "保存 <按钮> 无反馈",
  issueNumber: 12,
  repo: "example-owner/koyori",
  stateReason: null,
};

describe("renderJobCard", () => {
  it("shows machine, model, elapsed time, and the quota footer", () => {
    const card = renderJobCard({
      request,
      job: job(),
      machineLabel: "MBP-64G",
      now: NOW,
      cards,
      approvalId: APPROVAL,
      sessionUrl: "https://lody.example/s/{sessionId}",
    });
    expect(card.html.split("\n")).toEqual([
      '<b>🔵 进行中</b> · <a href="https://github.com/example-owner/koyori/issues/12">#12</a> 保存 &lt;按钮&gt; 无反馈',
      "机器 MBP-64G · 模型 Sonnet 5 · 已用 1 小时 15 分钟",
      "上下文 43% · claude 本周 52% · 5 小时 6%",
    ]);
    expect(card.keyboard).toEqual([
      [
        { text: "✖️ 取消", callbackData: `hx:${APPROVAL}:k` },
        { text: "💬 打开会话", url: "https://lody.example/s/sess-1" },
      ],
    ]);
  });

  it("offers start for received requests and hides the footer when disabled", () => {
    const card = renderJobCard({
      request: { ...request, state: "received" },
      job: null,
      machineLabel: null,
      now: NOW,
      cards: { ...cards, showQuota: false },
      approvalId: APPROVAL,
      sessionUrl: null,
    });
    expect(card.html).toContain("⚪ 待开始");
    expect(card.keyboard[0]!.map((b) => b.text)).toEqual(["▶️ 开始", "✖️ 取消"]);
    expect(renderFooter(job(), { showQuota: false, showContext: true })).toBe("上下文 43%");
  });

  it("escapes Lody labels in the footer", () => {
    const card = renderJobCard({
      request,
      job: job({
        quota: {
          provider: "claude",
          windows: [{ span: "week", label: "<b>Opus</b>", usedPercent: 10, expired: false }],
        },
      }),
      machineLabel: "MBP",
      now: NOW,
      cards,
      approvalId: APPROVAL,
      sessionUrl: null,
    });
    expect(card.html).toContain("&lt;b&gt;Opus&lt;/b&gt; 本周 10%");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(59_000)).toBe("0 分钟");
    expect(formatElapsed(2 * 3_600_000)).toBe("2 小时");
  });
});

describe("quota", () => {
  it("maps agent configs to Lody providers", () => {
    expect(providerForAgent("Codex CLI")).toBe("codex");
    expect(providerForAgent("Claude Code")).toBe("claude");
  });

  it("applies model-specific windows only to that model", () => {
    const mbp = machines[0]!;
    const pause = { fiveHour: "95%", week: "51%" };
    expect(quotaBlocks(mbp, "claude", "sonnet", pause).map((b) => b.label)).toEqual([null]);
    expect(quotaBlocks(mbp, "claude", "fable", pause).map((b) => b.label)).toEqual([null, "Fable"]);
    expect(quotaBlocks(mbp, "kimi", null, { fiveHour: "1%", week: "1%" })).toEqual([]);
  });

  it("computes midnight in the configured time zone", () => {
    expect(startOfDay(NOW, "Asia/Shanghai").toISOString()).toBe("2026-09-23T16:00:00.000Z");
  });

  it("skips offline and full machines when choosing", () => {
    const resolved = resolveProjectConfig({
      raw: {
        version: 1,
        telegram: { bot: "b", chatId: -1001, owners: [1] },
        machines: { pc: { lody: "Desktop-7700X" }, mbp: { lody: "MBP-64G" } },
        projects: { koyori: { repo: "a/koyori", machines: ["pc", "mbp"] } },
      },
      projectKey: "koyori",
      policy: null,
      overrides: [],
      now: NOW,
    });
    if (!resolved.ok) throw new Error("config");
    const choice = chooseMachine(resolved.value, machines, new Map());
    expect(choice).toMatchObject({ machineKey: "mbp", provider: "claude", model: "sonnet" });
    expect(chooseMachine(resolved.value, machines, new Map([["mbp", 4]]))).toEqual({
      reason: "Desktop-7700X 不在线",
    });
  });
});
