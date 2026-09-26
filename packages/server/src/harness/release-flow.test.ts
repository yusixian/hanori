import { describe, expect, it, vi } from "vitest";
import { RELEASE_STATES } from "./release-card.js";
import { RELEASE_TYPE } from "./release-flow.js";
import { mergedPull } from "./release-test-fakes.js";
import {
  FakeGitHub,
  TEST_CHAT_ID,
  TEST_OWNER,
  TEST_REPO,
  createTestService,
} from "./test-fakes.js";

const HEAD = "b".repeat(40);
const THREAD = 501;

async function setup() {
  let now = new Date("2026-09-24T12:00:00Z");
  const github = new FakeGitHub();
  github.releases.tags = [{ name: "v0.17.0", sha: "1".repeat(40) }];
  github.releases.commits = [
    { sha: "3".repeat(40), message: "fix(ui): align (#11)" },
    { sha: "4".repeat(40), message: "feat(harness): add /release (#12)" },
  ];
  github.releases.pullsByCommit["4".repeat(40)] = mergedPull(12, "feat(harness): add /release");
  github.repoFiles = {
    ".github/workflows/release.yml": 'on:\n  push:\n    tags: ["v*"]\n',
  };
  const ctx = await createTestService({ github, now: () => now });
  return {
    ...ctx,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function release(ctx: Ctx, args = "", options: { threadId?: number; userId?: number } = {}) {
  return ctx.port.handleCommand({
    command: "release",
    args,
    chatId: TEST_CHAT_ID,
    threadId: "threadId" in options ? options.threadId : THREAD,
    userId: options.userId ?? TEST_OWNER,
    messageId: 30,
  });
}

function releaseRequest(ctx: Ctx) {
  return [...ctx.store.requests.values()].filter((request) => request.type === RELEASE_TYPE);
}

function cardMessageId(ctx: Ctx) {
  return releaseRequest(ctx).at(-1)!.cardMessageId!;
}

/** The release card as last sent or edited, ignoring other messages in the topic. */
function card(ctx: Ctx) {
  const id = cardMessageId(ctx);
  const edited = ctx.telegram.edits.filter((edit) => edit.messageId === id).at(-1);
  return (edited ?? ctx.telegram.sent.find((sent) => sent.messageId === id))!.message;
}

function buttonData(ctx: Ctx, label: string) {
  return card(ctx)
    .keyboard?.flat()
    .find((button) => button.text.startsWith(label))?.callbackData;
}

function press(ctx: Ctx, label: string, options: { userId?: number; messageId?: number } = {}) {
  const data = buttonData(ctx, label);
  if (!data) throw new Error(`button ${label} not found`);
  return ctx.port.handleCallback({
    data,
    chatId: TEST_CHAT_ID,
    threadId: THREAD,
    messageId: options.messageId ?? cardMessageId(ctx),
    userId: options.userId ?? TEST_OWNER,
  });
}

const labels = (ctx: Ctx) =>
  card(ctx)
    .keyboard!.flat()
    .map((button) => button.text);

describe("/release", () => {
  it("is owner-only and needs a project topic", async () => {
    const ctx = await setup();
    expect((await release(ctx, "", { userId: 7 })).html).toBe("无权限");
    expect((await release(ctx, "", { threadId: undefined })).html).toBe(
      "请在项目话题中使用 /release",
    );
    expect((await release(ctx, "soon")).html).toContain("用法：/release");
    expect(releaseRequest(ctx)).toHaveLength(0);
  });

  it("posts the plan card in the project topic and records ids and versions only", async () => {
    const ctx = await setup();
    expect((await release(ctx)).html).toBe("");
    const sent = ctx.telegram.sent.at(-1)!.message;
    expect(sent.threadId).toBe(THREAD);
    expect(sent.replyToMessageId).toBe(30);
    expect(sent.html).toContain("版本：v0.17.0 → <b>v0.18.0</b>（minor · 最高改动 feat）");
    expect(sent.html).toContain("发版 workflow：release.yml（push tags: v*）");
    expect(labels(ctx)).toEqual(["📝 准备发版", "🏷 确认发布", "🔄 刷新", "✖️ 取消"]);
    const [request] = releaseRequest(ctx);
    expect(request).toMatchObject({
      state: RELEASE_STATES.planned,
      headSha: HEAD,
      title: "v0.18.0",
      threadId: THREAD,
    });
    const planned = ctx.store.events.find((event) => event.type === "release.planned");
    expect(planned?.payload).toEqual({
      version: "0.18.0",
      tag: "v0.18.0",
      sha: HEAD,
      previous: "v0.17.0",
      bump: "minor",
    });
  });

  it("retires an older plan of the same project", async () => {
    const ctx = await setup();
    await release(ctx);
    await release(ctx, "patch");
    const [first, second] = releaseRequest(ctx);
    expect(first!.state).toBe(RELEASE_STATES.cancelled);
    expect(second).toMatchObject({ state: RELEASE_STATES.planned, title: "v0.17.1" });
  });
});

describe("release card buttons", () => {
  it("does not claim success when an ambiguous tag creation finds a different commit", async () => {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "🏷");
    vi.spyOn(ctx.github.releases, "createTag").mockImplementation(async (_repo, input) => {
      ctx.github.releases.tags.push({ name: input.tag, sha: "d".repeat(40) });
      throw new Error("The operation was aborted due to timeout");
    });
    expect((await press(ctx, "✅ 确认打 tag")).text).toContain("创建 tag 失败");
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.planned);
    expect(ctx.store.events.some((event) => event.type === "release.tagged")).toBe(false);
  });

  it("dispatches the preparation as a /task once it is accepted", async () => {
    const ctx = await setup();
    await release(ctx);
    const spy = vi
      .spyOn(ctx.service.port, "handleCommand")
      .mockResolvedValueOnce({ html: "执行层不可用" })
      .mockResolvedValue({ html: "" });
    expect(await press(ctx, "📝")).toEqual({ text: "准备任务未派发，见话题中的回复" });
    expect(ctx.telegram.sent.at(-1)!.message).toMatchObject({
      html: "执行层不可用",
      threadId: THREAD,
      replyToMessageId: cardMessageId(ctx),
    });
    expect(await press(ctx, "📝")).toEqual({ text: "已派发准备任务" });
    expect(spy).toHaveBeenCalledTimes(2);
    const call = spy.mock.calls[0]![0];
    expect(call).toMatchObject({
      command: "task",
      chatId: TEST_CHAT_ID,
      threadId: THREAD,
      userId: TEST_OWNER,
      messageId: cardMessageId(ctx),
    });
    expect(call.args).toContain("titled `chore(release): v0.18.0`");
    expect(call.args).toContain("Do not create or push any git tag");
    expect(card(ctx).html).toContain("已派发准备任务");

    expect(await press(ctx, "📝")).toEqual({ text: "准备任务已派发" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ctx.store.events.filter((e) => e.type === "release.prep_dispatched")).toHaveLength(1);
  });

  it("creates a real /task request without an issue when preparing", async () => {
    const ctx = await setup();
    await release(ctx);
    expect(await press(ctx, "📝")).toEqual({ text: "已派发准备任务" });
    const tasks = [...ctx.store.requests.values()].filter((request) => request.type === "task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ issueNumber: null, projectKey: "sandbox" });
    expect(tasks[0]!.title).toContain("v0.18.0");
    expect(ctx.github.issues).toEqual([]);
  });

  it("tags the planned commit once after the two-step confirmation", async () => {
    const ctx = await setup();
    await release(ctx);
    expect(await press(ctx, "🏷")).toEqual({ text: "请核对 tag 与提交后确认" });
    expect(card(ctx).html).toContain(`提交：<code>${HEAD}</code>`);
    expect(labels(ctx)).toEqual(["✅ 确认打 tag", "返回"]);
    const confirm = buttonData(ctx, "✅ 确认打 tag")!;

    expect(await press(ctx, "✅ 确认打 tag")).toEqual({ text: "已创建 tag v0.18.0" });
    expect(ctx.github.releases.created).toEqual([
      { tag: "v0.18.0", sha: HEAD, message: "Release v0.18.0" },
    ]);
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.building);
    expect(card(ctx).html).toContain("<b>🟡 构建中 · sandbox v0.18.0</b>");
    expect(labels(ctx)).toEqual(["🔗 Actions", "🔄 刷新"]);

    const again = await ctx.port.handleCallback({
      data: confirm,
      chatId: TEST_CHAT_ID,
      threadId: THREAD,
      messageId: cardMessageId(ctx),
      userId: TEST_OWNER,
    });
    expect(again.text).toBe("该操作已处理");
    expect(ctx.github.releases.created).toHaveLength(1);
    const tagged = ctx.store.events.find((event) => event.type === "release.tagged");
    expect(tagged?.payload).toEqual({
      version: "0.18.0",
      tag: "v0.18.0",
      sha: HEAD,
      tagObject: "f".repeat(40),
      previous: "v0.17.0",
    });
  });

  it("refreshes instead of tagging when the default branch moved", async () => {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "🏷");
    const stale = buttonData(ctx, "✅ 确认打 tag")!;
    ctx.github.defaultSha = "c".repeat(40);
    const answer = await press(ctx, "✅ 确认打 tag");
    expect(answer).toEqual({ text: "默认分支已更新，卡片已刷新，请重新确认", alert: true });
    expect(ctx.github.releases.created).toHaveLength(0);
    expect(releaseRequest(ctx)[0]).toMatchObject({
      state: RELEASE_STATES.planned,
      headSha: "c".repeat(40),
    });
    expect(card(ctx).html).toContain("main 已前进到 ccccccc");
    expect(labels(ctx)).toContain("🏷 确认发布");

    const old = await ctx.port.handleCallback({
      data: stale,
      chatId: TEST_CHAT_ID,
      threadId: THREAD,
      messageId: cardMessageId(ctx),
      userId: TEST_OWNER,
    });
    expect(old.text).toBe("发版计划已变化，旧按钮已失效");
    expect(ctx.github.releases.created).toHaveLength(0);
  });

  it("refuses to tag after preparing until the release PR is on the default branch", async () => {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "📝");
    const pending = {
      text: "发版 PR 还没有合入默认分支：合并后点「刷新」再确认；不需要准备 PR 时取消后重新 /release",
      alert: true,
    };
    expect(await press(ctx, "🏷")).toEqual(pending);
    expect(labels(ctx)).toContain("🏷 确认发布");

    const merged = "c".repeat(40);
    ctx.github.defaultSha = merged;
    ctx.github.releases.commits.push({
      sha: "5".repeat(40),
      message: "chore(release): v0.18.0 (#13)",
    });
    expect(await press(ctx, "🔄")).toEqual({ text: "已刷新" });
    expect(await press(ctx, "🏷")).toEqual({ text: "请核对 tag 与提交后确认" });
    expect(await press(ctx, "✅ 确认打 tag")).toEqual({ text: "已创建 tag v0.18.0" });
    expect(ctx.github.releases.created).toEqual([
      { tag: "v0.18.0", sha: merged, message: "Release v0.18.0" },
    ]);
  });

  it("treats a tag whose creation timed out after landing as created", async () => {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "🏷");
    ctx.github.releases.createTag = async (_repo, input) => {
      ctx.github.releases.tags.unshift({ name: input.tag, sha: input.sha });
      throw new Error("The operation was aborted due to timeout");
    };
    expect(await press(ctx, "✅ 确认打 tag")).toEqual({ text: "已创建 tag v0.18.0" });
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.building);
    const tagged = ctx.store.events.find((event) => event.type === "release.tagged");
    expect(tagged?.payload).toMatchObject({ tag: "v0.18.0", tagObject: null });
  });

  it("refuses to tag when the tag already exists", async () => {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "🏷");
    ctx.github.releases.tags.unshift({ name: "v0.18.0", sha: "9".repeat(40) });
    expect(await press(ctx, "✅ 确认打 tag")).toEqual({
      text: "tag v0.18.0 已存在，未创建",
      alert: true,
    });
    expect(ctx.github.releases.created).toHaveLength(0);
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.planned);
    expect(card(ctx).html).toContain("tag v0.18.0 已存在，未重复创建");
  });

  it("checks the owner and the card on every button", async () => {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "🏷");
    expect(await press(ctx, "✅ 确认打 tag", { userId: 7 })).toEqual({ text: "无权限" });
    expect(await press(ctx, "✅ 确认打 tag", { messageId: 9999 })).toEqual({
      text: "按钮已失效",
    });
    expect(ctx.github.releases.created).toHaveLength(0);
  });

  it("goes back from the confirmation and cancels the plan", async () => {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "🏷");
    expect(await press(ctx, "返回")).toEqual({ text: "已返回" });
    expect(labels(ctx)).toEqual(["📝 准备发版", "🏷 确认发布", "🔄 刷新", "✖️ 取消"]);
    expect(await press(ctx, "✖️ 取消")).toEqual({ text: "已取消" });
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.cancelled);
    expect(card(ctx).html).toContain("⚫ 已取消");
    expect(card(ctx).keyboard).toEqual([]);
  });
});

describe("release tracking", () => {
  async function tagged() {
    const ctx = await setup();
    await release(ctx);
    await press(ctx, "🏷");
    await press(ctx, "✅ 确认打 tag");
    return ctx;
  }

  const run = (status: string, conclusion: string | null) => ({
    id: 77,
    name: "Release",
    path: ".github/workflows/release.yml",
    headBranch: "v0.18.0",
    event: "push",
    status,
    conclusion,
    url: `https://github.com/${TEST_REPO}/actions/runs/77`,
    updatedAt: "2026-09-24T12:03:00Z",
  });

  it("follows the tag's run to a published release through the scheduler", async () => {
    const ctx = await tagged();
    ctx.github.releases.runs = [run("in_progress", null)];
    await ctx.service.releases.poll();
    expect(card(ctx).html).toContain("构建：等待 workflow 启动");

    ctx.advance(31_000);
    await ctx.service.work.scheduler.tick();
    expect(card(ctx).html).toContain("构建：<a href=");
    expect(card(ctx).html).toContain("in_progress");
    expect(labels(ctx)).toEqual(["🔗 构建", "🔄 刷新"]);

    ctx.github.releases.runs = [run("completed", "success")];
    ctx.github.releases.releases = [
      {
        tag: "v0.18.0",
        url: `https://github.com/${TEST_REPO}/releases/tag/v0.18.0`,
        draft: false,
        prerelease: false,
      },
    ];
    ctx.advance(31_000);
    await ctx.service.releases.poll();
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.published);
    expect(card(ctx).html).toContain("<b>✅ 已发布 · sandbox v0.18.0</b>");
    expect(labels(ctx)).toEqual(["🔗 Release", "🔗 构建"]);
    expect(ctx.store.events.some((event) => event.type === "release.published")).toBe(true);

    ctx.advance(31_000);
    await ctx.service.releases.poll();
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.published);
  });

  it("shows a failed run and lets a refresh pick up a rerun", async () => {
    const ctx = await tagged();
    ctx.github.releases.runs = [run("completed", "failure")];
    ctx.advance(31_000);
    await ctx.service.releases.poll();
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.failed);
    expect(card(ctx).html).toContain("<b>❌ 构建失败 · sandbox v0.18.0</b>");
    expect(labels(ctx)).toEqual(["🔗 构建", "🔄 刷新"]);

    ctx.github.releases.runs = [run("in_progress", null)];
    expect(await press(ctx, "🔄")).toEqual({ text: "已刷新" });
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.building);
  });

  it("falls back to watching the Release when Actions cannot be read", async () => {
    const ctx = await tagged();
    ctx.github.releases.runs = null;
    ctx.advance(31_000);
    await ctx.service.releases.poll();
    expect(card(ctx).html).toContain("无 Actions 读权限");
    expect(labels(ctx)).toEqual(["🔗 Actions", "🔄 刷新"]);

    ctx.advance(2 * 60 * 60_000);
    await ctx.service.releases.poll();
    expect(releaseRequest(ctx)[0]!.state).toBe(RELEASE_STATES.timedOut);
    expect(card(ctx).html).toContain("⏱ 跟踪超时");
  });
});
