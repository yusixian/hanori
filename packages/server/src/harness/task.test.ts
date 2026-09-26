import { describe, expect, it, vi } from "vitest";
import { CONTINUE_CALLBACK } from "./delivery-watch.js";
import { TASK_WATCH_MS } from "./job-monitor.js";
import { REQUEST_STATES as S } from "./states.js";
import { TASK_RESULT_KIND, TASK_RESULT_LIMIT, clipEscaped, renderTaskResult } from "./task.js";
import { TEST_CHAT_ID, TEST_OWNER, TEST_REPO } from "./test-fakes.js";
import { type Ctx, cardOf, harnessRaw, onlyRequest, setup } from "./work-test-helpers.js";

const SESSION_URL = "https://lody.example/s/{sessionId}";
const TEXT = "调查登录页为什么慢\n只要结论，不要改代码";

function task(ctx: Ctx, args = TEXT, options: { threadId?: number; messageId?: number } = {}) {
  return ctx.port.handleCommand({
    command: "task",
    args,
    chatId: TEST_CHAT_ID,
    threadId: "threadId" in options ? options.threadId : 501,
    userId: TEST_OWNER,
    messageId: "messageId" in options ? options.messageId : 9,
  });
}

function reply(ctx: Ctx, replyToMessageId: number, text: string) {
  return ctx.port.handleReply({
    chatId: TEST_CHAT_ID,
    threadId: 501,
    userId: TEST_OWNER,
    messageId: 900 + ctx.telegram.sent.length,
    replyToMessageId,
    text,
  });
}

async function runningTask(ctx: Ctx, args = TEXT) {
  expect(await task(ctx, args)).toEqual({ html: "" });
  await ctx.service.work.scheduler.tick();
  return onlyRequest(ctx);
}

/** The turn ends with Lody showing the session idle, reported like the bridge callback would. */
async function endTurn(ctx: Ctx, lastAssistant: string | null) {
  ctx.lody.session = { status: "idle" };
  ctx.lody.lastAssistant = lastAssistant;
  const job = await ctx.store.latestJob(onlyRequest(ctx).id);
  await ctx.service.work.onTurnEnd({
    sessionId: job!.sessionId!,
    turnId: ctx.lody.chats.at(-1)?.turnId,
    command: "create",
    status: "completed",
    exitCode: 0,
    startedAt: "",
    endedAt: "",
  });
}

const results = (ctx: Ctx) =>
  ctx.telegram.sent.filter((s) => s.message.html.startsWith("✅ 任务完成"));

describe("/task", () => {
  it("asks for a project topic and a description", async () => {
    const ctx = await setup();
    expect((await task(ctx, TEXT, { threadId: undefined })).html).toContain(
      "请在项目话题中使用 /task",
    );
    expect((await task(ctx, "  ")).html).toContain("用法：/task");
    expect(ctx.store.requests.size).toBe(0);
  });

  it("queues a task without an issue, posts its card, and dispatches it like /bug", async () => {
    const ctx = await setup();
    const request = await runningTask(ctx);
    expect(ctx.github.issues).toEqual([]);
    expect(request).toMatchObject({
      type: "task",
      state: S.running,
      issueNumber: null,
      title: "调查登录页为什么慢",
      ownerText: TEXT,
    });
    const card = cardOf(ctx, request.cardMessageId!)!;
    expect(card.html).toContain("🔵 进行中</b> · 🛠 任务 · 调查登录页为什么慢");
    expect(ctx.telegram.sent[0]!.message.replyToMessageId).toBe(9);
    expect(card.keyboard!.flat().map((b) => b.text)).toContain("✖️ 取消");

    const created = ctx.lody.created[0]!;
    expect(created.title).toBe("sandbox task 调查登录页为什么慢");
    expect(created.prompt).toContain(`Dev Harness task \`${request.id}\``);
    expect(created.prompt).toContain(`work on branch \`harness/${request.id}\``);
    expect(created.prompt).toContain("there is no GitHub issue for it");
    expect(created.prompt).toContain("merge, push tags, publish releases, deploy");
    expect(created.prompt).toContain("`.cos/**`, `.github/workflows/**`");
    expect(created.prompt).toContain("> 只要结论，不要改代码");
    expect(created.prompt).not.toContain("Fixes");
    const event = ctx.store.events.find((e) => e.type === "request.created")!;
    expect(event.payload).toEqual({ source: "command", kind: "task", length: TEXT.length });
  });

  it("works from a button, without a message to reply to", async () => {
    const ctx = await setup();
    expect(await task(ctx, TEXT, { messageId: undefined })).toEqual({ html: "" });
    expect(ctx.telegram.sent[0]!.message.replyToMessageId).toBeUndefined();
  });

  it("posts the final message as the result and completes the task", async () => {
    const ctx = await setup({
      raw: harnessRaw({ executors: { lody: { sessionUrl: SESSION_URL } } }),
    });
    const request = await runningTask(ctx);
    const finalMessage = "登录页慢是因为 <Avatar> 同步加载 & 没有缓存。";
    await endTurn(ctx, finalMessage);

    expect(onlyRequest(ctx)).toMatchObject({ state: S.completed, stateReason: null });
    const [result] = results(ctx);
    expect(result!.message.html).toBe(
      [
        "✅ 任务完成 · <b>调查登录页为什么慢</b>",
        "<blockquote expandable>登录页慢是因为 &lt;Avatar&gt; 同步加载 &amp; 没有缓存。</blockquote>",
        "回复这条消息可以让同一个会话继续。",
      ].join("\n"),
    );
    expect(result!.message).toMatchObject({
      threadId: 501,
      replyToMessageId: request.cardMessageId,
      keyboard: [[{ text: "💬 打开会话", url: "https://lody.example/s/sess-1" }]],
    });
    const message = await ctx.store.findMessage(TEST_CHAT_ID, result!.messageId);
    expect(message).toMatchObject({ kind: TASK_RESULT_KIND, requestId: request.id });
    const card = cardOf(ctx, request.cardMessageId!)!;
    expect(card.html).toContain("✅ 已完成");
    expect(card.keyboard).toEqual([
      [{ text: "💬 打开会话", url: "https://lody.example/s/sess-1" }],
    ]);
    const completed = ctx.store.events.find((e) => e.type === "task.completed")!;
    expect(completed.payload).toEqual({ resultLength: finalMessage.length });
    expect(JSON.stringify(ctx.store.events)).not.toContain("Avatar");
    expect(ctx.logs.join("\n")).not.toContain("Avatar");
    expect(ctx.github.branchLookups).toContain(`harness/${request.id}`);
    expect((await ctx.port.handleCommand({ ...listCommand })).html).toBe("当前没有进行中的请求。");
  });

  it("retries a rejected Telegram result and only completes after delivery", async () => {
    const ctx = await setup();
    const request = await runningTask(ctx);
    const send = vi
      .spyOn(ctx.telegram, "send")
      .mockRejectedValueOnce(new Error("Telegram unavailable"));
    await expect(endTurn(ctx, "等待补发的结论")).rejects.toThrow("Telegram unavailable");
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect((await ctx.store.latestJob(request.id))!.endedAt).toBeNull();
    expect(results(ctx)).toEqual([]);
    send.mockRestore();

    ctx.advance(2 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.completed);
    expect(results(ctx)).toHaveLength(1);
    expect(results(ctx)[0]!.message.html).toContain("等待补发的结论");
    expect(await ctx.store.findMessage(TEST_CHAT_ID, results(ctx)[0]!.messageId)).toMatchObject({
      requestId: request.id,
      kind: TASK_RESULT_KIND,
    });
    await endTurn(ctx, "等待补发的结论");
    ctx.advance(2 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(results(ctx)).toHaveLength(1);
  });

  it("reopens the same session when the owner replies to the result", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    await endTurn(ctx, "第一轮结论");
    const first = results(ctx)[0]!;

    expect(await reply(ctx, first.messageId, "再看一下移动端")).toEqual({ html: "" });
    expect(onlyRequest(ctx).state).toBe(S.running);
    const job = await ctx.store.latestJob(onlyRequest(ctx).id);
    expect(job).toMatchObject({ state: "running", endedAt: null, sessionId: "sess-1" });
    const followUp = ctx.lody.chats.at(-1)!;
    expect(followUp.sessionId).toBe("sess-1");
    expect(followUp.prompt).toContain("## 3. Owner follow-up");
    expect(followUp.prompt).toContain("> 再看一下移动端");
    expect(followUp.prompt).toContain("start your final message with `Question:`");
    expect(ctx.github.comments).toEqual([]);
    expect(ctx.lody.created).toHaveLength(1);

    await endTurn(ctx, "第二轮结论");
    expect(results(ctx)).toHaveLength(2);
    expect(results(ctx)[1]!.message.html).toContain("第二轮结论");
    expect(onlyRequest(ctx).state).toBe(S.completed);
  });

  it("reopens a task after its watch window ended", async () => {
    const ctx = await setup();
    const request = await runningTask(ctx);
    await endTurn(ctx, "结论");
    ctx.advance(TASK_WATCH_MS + 60_000);
    await ctx.service.work.scheduler.tick();
    expect((await ctx.store.latestJob(request.id))!.state).toBe("done");

    expect(await reply(ctx, request.cardMessageId!, "继续")).toEqual({ html: "" });
    expect((await ctx.store.latestJob(request.id))!.state).toBe("running");
    expect(ctx.lody.chats.at(-1)!.prompt).toContain("> 继续");
  });

  it("goes back to running when the completed session starts a turn on its own", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    await endTurn(ctx, "等子会话回来");
    ctx.lody.session = { status: "running" };
    ctx.advance(2 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(ctx.store.events.some((e) => e.type === "task.resumed")).toBe(true);
  });

  it("hands over to the PR card when the session opened a PR on the task branch", async () => {
    const ctx = await setup();
    const request = await runningTask(ctx, "把按钮文案改成「保存中…」");
    ctx.github.pr = {
      ...ctx.github.pr,
      headRef: `harness/${request.id}`,
      body: "## Verification\nok\n## Review\nok",
    };
    await endTurn(ctx, "PR 已开");
    expect(onlyRequest(ctx)).toMatchObject({ prNumber: 7, state: S.prReady });
    expect(results(ctx)).toEqual([]);
    expect(ctx.store.events.some((e) => e.type === "pr.linked")).toBe(true);
    expect(ctx.telegram.lastCard()!.html).toContain("PR #7");
  });

  it("links a task PR from the webhook by its branch alone", async () => {
    const ctx = await setup();
    const request = await runningTask(ctx);
    ctx.github.pr = { ...ctx.github.pr, headRef: `harness/${request.id}`, body: "no issue here" };
    await ctx.service.prFlow.handleWebhookEvent(
      "pull_request",
      { action: "opened", pull_request: { number: 7 }, repository: { full_name: TEST_REPO } },
      "sandbox",
    );
    expect(onlyRequest(ctx)).toMatchObject({ type: "task", prNumber: 7, state: S.prReady });
  });

  it("forwards a leading Question: to the topic and sends the answer to the session", async () => {
    const ctx = await setup();
    const request = await runningTask(ctx);
    await endTurn(ctx, "Question: 用方案 A 还是 B？\nA 更快，B 更省");
    expect(onlyRequest(ctx)).toMatchObject({
      state: S.needsAttention,
      stateReason: "任务在等你回答问题",
    });
    const question = ctx.telegram.sent.find((s) => s.message.html.startsWith("❓"))!;
    expect(question.message.html).toContain("任务「调查登录页为什么慢」的问题");
    expect(question.message.html).toContain("用方案 A 还是 B？\nA 更快，B 更省");
    expect(question.message.replyToMessageId).toBe(request.cardMessageId);
    expect(results(ctx)).toEqual([]);

    expect(await reply(ctx, question.messageId, "用 A")).toEqual({ html: "" });
    expect(ctx.github.comments).toEqual([]);
    expect(ctx.lody.chats.at(-1)!.prompt).toContain("> 用 A");
    expect(onlyRequest(ctx)).toMatchObject({ state: S.running, stateReason: null });
  });

  it("moves a leading Needs spec: to needs_spec and resumes when the owner replies", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    await endTurn(ctx, "Needs spec: 需要先决定数据模型");
    expect(onlyRequest(ctx).state).toBe(S.needsSpec);
    const notice = ctx.telegram.sent.find((s) => s.message.html.includes("需要先写 spec"))!;
    expect(notice.message.html).toContain("回复这张卡片补充说明");

    expect(await reply(ctx, notice.messageId, "用现有的表")).toEqual({ html: "" });
    expect(ctx.lody.chats.at(-1)!.prompt).toContain("> 用现有的表");
    expect(onlyRequest(ctx)).toMatchObject({ state: S.running, stateReason: null });
  });

  it("finishes by the polling debounce when no turn end was reported", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    ctx.lody.session = { status: "idle" };
    ctx.lody.lastAssistant = "轮询得到的结论";
    ctx.advance(20_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx).state).toBe(S.running);
    for (let poll = 0; poll < 2; poll++) {
      ctx.advance(2 * 60_000);
      await ctx.service.work.scheduler.tick();
    }
    expect(onlyRequest(ctx).state).toBe(S.completed);
    expect(results(ctx)[0]!.message.html).toContain("轮询得到的结论");
  });

  it.each(["failed", "canceled", "timeout"] as const)(
    "keeps a %s turn out of completed after the idle debounce and allows a reply",
    async (status) => {
      const ctx = await setup();
      const request = await runningTask(ctx);
      ctx.lody.session = { status: "idle" };
      ctx.lody.lastAssistant = "还在处理中";
      await ctx.service.work.onTurnEnd({
        sessionId: "sess-1",
        command: "create",
        status,
        exitCode: 1,
        startedAt: ctx.clock.now.toISOString(),
        endedAt: ctx.clock.now.toISOString(),
      });
      for (let poll = 0; poll < 3; poll++) {
        ctx.advance(2 * 60_000);
        await ctx.service.work.scheduler.tick();
      }
      expect(onlyRequest(ctx).state).toBe(S.needsAttention);
      expect(results(ctx)).toEqual([]);
      expect(
        ctx.store.events.find((event) => event.type === "session.undelivered")?.payload,
      ).toMatchObject({ gap: status });
      if (status === "failed") {
        const notice = ctx.telegram.sent.find((sent) => sent.message.html.startsWith("⏸"))!;
        expect(
          await ctx.port.handleCallback({
            data: CONTINUE_CALLBACK,
            chatId: TEST_CHAT_ID,
            threadId: 501,
            messageId: notice.messageId,
            userId: TEST_OWNER,
          }),
        ).toEqual({ text: "已让会话继续" });
        expect(ctx.lody.chats.at(-1)?.prompt).toContain("调查或报告任务请返回结论");
      } else {
        expect(await reply(ctx, request.cardMessageId!, "继续完成")).toEqual({ html: "" });
      }
      await endTurn(ctx, "这次完成了");
      expect(onlyRequest(ctx).state).toBe(S.completed);
      expect(results(ctx)).toHaveLength(1);
    },
  );

  it("ignores a delayed end from the previous turn after the owner reopens the task", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    const previous = {
      sessionId: "sess-1",
      command: "create" as const,
      status: "completed" as const,
      exitCode: 0,
      startedAt: ctx.clock.now.toISOString(),
      endedAt: ctx.clock.now.toISOString(),
    };
    await endTurn(ctx, "第一轮结论");
    ctx.advance(60_000);
    await reply(ctx, results(ctx)[0]!.messageId, "再检查一下");
    // Status/history can still show the previous turn while the new chat is being accepted.
    await ctx.service.work.onTurnEnd(previous);
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(results(ctx)).toHaveLength(1);
  });

  it("matches chat callbacks by turn ID despite clock skew and stale callbacks", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    await endTurn(ctx, "第一轮结论");
    await reply(ctx, results(ctx)[0]!.messageId, "继续检查");
    const previousId = ctx.lody.chats.at(-1)!.turnId;
    await endTurn(ctx, "第二轮结论");
    await reply(ctx, results(ctx)[1]!.messageId, "再检查一下");
    const currentId = ctx.lody.chats.at(-1)!.turnId;
    expect(currentId).toBeTruthy();
    expect(currentId).not.toBe(previousId);
    const end = {
      sessionId: "sess-1",
      command: "chat" as const,
      status: "completed" as const,
      exitCode: 0,
      startedAt: new Date(ctx.clock.now.getTime() + 60_000).toISOString(),
      endedAt: "",
    };
    await ctx.service.work.onTurnEnd({ ...end, turnId: previousId });
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(results(ctx)).toHaveLength(2);

    await ctx.service.work.onTurnEnd({
      ...end,
      turnId: currentId,
      status: "failed",
      exitCode: 1,
      startedAt: new Date(ctx.clock.now.getTime() - 60_000).toISOString(),
    });
    for (let poll = 0; poll < 3; poll++) {
      ctx.advance(2 * 60_000);
      await ctx.service.work.scheduler.tick();
    }
    expect(onlyRequest(ctx).state).toBe(S.needsAttention);
    expect(results(ctx)).toHaveLength(2);
  });

  it("retries delivery lookup failures instead of announcing completion without the PR", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    vi.spyOn(ctx.github, "findOpenPullRequest").mockRejectedValue(new Error("GitHub unavailable"));
    await expect(endTurn(ctx, "PR 已开")).rejects.toThrow("GitHub unavailable");
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(results(ctx)).toEqual([]);
  });

  it("lists, cancels, and retries tasks like other requests", async () => {
    const ctx = await setup();
    await runningTask(ctx);
    const list = await ctx.port.handleCommand(listCommand);
    expect(list.html).toContain("🛠 调查登录页为什么慢");

    const cancel = await ctx.port.handleCommand({ ...listCommand, command: "cancel" });
    expect(cancel.html).toBe("⚫ 已取消 调查登录页为什么慢");
    expect(ctx.lody.cancelled).toEqual(["sess-1"]);
    expect(onlyRequest(ctx).state).toBe(S.cancelled);

    const retryCtx = await setup();
    retryCtx.lody.createResult = { ok: false, reason: "unknown", message: "超时" };
    await runningTask(retryCtx);
    expect(onlyRequest(retryCtx).state).toBe(S.needsAttention);
    retryCtx.lody.createResult = null;
    const retry = await retryCtx.port.handleCommand({ ...listCommand, command: "retry" });
    expect(retry.html).toBe("🔁 已重新排队 调查登录页为什么慢");
    await retryCtx.service.work.scheduler.tick();
    expect(onlyRequest(retryCtx).state).toBe(S.running);
    expect(retryCtx.lody.created).toHaveLength(2);
    expect(retryCtx.lody.created[1]!.prompt).toContain("Dev Harness task");
  });
});

const listCommand = {
  command: "list" as const,
  args: "",
  chatId: TEST_CHAT_ID,
  threadId: 501,
  userId: TEST_OWNER,
  messageId: 5,
};

describe("task result rendering", () => {
  it("clips after escaping, without splitting entities or code points", () => {
    const clipped = clipEscaped("<".repeat(2_000), 100);
    expect(clipped.length).toBeLessThanOrEqual(100);
    expect(clipped).toMatch(/^(&lt;)+…$/);
    expect(clipEscaped("😀😀😀", 5)).toBe("😀😀…");
    expect(clipEscaped("short", 100)).toBe("short");
  });

  it("stays within one Telegram message for any result", () => {
    const html = renderTaskResult("t".repeat(200), "&".repeat(10_000));
    expect(html.length).toBeLessThan(4_096);
    expect(html).toContain(`${"&amp;".repeat(Math.floor((TASK_RESULT_LIMIT - 1) / 5))}…`);
    expect(renderTaskResult("t", null)).toContain("没有读到会话的最后一条回复");
  });
});

describe("task results without GitHub", () => {
  it("still posts the result when the GitHub App is not configured", async () => {
    const ctx = await setup();
    await task(ctx);
    await ctx.service.work.scheduler.tick();
    ctx.github.available = false;
    await endTurn(ctx, "无需 GitHub 的结论");
    expect(onlyRequest(ctx).state).toBe(S.completed);
    expect(results(ctx)[0]!.message.html).toContain("无需 GitHub 的结论");
  });
});
