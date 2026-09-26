import { describe, expect, it, vi } from "vitest";
import { SUGGESTABLE_COMMANDS } from "./assistant-tools.js";
import { scriptedModel, say, tap } from "./assistant-test-helpers.js";
import { createTestService } from "./test-fakes.js";

const text = (reply: string) => [{ type: "text" as const, text: reply }];

function propose(input: object) {
  return scriptedModel([
    [{ type: "tool-call", toolName: "propose_command", input }],
    text("点按钮即可。"),
  ]);
}

async function suggestionRow(ctx: Awaited<ReturnType<typeof createTestService>>) {
  return ctx.store.topicMessages.find((m) => m.role === "assistant")!;
}

describe("assistant command suggestions", () => {
  it("offers /task, /release, /list, and /retry besides /bug, /status, and /quota", () => {
    expect([...SUGGESTABLE_COMMANDS].sort()).toEqual(
      ["bug", "list", "quota", "release", "retry", "status", "task"].sort(),
    );
  });

  it("proposes /release for a release request and rejects bad release arguments", async () => {
    const ctx = await createTestService();
    const { model, promptOf } = propose({ command: "release", args: "patch" });
    await say(ctx, model, "这两个都合进去了，能不能发个版？");
    expect(promptOf(0)).toContain("/release [patch|minor|major|x.y.z]");
    const row = await suggestionRow(ctx);
    expect(row.suggestions).toEqual([{ command: "release", args: "patch", project: null }]);

    const bad = propose({ command: "release", args: "soon" });
    await say(ctx, bad.model, "发个版", { messageId: 1002 });
    expect(bad.promptOf(1)).toContain("用法：/release");
  });

  it("turns an action without its own command into a /task button that runs the typed path", async () => {
    const ctx = await createTestService();
    const args = "开一个 Lody 会话整理 docs 目录\n合并重复页面，列出删掉的文件";
    const { model, promptOf } = propose({ command: "task", args });
    await say(ctx, model, "帮我开个 Lody 会话整理 docs");
    const system = promptOf(0);
    expect(system).toContain("/task <说明>");
    expect(system).toContain("不要回答“我做不到”或“没有这个功能”");
    expect(system).toContain("回复最后至少给一个按钮");
    expect(system).toContain("不要声称做过这些事");

    const row = await suggestionRow(ctx);
    expect(row.suggestions).toEqual([{ command: "task", args, project: null }]);
    const handleCommand = vi.spyOn(ctx.service.port, "handleCommand");
    expect(await tap(ctx, row.messageId!)).toEqual({ text: "已执行 /task" });
    expect(handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "task", args, threadId: 501 }),
    );
    const [request] = [...ctx.store.requests.values()];
    expect(request).toMatchObject({
      type: "task",
      issueNumber: null,
      title: "开一个 Lody 会话整理 docs 目录",
    });
    expect(ctx.github.issues).toEqual([]);
  });

  it("refuses a /task without a description, and in General without a project", async () => {
    const ctx = await createTestService();
    const empty = propose({ command: "task", args: "" });
    await say(ctx, empty.model, "做点什么");
    expect(empty.promptOf(1)).toContain("/task 需要说明");

    const general = propose({ command: "task", args: "整理 docs" });
    await say(ctx, general.model, "整理 docs", { threadId: undefined });
    expect(general.promptOf(1)).toContain("请传 project");
    expect(ctx.store.topicMessages.at(-1)!.suggestions).toBeNull();
  });

  it("runs /list and /retry suggestions without a description", async () => {
    const ctx = await createTestService();
    const { model } = propose({ command: "list" });
    await say(ctx, model, "现在有什么在跑？");
    const row = await suggestionRow(ctx);
    expect(row.suggestions).toEqual([{ command: "list", args: "", project: null }]);
    expect(await tap(ctx, row.messageId!)).toEqual({ text: "已执行 /list" });
    expect(ctx.telegram.sent.at(-1)!.message.html).toBe("当前没有进行中的请求。");

    const retry = propose({ command: "retry", args: "ab12cd34" });
    await say(ctx, retry.model, "把卡住的那个重试一下", { messageId: 1001 });
    const retryRow = ctx.store.topicMessages.filter((m) => m.role === "assistant").at(-1)!;
    expect(await tap(ctx, retryRow.messageId!)).toEqual({ text: "已执行 /retry" });
    expect(ctx.telegram.sent.at(-1)!.message).toMatchObject({
      html: "没有找到匹配 <code>ab12cd34</code> 的进行中请求。",
      threadId: 501,
    });
    expect(ctx.store.events.filter((e) => e.type === "assistant.suggestion_run")).toHaveLength(2);
  });
});
