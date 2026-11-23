import { describe, expect, it } from "vitest";
import { chooseMachine } from "./scheduler.js";
import { formatElapsed, queueAge, renderJobCard } from "./job-card.js";
import { resolveProjectConfig } from "./config/resolve.js";
import { extractJson, parseMachineList } from "./lody.js";
import { providerForAgent, quotaBlocks, renderFooter, startOfDay } from "./quota.js";
import { vendorOf } from "./config/execution.js";
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
    lodyMachine: "Mac-Runner.local",
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
      machineLabel: "Mac-Runner",
      now: NOW,
      cards,
      approvalId: APPROVAL,
      sessionUrl: "https://lody.example/s/{sessionId}",
    });
    expect(card.html.split("\n")).toEqual([
      '<b>🔵 进行中</b> · <a href="https://github.com/example-owner/koyori/issues/12">#12</a> 保存 &lt;按钮&gt; 无反馈',
      "机器 Mac-Runner · 模型 Sonnet 5 · 已用 1 小时 15 分钟",
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

  it("shows a coarse queued-for time on queued cards only", () => {
    expect(queueAge(30_000)).toBeNull();
    expect(queueAge(3 * 60_000 + 5_000)).toBe("已排队 3 分钟");
    expect(queueAge(17 * 60_000)).toBe("已排队 15 分钟");
    expect(queueAge(100 * 60_000)).toBe("已排队 1 小时 30 分钟");
    const input = {
      job: null,
      machineLabel: null,
      now: NOW,
      cards,
      approvalId: APPROVAL,
      sessionUrl: null,
      queuedSince: new Date(NOW.getTime() - 20 * 60_000),
    };
    const queued = renderJobCard({
      ...input,
      request: { ...request, state: "queued", stateReason: "Mac-Runner 不在线" },
    });
    expect(queued.html).toContain("Mac-Runner 不在线\n已排队 20 分钟");
    expect(renderJobCard({ ...input, request }).html).not.toContain("已排队");
  });
});

describe("quota", () => {
  it("maps agent configs to Lody providers", () => {
    expect(providerForAgent("Codex CLI")).toBe("codex");
    expect(providerForAgent("Claude Code")).toBe("claude");
    const agents = [
      {
        id: "3f0c9a4e-0000-4000-8000-000000000001",
        name: "Work",
        agentType: "codex",
        machineId: null,
      },
    ];
    expect(vendorOf("3f0c9a4e-0000-4000-8000-000000000001", null, agents)).toBe("codex");
    expect(vendorOf("Work", "opus[1m]", agents)).toBe("codex");
    expect(vendorOf("3f0c9a4e-0000-4000-8000-000000000002", "gpt-6-sol")).toBe("codex");
    expect(vendorOf("3f0c9a4e-0000-4000-8000-000000000002", "o4-mini")).toBe("codex");
    expect(vendorOf("some-id", "opus[1m]")).toBe("claude");
    expect(vendorOf("Kimi K3", null)).toBe("kimi");
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
        machines: { pc: { lody: "Offline-Runner" }, mbp: { lody: "Mac-Runner" } },
        projects: { koyori: { repo: "a/koyori", machines: ["pc", "mbp"] } },
      },
      projectKey: "koyori",
      policy: null,
      overrides: [],
      now: NOW,
    });
    if (!resolved.ok) throw new Error("config");
    const choice = chooseMachine(resolved.value, machines, new Map());
    expect(choice).toMatchObject({
      machineKey: "mbp",
      provider: "codex",
      agent: "Codex",
      model: "gpt-6-sol",
      effort: "high",
    });
    expect(chooseMachine(resolved.value, machines, new Map([["mbp", 4]]))).toEqual({
      reason: "Offline-Runner 不在线",
      offline: false,
    });
    const offlineOnly = {
      ...resolved.value,
      project: { ...resolved.value.project, machines: ["pc"] },
    };
    expect(chooseMachine(offlineOnly, machines, new Map())).toEqual({
      reason: "Offline-Runner 不在线",
      offline: true,
    });
  });

  it("drops an effort the quota fallback model does not offer", () => {
    const resolved = resolveProjectConfig({
      raw: {
        version: 1,
        telegram: { bot: "b", chatId: -1001, owners: [1] },
        machines: { mbp: { lody: "Mac-Runner" } },
        roles: { worker: { agent: "Codex", model: "gpt-6-sol", effort: "ultra" } },
        guardrails: { quota: { pauseAt: { week: "30%" }, fallback: { worker: "gpt-5.5" } } },
        projects: { koyori: { repo: "a/koyori", machines: ["mbp"] } },
      },
      projectKey: "koyori",
      policy: null,
      overrides: [],
      now: NOW,
    });
    if (!resolved.ok) throw new Error("config");
    expect(chooseMachine(resolved.value, machines, new Map())).toMatchObject({
      model: "gpt-5.5",
      effort: null,
    });
  });
});
