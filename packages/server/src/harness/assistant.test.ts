import { describe, expect, it, vi } from "vitest";
import { ASSISTANT_LIMITS } from "./assistant.js";
import { scriptedModel, say, tap } from "./assistant-test-helpers.js";
import { renderAssistantReply, splitForTelegram } from "./assistant-render.js";
import { TEST_CHAT_ID, TEST_OWNER, TEST_REPO, createTestService } from "./test-fakes.js";

const text = (reply: string) => [{ type: "text" as const, text: reply }];

function command(
  ctx: Awaited<ReturnType<typeof createTestService>>,
  name: "new" | "status" | "bug",
  args = "",
  threadId: number | undefined = 501,
) {
  return ctx.port.handleCommand({
    command: name,
    args,
    chatId: TEST_CHAT_ID,
    threadId,
    userId: TEST_OWNER,
    messageId: 900,
  });
}

describe("topic assistant context", () => {
  it("keeps commands and cards out and stores only owner text and replies", async () => {
    const ctx = await createTestService();
    await command(ctx, "status");
    await command(ctx, "bug", "头像上传失败");
    const { model, promptOf } = scriptedModel([text("#41 已经在处理。")]);
    await say(ctx, model, "头像那个问题现在怎么样了？");

    expect(ctx.store.topicMessages.map((m) => [m.role, m.threadId, m.text])).toEqual([
      ["user", 501, "头像那个问题现在怎么样了？"],
      ["assistant", 501, "#41 已经在处理。"],
    ]);
    const prompt = promptOf(0);
    expect(prompt).toContain("头像那个问题现在怎么样了？");
    expect(prompt).not.toContain("头像上传失败");
    expect(prompt).not.toContain("待合并");

    const placeholder = ctx.telegram.sent.find((s) => s.message.html === "🔎 正在查…")!;
    expect(placeholder.message).toMatchObject({ threadId: 501, replyToMessageId: 1000 });
    const edit = ctx.telegram.edits.find((e) => e.messageId === placeholder.messageId)!;
    expect(edit.message.html).toBe(
      `<a href="https://github.com/${TEST_REPO}/issues/41">#41</a> 已经在处理。`,
    );
    expect(ctx.store.topicMessages[1]!.messageId).toBe(placeholder.messageId);
  });

  it("isolates topics and pins the project in a project topic", async () => {
    const ctx = await createTestService();
    const { model, promptOf } = scriptedModel([text("好的")]);
    await say(ctx, model, "项目话题里的讨论");
    await say(ctx, model, "General 里的讨论", { threadId: undefined });
    await say(ctx, model, "继续项目话题");

    expect(promptOf(1)).not.toContain("项目话题里的讨论");
    expect(promptOf(1)).toContain("当前在 General 话题");
    expect(promptOf(2)).toContain("项目话题里的讨论");
    expect(promptOf(2)).not.toContain("General 里的讨论");
    expect(promptOf(2)).toContain(`当前话题绑定项目 sandbox（仓库 ${TEST_REPO}）`);
  });

  it("resets one topic with /new and starts over", async () => {
    const ctx = await createTestService();
    const { model, promptOf } = scriptedModel([text("收到")]);
    await say(ctx, model, "旧需求");
    await say(ctx, model, "General 讨论", { threadId: undefined });

    const reply = await command(ctx, "new");
    expect(reply.html).toContain("已清空本话题的助手对话");
    expect(ctx.store.topicMessages.map((m) => m.threadId)).toEqual([0, 0]);
    expect((await command(ctx, "new")).html).toContain("还没有助手对话");

    await say(ctx, model, "新需求");
    expect(promptOf(2)).toContain("新需求");
    expect(promptOf(2)).not.toContain("旧需求");
  });

  it("drops a turn that was running when /new arrived", async () => {
    const ctx = await createTestService();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { model } = scriptedModel([text("太晚了")]);
    const original = model.doGenerate;
    model.doGenerate = async (options) => {
      await new Promise<void>((resolve, reject) => {
        options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason));
        void gate.then(resolve);
      });
      return original(options);
    };
    const turn = say(ctx, model, "进行中的问题");
    await vi.waitFor(() => expect(ctx.store.topicMessages).toHaveLength(1));
    await command(ctx, "new");
    release();
    await turn;
    expect(ctx.store.topicMessages).toEqual([]);
    expect(ctx.telegram.edits.at(-1)?.message.html).toBe("对话已清空，这条消息没有处理。");
  });

  it("prunes old rows everywhere and caps each topic", async () => {
    const ctx = await createTestService();
    const old = new Date(ctx.service.now().getTime() - ASSISTANT_LIMITS.retentionMs - 1000);
    for (let i = 0; i < ASSISTANT_LIMITS.keepPerTopic + 5; i++) {
      await ctx.store.appendTopicMessage({
        chatId: TEST_CHAT_ID,
        threadId: 501,
        role: "user",
        text: `m${i}`,
      });
    }
    await ctx.store.appendTopicMessage({
      chatId: TEST_CHAT_ID,
      threadId: 0,
      role: "user",
      text: "stale",
    });
    ctx.store.topicMessages.at(-1)!.createdAt = old;

    const { model, calls } = scriptedModel([text("ok")]);
    await say(ctx, model, "最新");
    const topic = ctx.store.topicMessages.filter((m) => m.threadId === 501);
    expect(topic).toHaveLength(ASSISTANT_LIMITS.keepPerTopic);
    expect(topic.at(-1)!.text).toBe("ok");
    expect(ctx.store.topicMessages.some((m) => m.text === "stale")).toBe(false);
    expect(calls[0]!.prompt.filter((m) => m.role !== "system")).toHaveLength(
      ASSISTANT_LIMITS.historyMessages,
    );
  });

  it("reports a failed turn without logging message content", async () => {
    const ctx = await createTestService();
    const { model } = scriptedModel([text("unused")]);
    model.doGenerate = async () => {
      throw new Error("provider echoed 秘密需求");
    };
    await say(ctx, model, "秘密需求");
    expect(ctx.telegram.edits.at(-1)?.message.html).toContain("助手这次没有答出来");
    expect(ctx.logs.join("\n")).toContain("Dev Harness assistant topic");
    expect(ctx.logs.join("\n")).not.toContain("秘密");

    const ok = scriptedModel([text("机密回答")]);
    await say(ctx, ok.model, "另一个秘密");
    expect(ctx.logs.join("\n")).not.toMatch(/秘密|机密/);
  });
});

describe("topic assistant tools", () => {
  it("queries GitHub and the harness store for the topic's project", async () => {
    const ctx = await createTestService();
    ctx.github.openIssues = [
      {
        number: 12,
        title: "登录页闪烁",
        state: "open",
        isPullRequest: false,
        merged: null,
        labels: ["bug"],
        author: "octocat",
        comments: 1,
        updatedAt: "2026-09-24T10:00:00Z",
        url: `https://github.com/${TEST_REPO}/issues/12`,
      },
    ];
    ctx.github.repoFiles["HANDOFF.md"] = "# Handoff\n下一步：设置页";
    await command(ctx, "bug", "保存按钮没有反应");
    const { model, promptOf } = scriptedModel([
      [
        { type: "tool-call", toolName: "github_issues", input: { state: "open" } },
        { type: "tool-call", toolName: "harness_requests", input: {} },
        { type: "tool-call", toolName: "repo_read_file", input: { path: "HANDOFF.md" } },
        { type: "tool-call", toolName: "github_commits", input: { project: "other" } },
      ],
      text("#12 还开着。"),
    ]);
    await say(ctx, model, "还有什么没完善的？");

    expect(ctx.github.reads).toContain(`listIssues ${TEST_REPO} open`);
    expect(ctx.github.fileReads).toContain("HANDOFF.md");
    const followUp = promptOf(1);
    expect(followUp).toContain("登录页闪烁");
    expect(followUp).toContain("保存按钮没有反应");
    expect(followUp).toContain("下一步：设置页");
    expect(followUp).toContain("本话题只能查询项目 sandbox");
    expect(ctx.github.reads.some((read) => read.startsWith("listCommits"))).toBe(false);
  });

  it("caps file reads and refuses secrets and binaries", async () => {
    const ctx = await createTestService();
    const { createAssistantTools, FILE_CHAR_LIMIT } = await import("./assistant-tools.js");
    const tools = createAssistantTools({
      service: ctx.service,
      fixedProject: "sandbox",
      suggestions: [],
    });
    const run = (name: string, input: object) =>
      tools[name]!.execute!(input, { toolCallId: "t", messages: [] }) as Promise<
        Record<string, unknown>
      >;
    ctx.github.repoFiles = {
      "docs/big.md": "字".repeat(FILE_CHAR_LIMIT + 10),
      "assets/logo.png": "\u0000PNG",
      ".env": "SECRET=1",
      "README.md": "hi",
    };

    const big = await run("repo_read_file", { path: "docs/big.md" });
    expect(big).toMatchObject({ truncated: true, totalChars: FILE_CHAR_LIMIT + 10 });
    expect((big.content as string).length).toBe(FILE_CHAR_LIMIT);
    expect(await run("repo_read_file", { path: "assets/logo.png" })).toEqual({
      error: "assets/logo.png 是二进制文件，无法读取",
    });
    for (const path of [".env", "config/.env.production", "./.envrc"]) {
      expect((await run("repo_read_file", { path })).error).toContain(".env 类文件");
    }
    expect(ctx.github.fileReads.some((path) => path.includes(".env"))).toBe(false);
    expect((await run("repo_read_file", { path: "missing.md" })).error).toContain("文件不存在");
    const listing = await run("repo_list_dir", { path: "" });
    expect(listing.entries).toEqual(["docs/", "assets/", "README.md"]);
  });
});

describe("topic assistant suggestions", () => {
  const proposeBug = (extra: object = {}) =>
    scriptedModel([
      [
        {
          type: "tool-call",
          toolName: "propose_command",
          input: { command: "bug", args: "保存按钮没有反应\n网络慢时点击无反馈", ...extra },
        },
      ],
      text("可以建一个 bug。"),
    ]);

  it("runs the typed /bug path once per suggestion and only for the owner", async () => {
    const ctx = await createTestService();
    const { model } = proposeBug();
    await say(ctx, model, "保存按钮没反应，帮我整理一下");
    const row = ctx.store.topicMessages.find((m) => m.role === "assistant")!;
    const reply = ctx.telegram.edits.find((e) => e.messageId === row.messageId)!.message;
    expect(reply.html).toContain("<b>建议 1</b>：<code>/bug</code>");
    expect(reply.html).toContain("<blockquote expandable>保存按钮没有反应\n网络慢时点击无反馈");
    expect(reply.keyboard).toEqual([[{ text: "▶️ 执行建议 1：/bug", callbackData: "hx:t:0" }]]);

    const handleCommand = vi.spyOn(ctx.service.port, "handleCommand");
    expect(await tap(ctx, row.messageId!, { userId: 7 })).toEqual({ text: "无权限" });
    expect(await tap(ctx, row.messageId!, { data: "hx:t:1" })).toEqual({ text: "按钮已失效" });
    expect(await tap(ctx, 12345)).toEqual({ text: "按钮已失效" });
    expect(handleCommand).not.toHaveBeenCalled();

    expect(await tap(ctx, row.messageId!)).toEqual({ text: "已执行 /bug" });
    expect(handleCommand).toHaveBeenCalledWith({
      command: "bug",
      args: "保存按钮没有反应\n网络慢时点击无反馈",
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: row.messageId,
    });
    expect(ctx.github.issues.map((issue) => issue.title)).toEqual(["保存按钮没有反应"]);
    expect([...ctx.store.requests.values()]).toHaveLength(1);
    const marked = ctx.telegram.edits.at(-1)!;
    expect(marked.messageId).toBe(row.messageId);
    expect(marked.message.html).toContain("· ✅ 已执行");
    expect(marked.message.keyboard).toEqual([]);

    expect(await tap(ctx, row.messageId!)).toEqual({ text: "这条建议已执行过" });
    expect(ctx.github.issues).toHaveLength(1);
    expect(ctx.store.topicMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("runs a General suggestion in the named project's topic", async () => {
    const ctx = await createTestService();
    const { model } = proposeBug({ project: "sandbox" });
    await say(ctx, model, "sandbox 的保存按钮", { threadId: undefined });
    const row = ctx.store.topicMessages.find((m) => m.role === "assistant")!;
    expect(row).toMatchObject({ threadId: 0 });
    expect(row.suggestions).toEqual([
      { command: "bug", args: "保存按钮没有反应\n网络慢时点击无反馈", project: "sandbox" },
    ]);
    const handleCommand = vi.spyOn(ctx.service.port, "handleCommand");
    expect(await tap(ctx, row.messageId!, { threadId: undefined })).toEqual({
      text: "已执行 /bug",
    });
    expect(handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 501, messageId: undefined }),
    );
    expect(ctx.github.issues).toHaveLength(1);
  });

  it("refuses a General /bug suggestion without a project", async () => {
    const ctx = await createTestService();
    const { model, promptOf } = proposeBug();
    await say(ctx, model, "保存按钮", { threadId: undefined });
    expect(promptOf(1)).toContain("请传 project");
    expect(ctx.store.topicMessages.at(-1)!.suggestions).toBeNull();
  });
});

describe("assistant rendering", () => {
  it("splits long replies within the Telegram limit once escaped", () => {
    const chunks = splitForTelegram(`${"<&>".repeat(2000)}\n${"段落".repeat(10)}`, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.replace(/[<>]/g, "&lt;").replace(/&(?!lt;)/g, "&amp;").length).toBeLessThan(
        1100,
      );
    }
    expect(chunks.join("").replaceAll("\n", "")).toBe(`${"<&>".repeat(2000)}${"段落".repeat(10)}`);
  });

  it("keeps the suggestion block on the same chunk whether or not it was used", () => {
    const input = {
      text: "说明",
      suggestions: [{ command: "status", args: "", project: null }],
      repo: TEST_REPO,
    };
    const fresh = renderAssistantReply({ ...input, usedMask: 0 });
    const used = renderAssistantReply({ ...input, usedMask: 1 });
    expect(fresh.chunks).toHaveLength(1);
    expect(used.chunks).toHaveLength(1);
    expect(used.keyboard).toEqual([]);
  });
});
