import { describe, expect, it } from "vitest";
import { decodeCallback } from "./approvals.js";
import { MemoryHarnessStore } from "./memory-store.js";
import { sessionTitle } from "./scheduler.js";
import { REQUEST_STATES as S } from "./states.js";
import { TEST_CHAT_ID, TEST_OWNER } from "./test-fakes.js";
import { START, bug, harnessRaw, onlyRequest, setup } from "./work-test-helpers.js";

describe("restarts", () => {
  it("marks an unknown create outcome lost and never retries it on its own", async () => {
    const ctx = await setup();
    ctx.lody.createResult = { ok: false, reason: "unknown", message: "lody CLI 超时或被中断" };
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    await ctx.service.work.scheduler.tick();
    expect(ctx.lody.created).toHaveLength(1);
    expect([...ctx.store.jobs.values()].map((j) => j.state)).toEqual(["lost"]);
    const request = onlyRequest(ctx);
    expect(request.state).toBe(S.needsAttention);
    expect(request.stateReason).toContain("会话创建结果未知（lody CLI 超时或被中断）");

    const requeue = ctx.telegram
      .lastCard()!
      .keyboard!.flat()
      .find((b) => b.text.includes("重新排队"))!;
    ctx.lody.createResult = null;
    const answer = await ctx.port.handleCallback({
      data: requeue.callbackData!,
      chatId: TEST_CHAT_ID,
      threadId: 501,
      messageId: request.cardMessageId!,
      userId: TEST_OWNER,
    });
    expect(answer).toEqual({ text: "已加入队列" });
    await ctx.service.work.scheduler.tick();
    expect(ctx.lody.created).toHaveLength(2);
    expect(onlyRequest(ctx).state).toBe(S.running);
  });

  it("treats a thrown create as unknown too", async () => {
    const ctx = await setup();
    ctx.lody.onCreate = () => {
      throw new Error("server crashed mid-create");
    };
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.needsAttention);
    expect([...ctx.store.jobs.values()][0]!.state).toBe("lost");
  });

  it("retries only definite create failures", async () => {
    const ctx = await setup();
    ctx.lody.createResult = { ok: false, reason: "failed", message: "machine offline" };
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    expect(
      ctx.store.events.filter((e) => e.type === "session.create_failed").length,
    ).toBeGreaterThan(0);
    await ctx.service.work.scheduler.tick();
    await ctx.service.work.scheduler.tick();
    await ctx.service.work.scheduler.tick();
    expect(ctx.lody.created).toHaveLength(3);
    expect(onlyRequest(ctx)).toMatchObject({ state: S.needsAttention });
    expect(onlyRequest(ctx).stateReason).toContain("会话创建连续失败 3 次");
  });

  it("recovers a crash that left a starting job behind, without starting another", async () => {
    const store = new MemoryHarnessStore();
    const first = await setup({ store });
    await bug(first);
    await first.service.work.scheduler.tick();
    const job = [...store.jobs.values()][0]!;
    await store.updateJob(job.id, {
      state: "starting",
      sessionId: null,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const request = [...store.requests.values()][0]!;
    await store.transitionRequest(request.id, [request.state], S.starting);
    const second = await setup({ store });
    await second.service.work.scheduler.tick();
    expect([...store.requests.values()][0]!.state).toBe(S.starting);
    second.advance(2 * 60_000);
    await second.service.work.scheduler.tick();
    expect([...store.requests.values()][0]).toMatchObject({ state: S.needsAttention });
    expect(second.lody.created).toHaveLength(0);
    const card = second.telegram.lastCard()!;
    const requeue = card.keyboard!.flat().find((b) => b.text.includes("重新排队"))!;
    expect(decodeCallback(requeue.callbackData!)?.verb).toBe("start");
  });

  it("repairs a request stuck in starting without a job", async () => {
    const ctx = await setup({
      raw: harnessRaw({ guardrails: { autonomy: { bugStartsImmediately: false } } }),
    });
    await bug(ctx);
    expect(await ctx.store.transitionRequest(onlyRequest(ctx).id, [S.received], S.starting)).toBe(
      true,
    );
    await ctx.service.work.scheduler.tick();
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx)).toMatchObject({
      state: S.needsAttention,
      stateReason: "启动中断，未创建会话记录，可以重新排队",
    });
  });

  it("offers a new attempt when the session was archived elsewhere", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    ctx.lody.session = { archived: true };
    ctx.advance(60_000);
    await ctx.service.work.scheduler.tick();
    const request = onlyRequest(ctx);
    expect(request.state).toBe(S.needsAttention);
    const reply = await ctx.port.handleReply({
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: 400,
      replyToMessageId: request.cardMessageId!,
      text: "再看看",
    });
    expect(reply).toEqual({ html: "" });
    expect(ctx.lody.chats).toHaveLength(0);
    const offer = ctx.telegram.sent.at(-1)!;
    expect(offer.message.html).toContain("会话已经结束");
    ctx.lody.session = {};
    const answer = await ctx.port.handleCallback({
      data: offer.message.keyboard![0]![0]!.callbackData!,
      chatId: TEST_CHAT_ID,
      threadId: 501,
      messageId: offer.messageId,
      userId: TEST_OWNER,
    });
    expect(answer).toEqual({ text: "已加入队列" });
    await ctx.service.work.scheduler.tick();
    expect(ctx.lody.created).toHaveLength(2);
    expect([...ctx.store.jobs.values()].map((j) => j.attempt)).toEqual([1, 2]);
  });

  it("sanitizes the Lody session title", () => {
    expect(sessionTitle("koyori", { issueNumber: 3, title: "a\nb\u0007  c" })).toBe(
      "koyori #3 a b c",
    );
    expect(sessionTitle("k", { issueNumber: 1, title: "x".repeat(300) })).toHaveLength(100);
  });

  it("keeps polling the session after a restart", async () => {
    const store = new MemoryHarnessStore();
    const first = await setup({ store });
    await bug(first);
    await first.service.work.scheduler.tick();
    const second = await setup({ store });
    second.advance(30 * 60_000);
    await second.service.work.scheduler.tick();
    expect(second.lody.created).toHaveLength(0);
    expect(second.telegram.edits.at(-1)?.message.html).toContain("已用 30 分钟");
  });
});
