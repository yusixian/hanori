import { describe, expect, it } from "vitest";
import { REQUEST_STATES as S } from "./states.js";
import { TEST_CHAT_ID, TEST_OWNER, TEST_REPO } from "./test-fakes.js";
import { type Ctx, bug, cardOf, harnessRaw, onlyRequest, setup } from "./work-test-helpers.js";

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

describe("/bug", () => {
  it("creates a labeled issue, one card, and a Lody session with the prompt on stdin", async () => {
    const ctx = await setup();
    expect(await bug(ctx)).toEqual({ html: "" });
    const issue = ctx.github.issues[0]!;
    expect(issue).toMatchObject({ number: 41, title: "保存按钮没有反应", labels: ["harness:bug"] });
    expect(issue.body).toContain("- photo: `AgACfile`");
    expect(issue.body).not.toContain("api.telegram.org");

    await ctx.service.work.scheduler.tick();
    const request = onlyRequest(ctx);
    expect(request.state).toBe(S.running);
    expect(ctx.lody.created).toHaveLength(1);
    const created = ctx.lody.created[0]!;
    expect(created).toMatchObject({
      machine: "mac-0001",
      localProject: "harness-sandbox",
      worktree: true,
      agent: "Claude Code",
      model: "sonnet",
      configOptions: ["effort=medium"],
    });
    expect(created.prompt).toContain(`branch \`harness/${request.id}\``);
    expect(created.prompt).toContain("independent review from Codex / gpt-6-sol (effort high)");
    expect(created.prompt).toContain("> 保存按钮没有反应");

    expect(ctx.telegram.sent).toHaveLength(1);
    const card = cardOf(ctx, request.cardMessageId!)!;
    expect(card.html).toContain("🔵 进行中");
    expect(card.html).toContain("机器 MBP-64G · 模型 sonnet · 已用 0 分钟");
    expect(ctx.telegram.sent[0]!.message.replyToMessageId).toBe(9);
  });

  it("runs the built-in Codex lead with its reasoning effort", async () => {
    const ctx = await setup({ raw: harnessRaw({ roles: undefined }) });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    const created = ctx.lody.created[0]!;
    expect(created).toMatchObject({
      agent: "Codex",
      model: "gpt-6-sol",
      configOptions: ["reasoning_effort=high"],
    });
    expect(onlyRequest(ctx).state).toBe(S.running);
    expect(created.prompt).toContain("You are the lead (Codex / gpt-6-sol (effort high))");
    expect(created.prompt).toContain("using gpt-6-luna (effort low)");
    expect(created.prompt).toContain("review from Claude Code / opus[1m] (effort high)");
  });

  it("refuses outside a project topic", async () => {
    const ctx = await setup();
    const reply = await ctx.port.handleCommand({
      command: "bug",
      args: "x",
      chatId: TEST_CHAT_ID,
      userId: TEST_OWNER,
      messageId: 1,
    });
    expect(reply.html).toContain("请在项目话题中使用 /bug");
    expect(ctx.github.issues).toHaveLength(0);
  });

  it("polls context and elapsed time into the card", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    ctx.advance(12 * 60_000);
    await ctx.service.work.scheduler.tick();
    const request = onlyRequest(ctx);
    const card = cardOf(ctx, request.cardMessageId!)!;
    expect(card.html).toContain("模型 Sonnet 5 · 已用 12 分钟");
    expect(card.html).toContain("上下文 43% · claude 本周 53% · 5 小时 17%");
  });
});

describe("PR follow-up", () => {
  it("links the harness PR, replaces the card, and loops CI failures back", async () => {
    const ctx = await setup({ raw: harnessRaw({ guardrails: { autoFixRounds: 1 } }) });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    const request = onlyRequest(ctx);
    ctx.github.runs = [{ id: 1, name: "test", status: "completed", conclusion: "failure" }];
    await openHarnessPr(ctx, request.id);

    const linked = onlyRequest(ctx);
    expect(linked).toMatchObject({ prNumber: 7, state: S.prReady, fixRounds: 1 });
    expect(ctx.telegram.sent).toHaveLength(1);
    const card = cardOf(ctx, linked.cardMessageId!)!;
    expect(card.html).toContain("CI 失败 · PR #7");
    expect(card.html).toContain("claude 本周 53% · 5 小时 17%");
    expect(ctx.lody.chats[0]!.prompt).toContain("CI failed on pull request #7 (round 1 of 1)");

    ctx.github.pr = { ...ctx.github.pr, headSha: "f".repeat(40) };
    await ctx.service.prFlow.handleWebhookEvent(
      "check_run",
      {
        action: "completed",
        check_run: { head_sha: "f".repeat(40), pull_requests: [{ number: 7 }] },
        repository: { full_name: TEST_REPO },
      },
      "sandbox",
    );
    const exhausted = onlyRequest(ctx);
    expect(exhausted.state).toBe(S.needsAttention);
    expect(cardOf(ctx, exhausted.cardMessageId!)!.html).toContain("需要你看一下：CI 连续失败 1 轮");
    expect(ctx.lody.chats).toHaveLength(1);
  });

  it("turns a card reply into PR feedback and archives the session after merge", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    await openHarnessPr(ctx, onlyRequest(ctx).id);
    const request = onlyRequest(ctx);

    const reply = await ctx.port.handleReply({
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: 300,
      replyToMessageId: request.cardMessageId!,
      text: "按钮文案改成「保存中…」",
    });
    expect(reply).toEqual({ html: "" });
    expect(ctx.github.comments.at(-1)).toMatchObject({ number: 7 });
    expect(ctx.github.comments.at(-1)!.body).toContain("> 按钮文案改成「保存中…」");
    expect(ctx.github.labelsAdded).toEqual([{ number: 7, labels: ["harness:revise"] }]);
    expect(ctx.lody.chats.at(-1)!.prompt).toContain("revise pull request #7");
    expect(onlyRequest(ctx).state).toBe(S.revising);
    expect(cardOf(ctx, request.cardMessageId!)!.html).toContain("✏️ 修订中");

    ctx.github.pr = { ...ctx.github.pr, headSha: "e".repeat(40) };
    await ctx.service.prFlow.handleWebhookEvent(
      "pull_request",
      { action: "synchronize", pull_request: { number: 7 }, repository: { full_name: TEST_REPO } },
      "sandbox",
    );
    expect(onlyRequest(ctx).state).toBe(S.prReady);

    const merge = ctx.telegram.callbackData("✅ 合并");
    const answer = await ctx.port.handleCallback({
      data: merge!,
      chatId: TEST_CHAT_ID,
      threadId: 501,
      messageId: request.cardMessageId!,
      userId: TEST_OWNER,
    });
    expect(answer).toEqual({ text: "已合并" });
    expect(onlyRequest(ctx).state).toBe(S.merged);
    expect(ctx.lody.archived).toEqual(["sess-1"]);
  });

  it("does not link a stranger's fork PR that claims the issue", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    ctx.github.pr = {
      ...ctx.github.pr,
      headRepo: "stranger/fork",
      author: "stranger",
      headRef: `harness/${onlyRequest(ctx).id}`,
      body: "Fixes #41",
    };
    await ctx.service.prFlow.handleWebhookEvent(
      "pull_request",
      { action: "opened", pull_request: { number: 7 }, repository: { full_name: TEST_REPO } },
      "sandbox",
    );
    expect(onlyRequest(ctx).prNumber).toBeNull();
    expect(ctx.store.requests.size).toBe(1);
  });
});

describe("guardrails", () => {
  it("reminds once per idle stretch and [继续等] re-arms it", async () => {
    const ctx = await setup();
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    ctx.advance(46 * 60_000);
    await ctx.service.work.scheduler.tick();
    const reminders = () => ctx.telegram.sent.filter((s) => s.message.html.startsWith("⏰"));
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]!.message.html).toContain("已 46 分钟没有进展");
    ctx.advance(60_000);
    await ctx.service.work.scheduler.tick();
    expect(reminders()).toHaveLength(1);

    const reminder = reminders()[0]!;
    const wait = reminder.message.keyboard![0]!.find((b) => b.text.includes("继续等"))!;
    const answer = await ctx.port.handleCallback({
      data: wait.callbackData!,
      chatId: TEST_CHAT_ID,
      threadId: 501,
      messageId: reminder.messageId,
      userId: TEST_OWNER,
    });
    expect(answer).toEqual({ text: "好的，继续等" });
    ctx.advance(46 * 60_000);
    await ctx.service.work.scheduler.tick();
    expect(reminders()).toHaveLength(2);
    expect(ctx.lody.cancelled).toEqual([]);
  });

  it("cancels through the reminder only once and stops the session turn", async () => {
    const ctx = await setup({
      raw: harnessRaw({ guardrails: { time: { runRemindAfter: "1h" } } }),
    });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    ctx.advance(61 * 60_000);
    await ctx.service.work.scheduler.tick();
    const run = ctx.telegram.sent.find((s) => s.message.html.includes("已运行"))!;
    const abort = run.message.keyboard![0]!.find((b) => b.text.includes("取消"))!.callbackData!;
    const press = () =>
      ctx.port.handleCallback({
        data: abort,
        chatId: TEST_CHAT_ID,
        threadId: 501,
        messageId: run.messageId,
        userId: TEST_OWNER,
      });
    expect(await press()).toEqual({ text: "已取消" });
    expect(await press()).toEqual({ text: "该操作已处理" });
    expect(ctx.lody.cancelled).toEqual(["sess-1"]);
    expect(onlyRequest(ctx).state).toBe(S.cancelled);
  });

  it("auto-cancels only when hardCancelAfter is set", async () => {
    const ctx = await setup({
      raw: harnessRaw({ guardrails: { time: { hardCancelAfter: "2h" } } }),
    });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    ctx.advance(2 * 3_600_000);
    await ctx.service.work.scheduler.tick();
    expect(onlyRequest(ctx)).toMatchObject({
      state: S.cancelled,
      stateReason: "运行超过 2h，已自动取消",
    });
  });

  it("holds the queue while the only machine is over its quota threshold", async () => {
    const ctx = await setup({
      raw: harnessRaw({ guardrails: { quota: { pauseAt: { week: "50%" } } } }),
    });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    const request = onlyRequest(ctx);
    expect(request.state).toBe(S.queued);
    expect(request.stateReason).toBe("MBP-64G 额度暂停（claude 本周 53% ≥ 50%）");
    expect(ctx.lody.created).toHaveLength(0);
  });

  it("falls back to another model instead of pausing when configured", async () => {
    const ctx = await setup({
      raw: harnessRaw({
        guardrails: { quota: { pauseAt: { week: "50%" }, fallback: { worker: "haiku" } } },
      }),
    });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    expect(ctx.lody.created[0]!.model).toBe("haiku");
  });

  it("serializes writers on the whole repository until areas are declared", async () => {
    const ctx = await setup();
    await bug(ctx, "first");
    await ctx.service.work.scheduler.tick();
    await bug(ctx, "second");
    await ctx.service.work.scheduler.tick();
    const [first, second] = [...ctx.store.requests.values()];
    expect(first!.state).toBe(S.running);
    expect(second).toMatchObject({ state: S.queued, stateReason: "等待同区域的 #41 完成" });
  });

  it("enforces the daily session cap", async () => {
    const ctx = await setup({
      raw: harnessRaw({
        guardrails: { quota: { dailySessionCap: 1 }, concurrency: { sameAreaWriters: 5 } },
      }),
    });
    await bug(ctx, "first");
    await bug(ctx, "second");
    await ctx.service.work.scheduler.tick();
    await ctx.service.work.scheduler.tick();
    const states = [...ctx.store.requests.values()].map((r) => [r.state, r.stateReason]);
    expect(states).toEqual([
      [S.running, null],
      [S.queued, "今日会话数已达上限 1"],
    ]);
  });

  it("warns once in General when a weekly window passes warnAt", async () => {
    const ctx = await setup({
      raw: harnessRaw({ guardrails: { quota: { warnAt: { week: "50%" } } } }),
    });
    await bug(ctx);
    await ctx.service.work.scheduler.tick();
    await ctx.service.work.scheduler.tick();
    const warnings = ctx.telegram.sent.filter((s) => s.message.html.startsWith("⚠️"));
    expect(warnings.map((w) => [w.message.threadId, w.message.html])).toEqual([
      [undefined, "⚠️ MBP-64G.local claude 本周额度已用 53%（提醒阈值 50%），09-27 03:59 重置"],
      [
        undefined,
        "⚠️ MBP-64G.local claude · Fable 本周额度已用 51%（提醒阈值 50%），09-27 03:59 重置",
      ],
    ]);
  });
});
