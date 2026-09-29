import type { HarnessCommandName } from "@cos-tool-bot/bot";
import { describe, expect, it } from "vitest";
import { decodeCallback } from "./approvals.js";
import { REQUEST_STATES as S } from "./states.js";
import { TEST_CHAT_ID, TEST_OWNER, TEST_REPO } from "./test-fakes.js";
import { type Ctx, bug, cardOf, harnessRaw, onlyRequest, setup } from "./work-test-helpers.js";

/** `threadId: null` runs the command in General. */
function run(ctx: Ctx, command: HarnessCommandName, args = "", threadId: number | null = 501) {
  return ctx.port.handleCommand({
    command,
    args,
    chatId: TEST_CHAT_ID,
    threadId: threadId ?? undefined,
    userId: TEST_OWNER,
    messageId: 30,
  });
}

function press(ctx: Ctx, data: string, messageId: number, userId = TEST_OWNER) {
  return ctx.port.handleCallback({ data, chatId: TEST_CHAT_ID, threadId: 501, messageId, userId });
}

function requests(ctx: Ctx) {
  return [...ctx.store.requests.values()].sort((a, b) => a.issueNumber! - b.issueNumber!);
}

async function openHarnessPr(ctx: Ctx, requestId: string) {
  ctx.github.pr = {
    ...ctx.github.pr,
    headRef: `harness/${requestId}`,
    body: "Fixes #41\n## Verification\nok\n## Review\nok",
  };
  await ctx.service.prFlow.handleWebhookEvent(
    "pull_request",
    { action: "opened", pull_request: { number: 7 }, repository: { full_name: TEST_REPO } },
    "sandbox",
  );
}

function buttons(ctx: Ctx, messageId: number) {
  return cardOf(ctx, messageId)!.keyboard!.flat();
}

describe("/list", () => {
  it("lists in-flight requests with state, links, age, machine, and id", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    const request = onlyRequest(ctx);
    ctx.store.requests.set(request.id, { ...request, createdAt: ctx.clock.now });
    ctx.advance(5 * 60_000);
    const reply = await run(ctx, "list");
    expect(reply.html).toContain("<b>进行中的请求（1）</b>");
    expect(reply.html).toContain("🔵 进行中");
    expect(reply.html).toContain(`href="https://github.com/${TEST_REPO}/issues/41">#41</a>`);
    expect(reply.html).toContain("5 分钟前 · MBP-64G");
    expect(reply.html).toContain(`<code>${request.id.slice(0, 8)}</code>`);

    const general = await run(ctx, "list", "", null);
    expect(general.html).toContain('<b><a href="https://t.me/c/1234567890/501">sandbox</a></b>');
  });

  it("says so when nothing is in flight and refuses non-owners", async () => {
    const ctx = await setup();
    expect((await run(ctx, "list")).html).toBe("当前没有进行中的请求。");
    const denied = await ctx.port.handleCommand({
      command: "list",
      args: "",
      chatId: TEST_CHAT_ID,
      userId: 7,
      messageId: 1,
    });
    expect(denied.html).toBe("无权限");
  });
});

describe("/cancel", () => {
  it("cancels the only request in the topic through the shared cancel path", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    const reply = await run(ctx, "cancel");
    expect(reply.html).toBe("⚫ 已取消 #41 保存按钮没有反应");
    const request = onlyRequest(ctx);
    expect(request).toMatchObject({ state: S.cancelled, stateReason: "owner 已取消（/cancel）" });
    expect(ctx.lody.cancelled).toEqual(["sess-1"]);
    expect(cardOf(ctx, request.cardMessageId!)!.html).toContain("⚫ 已取消");
    const types = ctx.store.events.map((event) => event.type);
    expect(types).toContain("request.cancelled");
    expect(ctx.store.events.find((e) => e.type === "command.cancel")).toMatchObject({
      requestId: request.id,
      actorId: TEST_OWNER,
      payload: { target: null, matches: 1, outcome: "cancelled" },
    });
  });

  it("offers a picker for several requests and acts through the button path", async () => {
    const ctx = await setup();
    await bug(ctx, "第一个问题");
    await bug(ctx, "第二个问题");
    expect(await run(ctx, "cancel")).toEqual({ html: "" });
    const picker = ctx.telegram.sent.at(-1)!;
    expect(picker.message.html).toBe("选择要取消的请求：");
    expect(picker.message.replyToMessageId).toBe(30);
    const choices = picker.message.keyboard!.flat();
    expect(choices.map((b) => b.text)).toEqual(["✖️ #41 第一个问题", "✖️ #42 第二个问题"]);
    for (const choice of choices) {
      expect(choice.callbackData!.length).toBeLessThanOrEqual(64);
      expect(decodeCallback(choice.callbackData!)?.verb).toBe("abort");
    }

    const [first] = requests(ctx);
    expect(await press(ctx, choices[1]!.callbackData!, first!.cardMessageId!)).toEqual({
      text: "按钮已失效",
    });
    expect(await press(ctx, choices[1]!.callbackData!, picker.messageId)).toEqual({
      text: "已取消",
    });
    expect(requests(ctx).map((r) => r.state === S.cancelled)).toEqual([false, true]);
    expect(ctx.telegram.edits.at(-1)).toMatchObject({
      messageId: picker.messageId,
      message: { html: "⚫ 已取消：#42 第二个问题", keyboard: [] },
    });
    expect(await press(ctx, choices[1]!.callbackData!, picker.messageId)).toEqual({
      text: "该操作已处理",
    });
    const reply = await ctx.port.handleReply({
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: 401,
      replyToMessageId: picker.messageId,
      text: "随便说",
    });
    expect(reply).toEqual({ html: "这条消息只用于选择请求，回复不会发送。" });
    expect(ctx.lody.chats).toEqual([]);
  });

  it("always asks in General unless the request is named", async () => {
    const ctx = await setup();
    await bug(ctx);
    expect(await run(ctx, "cancel", "", null)).toEqual({ html: "" });
    expect(
      ctx.telegram.sent
        .at(-1)!
        .message.keyboard!.flat()
        .map((b) => b.text),
    ).toEqual(["✖️ #41 保存按钮没有反应"]);
    expect(onlyRequest(ctx).state).not.toBe(S.cancelled);
  });

  it("matches #issue and id prefixes, and reports misses", async () => {
    const ctx = await setup();
    await bug(ctx, "第一个问题");
    await bug(ctx, "第二个问题");
    expect((await run(ctx, "cancel", "#42")).html).toBe("⚫ 已取消 #42 第二个问题");
    const [first] = requests(ctx);
    expect((await run(ctx, "cancel", first!.id.slice(0, 8), null)).html).toBe(
      "⚫ 已取消 #41 第一个问题",
    );
    expect((await run(ctx, "cancel", "#99")).html).toBe(
      "没有找到匹配 <code>#99</code> 的进行中请求。",
    );
    expect((await run(ctx, "cancel")).html).toBe("没有可以取消的请求。");
  });

  it("reads an all-digit short id as an id, and a shorter bare number as an issue", async () => {
    const ctx = await setup();
    for (const [id, issueNumber] of [
      ["12345678-0000-4000-8000-000000000000", 41],
      ["abcdef01-0000-4000-8000-000000000000", 42],
    ] as const) {
      await ctx.store.insertRequest({
        id,
        projectKey: "sandbox",
        type: "bug",
        state: S.received,
        repo: TEST_REPO,
        issueNumber,
        title: "问题",
      });
    }
    expect((await run(ctx, "cancel", "12345678", null)).html).toBe("⚫ 已取消 #41 问题");
    expect((await run(ctx, "cancel", "42")).html).toBe("⚫ 已取消 #42 问题");
  });
});

describe("/retry", () => {
  it("requeues a request whose session was lost", async () => {
    const ctx = await setup();
    ctx.lody.createResult = { ok: false, reason: "unknown", message: "lody CLI 超时或被中断" };
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.needsAttention);

    ctx.lody.createResult = null;
    expect((await run(ctx, "retry")).html).toBe("🔁 已重新排队 #41 保存按钮没有反应");
    expect(onlyRequest(ctx)).toMatchObject({ state: S.queued, stateReason: null });
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(ctx.lody.created).toHaveLength(2);
    expect(ctx.store.events.find((e) => e.type === "command.retry")?.payload).toMatchObject({
      outcome: "requeued",
    });
  });

  it("does not requeue running work", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    expect((await run(ctx, "retry")).html).toBe("没有需要重新排队的请求。");
    expect((await run(ctx, "retry", "#41")).html).toBe("#41 保存按钮没有反应：当前状态不能开始");
    expect(onlyRequest(ctx).state).toBe(S.running);
  });
});

describe("PR card session controls", () => {
  async function prReady(raw = harnessRaw()) {
    const ctx = await setup({ raw });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    await openHarnessPr(ctx, onlyRequest(ctx).id);
    const request = onlyRequest(ctx);
    expect(request).toMatchObject({ prNumber: 7, state: S.prReady });
    return { ctx, messageId: request.cardMessageId! };
  }

  it("adds 打回, 取消, and a session link within the callback limit", async () => {
    const { ctx, messageId } = await prReady(
      harnessRaw({
        executors: { lody: { sessionUrl: "https://lody.example/s/{sessionId}" } },
      }),
    );
    const card = cardOf(ctx, messageId)!;
    expect(card.keyboard!.map((row) => row.map((b) => b.text))).toEqual([
      ["✅ 合并", "🔍 详情", "🔗 PR"],
      ["🔄 刷新"],
      ["↩️ 打回", "✖️ 取消", "💬 会话"],
    ]);
    const session = card.keyboard![2]!.find((b) => b.text === "💬 会话")!;
    expect(session.url).toBe("https://lody.example/s/sess-1");
    for (const button of card.keyboard!.flat()) {
      if (button.callbackData) expect(button.callbackData.length).toBeLessThanOrEqual(64);
    }
  });

  it("asks for the 打回 reason and relays the reply as revise feedback", async () => {
    const { ctx, messageId } = await prReady();
    const reject = buttons(ctx, messageId).find((b) => b.text === "↩️ 打回")!;
    expect(await press(ctx, reject.callbackData!, messageId, 7)).toEqual({ text: "无权限" });
    expect(await press(ctx, reject.callbackData!, messageId)).toEqual({ text: "请回复打回原因" });
    const prompt = ctx.telegram.sent.at(-1)!;
    expect(prompt.message).toMatchObject({
      threadId: 501,
      replyToMessageId: messageId,
      forceReply: { placeholder: "打回原因" },
    });
    expect(onlyRequest(ctx).state).toBe(S.prReady);

    const reply = await ctx.port.handleReply({
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: 400,
      replyToMessageId: prompt.messageId,
      text: "按钮颜色不对",
    });
    expect(reply).toEqual({ html: "" });
    expect(ctx.github.comments.at(-1)).toMatchObject({ number: 7 });
    expect(ctx.github.comments.at(-1)!.body).toContain("> 按钮颜色不对");
    expect(ctx.github.labelsAdded).toEqual([{ number: 7, labels: ["harness:revise"] }]);
    expect(ctx.lody.chats.at(-1)!.prompt).toContain("revise pull request #7");
    expect(onlyRequest(ctx).state).toBe(S.revising);
  });

  it("confirms 取消, stops the session, and leaves the PR open", async () => {
    const { ctx, messageId } = await prReady();
    const ask = buttons(ctx, messageId).find((b) => b.text === "✖️ 取消")!;
    expect(await press(ctx, ask.callbackData!, messageId)).toEqual({ text: "请确认取消" });
    const confirming = cardOf(ctx, messageId)!;
    expect(confirming.html).toContain("PR 保持打开");
    expect(confirming.keyboard!.flat().map((b) => b.text)).toEqual(["✅ 确认取消", "返回"]);
    expect(onlyRequest(ctx).state).toBe(S.prReady);

    const back = confirming.keyboard!.flat().find((b) => b.text === "返回")!;
    expect(await press(ctx, back.callbackData!, messageId)).toEqual({ text: "已返回" });
    expect(buttons(ctx, messageId).map((b) => b.text)).toContain("✖️ 取消");

    await press(ctx, ask.callbackData!, messageId);
    const confirm = buttons(ctx, messageId).find((b) => b.text === "✅ 确认取消")!;
    expect(await press(ctx, confirm.callbackData!, messageId)).toEqual({ text: "已取消" });
    expect(onlyRequest(ctx).state).toBe(S.cancelled);
    expect(ctx.lody.cancelled).toEqual(["sess-1"]);
    expect(ctx.github.merges).toEqual([]);
    const card = cardOf(ctx, messageId)!;
    expect(card.html).toContain("请求已取消，harness 不再跟进");
    expect(card.keyboard!.flat().map((b) => b.text)).toEqual(["🔗 PR"]);
    expect(ctx.store.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["button.abortAsk", "button.abort", "request.cancelled"]),
    );
  });

  it("offers 重新排队 when the session ended and the request needs attention", async () => {
    const { ctx, messageId } = await prReady();
    ctx.lody.session = { archived: true };
    ctx.advance(10 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.needsAttention);
    const row = buttons(ctx, messageId).map((b) => b.text);
    expect(row).toContain("🔁 重新排队");
    expect(row).not.toContain("↩️ 打回");

    ctx.lody.session = {};
    const requeue = buttons(ctx, messageId).find((b) => b.text === "🔁 重新排队")!;
    expect(await press(ctx, requeue.callbackData!, messageId)).toEqual({ text: "已加入队列" });
    await ctx.service.work.scheduler.tick();
    expect(ctx.lody.created).toHaveLength(2);
  });
});
