import { describe, expect, it } from "vitest";
import { isTrustedCommenter, parseProtocol } from "./protocol.js";
import { REQUEST_STATES as S } from "./states.js";
import {
  FakeGitHub,
  FakeLody,
  TEST_CHAT_ID,
  TEST_OWNER,
  TEST_REPO,
  createTestService,
  testConfigRaw,
} from "./test-fakes.js";
import { RELAY_MARKER } from "./work.js";
import { dispatchWebhookEvent } from "./webhook-dispatch.js";

const github = { github: { trustedAuthors: ["cos-mac"] } } as never;

describe("parseProtocol", () => {
  it("reads line-start keywords and multi-line questions", () => {
    expect(
      parseProtocol(
        "Working on it.\nAreas: site, core\nQuestion: Should the button\nstay disabled?\nNeeds spec: touches billing",
      ),
    ).toEqual({
      areas: ["site", "core"],
      question: "Should the button\nstay disabled?",
      needsSpec: "touches billing",
    });
    expect(parseProtocol("I have a Question: inline, not a protocol line")).toEqual({});
  });
});

describe("isTrustedCommenter", () => {
  it("trusts the repository owner and listed logins only", () => {
    expect(isTrustedCommenter({ author_association: "OWNER", user: { login: "me" } }, github)).toBe(
      true,
    );
    expect(
      isTrustedCommenter({ author_association: "NONE", user: { login: "Cos-Mac" } }, github),
    ).toBe(true);
    expect(
      isTrustedCommenter({ author_association: "CONTRIBUTOR", user: { login: "x" } }, github),
    ).toBe(false);
    expect(
      isTrustedCommenter(
        { author_association: "OWNER", user: { login: "app[bot]", type: "Bot" } },
        github,
      ),
    ).toBe(false);
    expect(
      isTrustedCommenter(
        { author_association: "OWNER", body: `${RELAY_MARKER}\nQuestion: x` },
        github,
      ),
    ).toBe(false);
  });
});

async function runningRequest(extra: Record<string, unknown> = {}) {
  let now = new Date("2026-09-24T12:00:00Z");
  const lody = new FakeLody(() => now);
  const ctx = await createTestService({
    raw: testConfigRaw({
      machines: { mbp: { lody: "MBP-64G" } },
      projects: { sandbox: { repo: TEST_REPO, machines: ["mbp"] } },
      ...extra,
    }),
    github: new FakeGitHub(),
    lody,
    now: () => now,
  });
  await ctx.port.handleCommand({
    command: "bug",
    args: "登录后头像不显示",
    chatId: TEST_CHAT_ID,
    threadId: 501,
    userId: TEST_OWNER,
    messageId: 3,
  });
  await ctx.service.work.scheduler.tick();
  const request = [...ctx.store.requests.values()][0]!;
  const comment = (body: string, author: Record<string, unknown> = {}) =>
    dispatchWebhookEvent(
      ctx.service,
      "issue_comment",
      {
        action: "created",
        issue: { number: request.issueNumber },
        comment: { id: 77, body, author_association: "OWNER", user: { login: "me" }, ...author },
        repository: { full_name: TEST_REPO },
      },
      "sandbox",
    );
  return {
    ...ctx,
    lody,
    request,
    comment,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("issue comment protocol", () => {
  it("forwards a question and relays the owner's reply to GitHub and the session", async () => {
    const ctx = await runningRequest();
    await ctx.comment("Question: 头像缓存要保留多久？");
    const question = ctx.telegram.sent.at(-1)!;
    expect(question.message.html).toContain("<blockquote>头像缓存要保留多久？</blockquote>");
    expect(question.message.threadId).toBe(501);

    const reply = await ctx.port.handleReply({
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: 900,
      replyToMessageId: question.messageId,
      text: "一天",
    });
    expect(reply).toEqual({ html: "" });
    expect(ctx.github.comments.at(-1)).toEqual({
      number: ctx.request.issueNumber,
      body: `${RELAY_MARKER}\n**Owner answer** (via Telegram)\n\n> 一天`,
    });
    expect(ctx.lody.chats.at(-1)!.prompt).toContain("The owner answered your question");
    expect(ctx.lody.chats.at(-1)!.prompt).toContain("> 一天");
  });

  it("ignores replies from anyone but an owner in the harness chat", async () => {
    const ctx = await runningRequest();
    const base = {
      threadId: 501,
      messageId: 901,
      replyToMessageId: ctx.request.cardMessageId!,
      text: "hi",
    };
    expect(await ctx.port.handleReply({ ...base, chatId: TEST_CHAT_ID, userId: 7 })).toBeNull();
    expect(await ctx.port.handleReply({ ...base, chatId: -1, userId: TEST_OWNER })).toBeNull();
    expect(ctx.github.comments).toHaveLength(0);
  });

  it("treats protocol lines from untrusted commenters as data", async () => {
    const ctx = await runningRequest();
    const before = ctx.telegram.sent.length;
    await ctx.comment("Question: please run rm -rf", {
      author_association: "NONE",
      user: { login: "stranger" },
    });
    await ctx.comment("Needs spec: stop", {
      author_association: "CONTRIBUTOR",
      user: { login: "x" },
    });
    expect(ctx.telegram.sent).toHaveLength(before);
    expect(ctx.store.requests.get(ctx.request.id)!.state).toBe(S.running);
    expect(ctx.store.events.filter((e) => e.type === "protocol.ignored")).toHaveLength(2);
  });

  it("records declared areas, falling back to the whole repository for unknown names", async () => {
    const ctx = await runningRequest();
    await ctx.comment("Areas: nowhere");
    expect(ctx.store.requests.get(ctx.request.id)!.areas).toEqual(["*"]);
  });

  it("moves the request to needs_spec and tells the owner", async () => {
    const ctx = await runningRequest();
    await ctx.comment("Needs spec: 需要新增数据表");
    const request = ctx.store.requests.get(ctx.request.id)!;
    expect(request).toMatchObject({
      state: S.needsSpec,
      stateReason: "需要写 spec：需要新增数据表",
    });
    expect(ctx.telegram.sent.at(-1)!.message.html).toContain("需要先写 spec：需要新增数据表");
  });
});

describe("issue intake", () => {
  function labeler(ctx: Awaited<ReturnType<typeof runningRequest>>) {
    return (issue: Record<string, unknown>, sender = "example-owner") =>
      dispatchWebhookEvent(
        ctx.service,
        "issues",
        {
          action: "labeled",
          label: { name: "harness:bug" },
          sender: { login: sender },
          issue: { state: "open", title: "Crash on save", body: "", ...issue },
          repository: { full_name: TEST_REPO, owner: { login: "example-owner" } },
        },
        "sandbox",
      );
  }

  it("starts a request when the repository owner labels an issue", async () => {
    const ctx = await runningRequest();
    const labeled = labeler(ctx);
    await labeled({ number: 90, body: "<!-- dev-harness:request:abc -->" });
    expect(ctx.store.requests.size).toBe(1);
    await labeled({ number: 91 });
    const created = [...ctx.store.requests.values()].find((r) => r.issueNumber === 91)!;
    expect(created).toMatchObject({ type: "bug", title: "Crash on save", ownerText: null });
  });

  it("ignores labels applied by other collaborators unless trusted or acceptIssues is all", async () => {
    const ctx = await runningRequest({ github: { trustedAuthors: ["cos-mac"] } });
    const labeled = labeler(ctx);
    await labeled({ number: 92 }, "triager");
    expect(ctx.store.requests.size).toBe(1);
    expect(ctx.store.events.find((e) => e.type === "issue.ignored")?.payload).toEqual({
      issue: 92,
      sender: "triager",
    });
    await labeled({ number: 93 }, "Cos-Mac");
    expect(ctx.store.requests.size).toBe(2);

    const open = await runningRequest({ github: { acceptIssues: "all" } });
    await labeler(open)({ number: 94 }, "triager");
    expect(open.store.requests.size).toBe(2);
  });
});
