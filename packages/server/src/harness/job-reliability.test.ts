import { describe, expect, it } from "vitest";
import { CONTINUE_CALLBACK, CONTINUE_TEXT } from "./delivery-watch.js";
import { REQUEST_STATES as S } from "./states.js";
import { TEST_CHAT_ID, TEST_OWNER, TEST_REPO } from "./test-fakes.js";
import { type Ctx, bug, cardOf, harnessRaw, onlyRequest, setup } from "./work-test-helpers.js";

const tick = (ctx: Ctx) => ctx.service.work.scheduler.tick();

async function runningBug(ctx: Ctx) {
  await bug(ctx);
  await tick(ctx);
  return onlyRequest(ctx);
}

/** First idle poll after 20s, then one poll per `poll.idle` (2m). */
async function idlePolls(ctx: Ctx, polls: number) {
  ctx.lody.session = { ...ctx.lody.session, status: "idle" };
  ctx.advance(20_000);
  await tick(ctx);
  for (let index = 1; index < polls; index++) {
    ctx.advance(2 * 60_000);
    await tick(ctx);
  }
}

const notices = (ctx: Ctx) => ctx.telegram.sent.filter((s) => s.message.html.startsWith("⏸"));

describe("session finished without delivering", () => {
  it("flags an idle session without a PR, with the last reply, and lifts the flag on resume", async () => {
    const ctx = await setup();
    const request = await runningBug(ctx);
    ctx.lody.lastAssistant = "I could not reproduce the bug.\n\nThe save button already spins.";
    await idlePolls(ctx, 2);
    expect(onlyRequest(ctx).state).toBe(S.running);
    ctx.advance(2 * 60_000);
    await tick(ctx);

    expect(onlyRequest(ctx)).toMatchObject({
      state: S.needsAttention,
      stateReason: "Lody 会话已停下，但还没有提交 PR",
    });
    expect(notices(ctx)).toHaveLength(1);
    const notice = notices(ctx)[0]!.message;
    expect(notice.replyToMessageId).toBe(request.cardMessageId);
    expect(notice.html).toContain(
      "最后一条回复：「I could not reproduce the bug. The save button already spins.」",
    );
    expect(cardOf(ctx, request.cardMessageId!)!.html).toContain("👀 需要你看一下");
    const event = ctx.store.events.find((e) => e.type === "session.undelivered")!;
    expect(event.payload).toEqual({ gap: "no_pr", excerptLength: 61 });

    ctx.advance(2 * 60_000);
    await tick(ctx);
    expect(notices(ctx)).toHaveLength(1);

    ctx.lody.session = { status: "running" };
    ctx.advance(2 * 60_000);
    await tick(ctx);
    expect(onlyRequest(ctx)).toMatchObject({ state: S.running, stateReason: null });
  });

  it("continues the session from the notice button, once", async () => {
    const ctx = await setup();
    await runningBug(ctx);
    await idlePolls(ctx, 3);
    const notice = notices(ctx)[0]!;
    expect(notice.message.keyboard?.flat().map((b) => b.callbackData)).toContain(CONTINUE_CALLBACK);
    const tap = (userId: number) =>
      ctx.port.handleCallback({
        data: CONTINUE_CALLBACK,
        chatId: TEST_CHAT_ID,
        threadId: 501,
        messageId: notice.messageId,
        userId,
      });

    expect(await tap(7)).toEqual({ text: "无权限" });
    expect(await tap(TEST_OWNER)).toEqual({ text: "已让会话继续" });
    expect(ctx.lody.chats.at(-1)?.prompt).toContain(CONTINUE_TEXT);
    expect(ctx.telegram.keyboardEdits.at(-1)).toMatchObject({
      messageId: notice.messageId,
      keyboard: [],
    });
    expect(ctx.store.events.some((e) => e.type === "button.continue")).toBe(true);

    ctx.lody.session = { status: "running" };
    ctx.advance(2 * 60_000);
    await tick(ctx);
    const chats = ctx.lody.chats.length;
    expect(await tap(TEST_OWNER)).toEqual({ text: "会话已经不在停下状态" });
    expect(ctx.lody.chats).toHaveLength(chats);
  });

  it("does not flag idle polls while the session keeps producing messages", async () => {
    const ctx = await setup();
    await runningBug(ctx);
    await idlePolls(ctx, 1);
    for (let poll = 0; poll < 3; poll++) {
      ctx.advance(2 * 60_000);
      ctx.lody.session = {
        status: "idle",
        lastMessageAt: new Date(ctx.clock.now.getTime() - 60_000),
      };
      await tick(ctx);
    }
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(ctx.lody.historyReads).toEqual([]);
  });

  it("flags a session that stopped with only a draft PR until it is marked ready", async () => {
    const ctx = await setup();
    const request = await runningBug(ctx);
    ctx.github.pr = { ...ctx.github.pr, draft: true, headRef: `harness/${request.id}` };
    const prEvent = (action: string) =>
      ctx.service.prFlow.handleWebhookEvent(
        "pull_request",
        { action, pull_request: { number: 7 }, repository: { full_name: TEST_REPO } },
        "sandbox",
      );
    await prEvent("opened");
    expect(onlyRequest(ctx).state).toBe(S.prReady);
    await idlePolls(ctx, 3);
    expect(onlyRequest(ctx)).toMatchObject({
      state: S.needsAttention,
      stateReason: "Lody 会话已停下，但 PR 仍是草稿",
    });
    expect(ctx.telegram.lastCard()!.html).toContain(
      "需要你看一下：Lody 会话已停下，但 PR 仍是草稿",
    );

    ctx.github.pr = { ...ctx.github.pr, draft: false };
    await prEvent("ready_for_review");
    ctx.advance(2 * 60_000);
    await tick(ctx);
    expect(onlyRequest(ctx)).toMatchObject({ state: S.prReady, stateReason: null });
  });

  it("leaves a delivered PR alone", async () => {
    const ctx = await setup();
    const request = await runningBug(ctx);
    ctx.github.pr = { ...ctx.github.pr, headRef: `harness/${request.id}` };
    await ctx.service.prFlow.handleWebhookEvent(
      "pull_request",
      { action: "opened", pull_request: { number: 7 }, repository: { full_name: TEST_REPO } },
      "sandbox",
    );
    await idlePolls(ctx, 4);
    expect(onlyRequest(ctx).state).toBe(S.prReady);
    expect(notices(ctx)).toEqual([]);
  });
});

describe("queue escalation", () => {
  const bridgeDown = (ctx: Ctx) => {
    ctx.lody.listMachines = (async () => ({
      ok: false,
      reason: "unavailable",
      message: "无法连接 lody-bridge（ECONNREFUSED）",
    })) as never;
  };
  const escalations = (ctx: Ctx) =>
    ctx.telegram.sent.filter(
      (s) => s.message.html.startsWith("⚠️") && s.message.html.includes("排队"),
    );

  it("shows the wait on the card and posts one General notice, even across a restart", async () => {
    const ctx = await setup();
    bridgeDown(ctx);
    await bug(ctx);
    await tick(ctx);
    const request = onlyRequest(ctx);
    expect(request).toMatchObject({
      state: S.queued,
      stateReason: "执行层不可用：无法连接 lody-bridge（ECONNREFUSED）",
    });
    ctx.advance(5 * 60_000);
    await tick(ctx);
    expect(cardOf(ctx, request.cardMessageId!)!.html).toContain("已排队 5 分钟");
    expect(escalations(ctx)).toEqual([]);

    ctx.advance(10 * 60_000);
    await tick(ctx);
    ctx.advance(60_000);
    await tick(ctx);
    expect(escalations(ctx)).toHaveLength(1);
    const notice = escalations(ctx)[0]!.message;
    expect(notice.threadId).toBeUndefined();
    expect(notice.html).toContain("sandbox #41 保存按钮没有反应 已排队 15 分钟");
    expect(notice.html).toContain("执行层不可用");

    const restarted = await setup({ store: ctx.store });
    bridgeDown(restarted);
    restarted.advance(20 * 60_000);
    await tick(restarted);
    expect(escalations(restarted)).toEqual([]);
    expect(cardOf(restarted, request.cardMessageId!)!.html).toContain("已排队 20 分钟");
  });

  it("does not escalate deliberate waits such as area locks", async () => {
    const ctx = await setup();
    await bug(ctx, "first");
    await tick(ctx);
    await bug(ctx, "second");
    ctx.advance(30 * 60_000);
    await tick(ctx);
    await tick(ctx);
    expect(escalations(ctx)).toEqual([]);
  });

  it("can be turned off", async () => {
    const ctx = await setup({
      raw: harnessRaw({ guardrails: { time: { queueEscalateAfter: null } } }),
    });
    bridgeDown(ctx);
    await bug(ctx);
    await tick(ctx);
    ctx.advance(60 * 60_000);
    await tick(ctx);
    expect(escalations(ctx)).toEqual([]);
  });
});
