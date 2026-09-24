import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback } from "./approvals.js";
import { MemoryHarnessStore } from "./memory-store.js";
import {
  FakeGitHub,
  TEST_CHAT_ID,
  TEST_OWNER,
  TEST_REPO,
  createTestService,
  testConfigRaw,
} from "./test-fakes.js";

type Context = Awaited<ReturnType<typeof createTestService>>;

async function prEvent(ctx: Context, action: string, extra: Record<string, unknown> = {}) {
  await ctx.service.prFlow.handleWebhookEvent(
    "pull_request",
    { action, pull_request: { number: 7 }, repository: { full_name: TEST_REPO }, ...extra },
    "sandbox",
  );
}

function press(ctx: Context, data: string | undefined, overrides: Record<string, number> = {}) {
  if (!data) throw new Error("button not found");
  return ctx.port.handleCallback({
    data,
    chatId: TEST_CHAT_ID,
    threadId: 501,
    messageId: ctx.telegram.sent[0]!.messageId,
    userId: TEST_OWNER,
    ...overrides,
  });
}

function approvalIdOf(ctx: Context): string {
  const data = ctx.telegram.callbackData("🔍");
  return decodeCallback(data!)!.approvalId;
}

describe("PR card", () => {
  it("posts one card into the project topic created on first apply", async () => {
    const ctx = await createTestService();
    expect(ctx.telegram.topics).toEqual(["sandbox"]);
    await prEvent(ctx, "opened");
    expect(ctx.telegram.sent).toHaveLength(1);
    const card = ctx.telegram.sent[0]!.message;
    expect(card.threadId).toBe(501);
    expect(card.html).toContain("🟢 可以合并 · PR #7 · T0");
    expect(card.html).toContain("改了什么：摘要：fix(settings): show saving state");
    expect(card.keyboard!.flat().map((b) => b.text)).toEqual([
      "✅ 合并",
      "🔍 详情",
      "🔗 PR",
      "🔄 刷新",
    ]);

    await prEvent(ctx, "edited", { changes: { body: { from: "" } } });
    expect(ctx.telegram.sent).toHaveLength(1);
  });

  it("does not recreate topics after a restart", async () => {
    const store = new MemoryHarnessStore();
    await createTestService({ store });
    const second = await createTestService({ store });
    expect(second.telegram.topics).toEqual([]);
    expect(second.service.projectThread("sandbox")).toBe(501);
  });

  it("drops the summary line when the AI summary is unavailable", async () => {
    const ctx = await createTestService({
      summarizer: async () => {
        throw new Error("provider down");
      },
    });
    await prEvent(ctx, "opened");
    const html = ctx.telegram.sent[0]!.message.html;
    expect(html).not.toContain("改了什么");
    expect(html.split("\n")[1]).toBe("fix(settings): show saving state");
  });

  it("uses the first PR body image as the card photo", async () => {
    const github = new FakeGitHub();
    github.pr.body = "## 验证\n![shot](https://example.com/s.png)\n## 审查";
    const ctx = await createTestService({ github });
    await prEvent(ctx, "opened");
    expect(ctx.telegram.sent[0]!.message.photoUrl).toBe("https://example.com/s.png");
  });
});

describe("merge", () => {
  it("re-checks the head SHA and checks, squash merges once, and removes buttons", async () => {
    const ctx = await createTestService();
    await prEvent(ctx, "opened");
    const merge = ctx.telegram.callbackData("✅ 合并");
    expect(await press(ctx, merge)).toEqual({ text: "已合并" });
    expect(ctx.github.merges).toEqual([{ number: 7, sha: "a".repeat(40), method: "squash" }]);
    expect(ctx.github.deletedBranches).toEqual(["harness/fix-7"]);
    expect(ctx.telegram.lastCard()!.html).toContain("🟣 已合并");
    expect(
      ctx.telegram
        .lastCard()!
        .keyboard!.flat()
        .map((b) => b.text),
    ).toEqual(["🔗 PR"]);
    expect(await press(ctx, merge)).toEqual({ text: "该操作已处理" });
    expect(ctx.github.merges).toHaveLength(1);
    const types = ctx.store.events.map((event) => event.type);
    expect(types).toContain("merge.succeeded");
    expect(types.filter((type) => type === "button.merge")).toHaveLength(2);
  });

  it("invalidates old buttons when a new push arrives", async () => {
    const ctx = await createTestService();
    await prEvent(ctx, "opened");
    const oldMerge = ctx.telegram.callbackData("✅ 合并");
    ctx.github.pr.headSha = "d".repeat(40);
    await prEvent(ctx, "synchronize");
    const newMerge = ctx.telegram.callbackData("✅ 合并");
    expect(newMerge).not.toBe(oldMerge);
    expect(ctx.telegram.edits.length).toBeGreaterThan(0);
    expect(await press(ctx, oldMerge)).toEqual({ text: "PR 已更新，旧按钮已失效" });
    expect(ctx.github.merges).toHaveLength(0);
    expect(await press(ctx, newMerge)).toEqual({ text: "已合并" });
    expect(ctx.github.merges[0]!.sha).toBe("d".repeat(40));
  });

  it("refuses when the PR moved after the card was rendered", async () => {
    const ctx = await createTestService();
    await prEvent(ctx, "opened");
    ctx.github.pr.headSha = "e".repeat(40);
    const answer = await press(ctx, ctx.telegram.callbackData("✅ 合并"));
    expect(answer).toEqual({ text: "PR 有新提交，请看刷新后的卡片", alert: true });
    expect(ctx.github.merges).toHaveLength(0);
  });

  it("never offers or performs a merge for T3 paths", async () => {
    const github = new FakeGitHub();
    github.files = [{ filename: ".github/workflows/ci.yml", status: "modified" }];
    const ctx = await createTestService({ github });
    await prEvent(ctx, "opened");
    const labels = ctx.telegram
      .lastCard()!
      .keyboard!.flat()
      .map((b) => b.text);
    expect(labels).not.toContain("✅ 合并");
    expect(labels).toContain("🔗 在 GitHub 合并");
    const forged = encodeCallback(approvalIdOf(ctx), "merge");
    expect(await press(ctx, forged)).toEqual({
      text: "T3 改动只能在 GitHub 网页上合并",
      alert: true,
    });
    expect(ctx.github.merges).toHaveLength(0);
  });

  it("confirms T2 merges on the card itself with the details expanded", async () => {
    const github = new FakeGitHub();
    github.files = [{ filename: "src/logic.ts", status: "modified" }];
    const ctx = await createTestService({ github });
    await prEvent(ctx, "opened");
    expect(ctx.telegram.lastCard()!.html).toContain("🟢 可以合并 · PR #7 · T2");
    const forged = encodeCallback(approvalIdOf(ctx), "confirm");
    expect(await press(ctx, forged)).toEqual({ text: "T2 改动需要先查看详情", alert: true });

    expect(await press(ctx, ctx.telegram.callbackData("✅ 合并"))).toEqual({ text: "请确认合并" });
    expect(ctx.github.merges).toHaveLength(0);
    expect(ctx.telegram.sent).toHaveLength(1);
    expect(ctx.telegram.lastCard()!.html).toContain("T2 <code>src/logic.ts</code>");
    expect(await press(ctx, ctx.telegram.callbackData("✅ 确认合并"))).toEqual({ text: "已合并" });
  });

  it("expands and collapses details in place and then merges T2 in one tap", async () => {
    const github = new FakeGitHub();
    github.files = [{ filename: "src/logic.ts", status: "modified" }];
    const ctx = await createTestService({ github });
    await prEvent(ctx, "opened");
    expect(await press(ctx, ctx.telegram.callbackData("🔍"))).toEqual({ text: "已展开详情" });
    expect(ctx.telegram.sent).toHaveLength(1);
    expect(ctx.telegram.lastCard()!.html).toContain("<b>文件（1）</b>");
    expect(await press(ctx, ctx.telegram.callbackData("🔼 收起"))).toEqual({ text: "已收起" });
    expect(ctx.telegram.lastCard()!.html).not.toContain("<b>文件");
    expect(await press(ctx, ctx.telegram.callbackData("✅ 合并"))).toEqual({ text: "已合并" });
  });

  it("hides merge while CI is pending and refreshes on check completion", async () => {
    const github = new FakeGitHub();
    github.runs = [{ id: 1, name: "ci", status: "in_progress", conclusion: null }];
    const ctx = await createTestService({ github });
    await prEvent(ctx, "opened");
    expect(ctx.telegram.lastCard()!.html).toContain("🟡 等待 CI");
    expect(ctx.telegram.callbackData("✅ 合并")).toBeUndefined();
    github.runs = [{ id: 1, name: "ci", status: "completed", conclusion: "success" }];
    await ctx.service.prFlow.handleWebhookEvent(
      "check_run",
      {
        action: "completed",
        check_run: { head_sha: github.pr.headSha, pull_requests: [{ number: 7 }] },
        repository: { full_name: TEST_REPO },
      },
      "sandbox",
    );
    expect(ctx.telegram.lastCard()!.html).toContain("🟢 可以合并");
  });

  it("expires buttons after the approval TTL and refreshes the card", async () => {
    let now = new Date("2026-09-24T12:00:00Z");
    const ctx = await createTestService({ now: () => now });
    await prEvent(ctx, "opened");
    const merge = ctx.telegram.callbackData("✅ 合并");
    now = new Date("2026-10-02T12:00:00Z");
    expect(await press(ctx, merge)).toEqual({ text: "按钮已过期，卡片已刷新" });
    expect(ctx.telegram.callbackData("✅ 合并")).not.toBe(merge);
    expect(ctx.github.merges).toHaveLength(0);
  });

  it("keeps buttons valid across a restart", async () => {
    const store = new MemoryHarnessStore();
    const github = new FakeGitHub();
    const first = await createTestService({ store, github });
    await prEvent(first, "opened");
    const merge = first.telegram.callbackData("✅ 合并")!;
    const restarted = await createTestService({ store, github });
    const answer = await restarted.port.handleCallback({
      data: merge,
      chatId: TEST_CHAT_ID,
      threadId: 501,
      messageId: first.telegram.sent[0]!.messageId,
      userId: TEST_OWNER,
    });
    expect(answer).toEqual({ text: "已合并" });
    expect(github.merges).toHaveLength(1);
  });

  it("asks for a second confirmation when mergeConfirm is twice", async () => {
    const ctx = await createTestService({
      raw: testConfigRaw({ approvals: { mergeConfirm: "twice" } }),
    });
    await prEvent(ctx, "opened");
    expect(await press(ctx, ctx.telegram.callbackData("✅ 合并"))).toEqual({
      text: "请确认合并",
    });
    expect(ctx.github.merges).toHaveLength(0);
    expect(await press(ctx, ctx.telegram.callbackData("✅ 确认合并"))).toEqual({ text: "已合并" });
  });

  it("rejects callbacks from other users, chats, or messages", async () => {
    const ctx = await createTestService();
    await prEvent(ctx, "opened");
    const merge = ctx.telegram.callbackData("✅ 合并");
    expect(await press(ctx, merge, { userId: 999 })).toEqual({ text: "无权限" });
    expect(await press(ctx, merge, { chatId: -100999 })).toEqual({ text: "无权限" });
    expect(await press(ctx, merge, { messageId: 1 })).toEqual({ text: "按钮已失效" });
    expect(await press(ctx, "hx:garbage")).toEqual({ text: "按钮已失效" });
    expect(ctx.github.merges).toHaveLength(0);
  });
});
