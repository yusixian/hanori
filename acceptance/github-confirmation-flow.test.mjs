import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiReplyHandler } from "../packages/bot/src/handlers/ai-reply.ts";
import { createGitHubIssueProposalCallbackHandler } from "../packages/bot/src/services/github-issue-confirmation.ts";
import { GitHubIssueProposalService } from "../packages/server/src/services/github-issue-proposals.ts";
const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));
// Resolve the SDK from the Bot workspace; the monorepo root does not depend on it.
vi.mock("../packages/bot/node_modules/ai", async (original) => ({
  ...(await original()),
  streamText: streamTextMock,
}));
const BOT = "00000000-0000-4000-8000-000000000001";
const config = {
  enabled: true,
  publicReadEnabled: true,
  codingAgentEnabled: false,
  authorName: "Bot",
  authorEmail: "bot@example.test",
  repositories: ["owner/repo"],
};
const runtimes = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
  vi.clearAllMocks();
});
function setup(isTopic) {
  const values = new Map();
  const store = {
    async insert(bot, id, value) {
      values.set(`${bot}:${id}`, value);
    },
    async get(bot, id) {
      return values.get(`${bot}:${id}`);
    },
    async list(bot) {
      return [...values].filter(([key]) => key.startsWith(`${bot}:`)).map(([, value]) => value);
    },
    async compareExchange(bot, id, previous, next) {
      const key = `${bot}:${id}`;
      if (values.get(key) !== previous) return false;
      values.set(key, next);
      return true;
    },
  };
  const current = { admins: [7, 8] };
  const authorize = vi.fn(async (bot, user) => {
    if (bot !== BOT || !current.admins.includes(user))
      throw new Error("current authorization denied");
    return { config, token: "fixture-only" };
  });
  const fetchMock = vi.fn(
    async (_url, init) =>
      new Response(
        JSON.stringify({
          ...JSON.parse(String(init?.body)),
          number: 42,
          html_url: "https://github.com/owner/repo/issues/42",
        }),
      ),
  );
  const port = new GitHubIssueProposalService(store, authorize, fetchMock).forBot(BOT);
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 20 }),
    sendChatAction: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
  };
  const runtime = createAiReplyHandler({
    botId: BOT,
    apiKey: "fixture-only",
    baseURL: "https://example.test/v1",
    model: "model",
    systemPrompt: "system",
    token: "fixture-only",
    adminChatIds: [7],
    groupOverrides: { "-100": { chatId: -100, whitelisted: true } },
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: ["issue"],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    githubToolsConfig: { ...config, token: "fixture-only" },
    githubIssueProposals: port,
    messageConfig: {
      replyMode: "segment",
      richMessageEnabled: false,
      autoSplitThreshold: 0,
      splitDelayMs: 0,
    },
  });
  runtimes.push(runtime);
  let messageId = 100;
  async function turn(name, input, threadId) {
    let output;
    streamTextMock.mockImplementation(({ tools }) => ({
      textStream: (async function* () {
        const execute = tools[name]?.execute;
        if (!execute) throw new Error(`Missing tool: ${name}`);
        output = await execute(input, { toolCallId: "fixture", messages: [] });
        yield "done";
      })(),
      text: Promise.resolve("done"),
      steps: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("stop"),
    }));
    await runtime.handler(
      {
        update: { update_id: messageId },
        message: {
          message_id: messageId++,
          text: "issue",
          entities: [],
          message_thread_id: threadId,
          ...(isTopic ? { is_topic_message: true } : {}),
        },
        chat: { id: -100, type: "supergroup", ...(isTopic ? { is_forum: true } : {}) },
        from: { id: 7, is_bot: false, first_name: "Tester" },
        me: { id: 99, is_bot: true, first_name: "Bot", username: "test_bot" },
        api,
        replyWithChatAction: vi.fn().mockResolvedValue(true),
        wait: vi.fn().mockResolvedValue(10),
        deleteWaiting: vi.fn(),
        resolveWait: vi.fn().mockResolvedValue(10),
        directlyReply: vi.fn(),
      },
      vi.fn(),
    );
    expect(output).toBeDefined();
    return output;
  }
  async function propose() {
    const output = await turn(
      "github_create_issue",
      { repository: "owner/repo", title: "Title", body: "Body" },
      182311,
    );
    expect(output).toMatchObject({ pending_confirmation: true, action_id: expect.any(String) });
    return output.action_id;
  }
  const handler = createGitHubIssueProposalCallbackHandler(api, port);
  async function click(id, threadId, button = "yes", userId = 7, chatId = -100) {
    await handler({
      callbackQuery: {
        id: "query",
        data: `cos:ghi:${id}:${button}`,
        from: { id: userId },
        message: {
          chat: { id: chatId },
          message_id: 20,
          message_thread_id: threadId,
          ...(isTopic ? { is_topic_message: true } : {}),
        },
      },
    });
  }
  return { api, port, fetchMock, current, turn, propose, click };
}
describe("GitHub Issue confirmation through Telegram AI turns", () => {
  it.each([undefined, 182322])(
    "confirms an ordinary-group card when its reply thread is %s",
    async (callbackThread) => {
      const s = setup(false);
      const id = await s.propose();
      await s.click(id, callbackThread);
      expect(s.fetchMock).toHaveBeenCalledOnce();
      expect(s.api.editMessageText).toHaveBeenCalledWith(
        -100,
        20,
        expect.stringContaining("已创建"),
        expect.any(Object),
      );
      expect(s.api.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("message_thread_id");
      await s.click(id, callbackThread);
      expect(s.fetchMock).toHaveBeenCalledOnce();
    },
  );
  it("lists and cancels the original ordinary-group proposal from another reply chain", async () => {
    const s = setup(false);
    const id = await s.propose();
    expect(await s.turn("github_pending_issue_proposals", {}, 182322)).toMatchObject({
      proposals: [{ id }],
      cards_sent: 1,
    });
    expect(await s.turn("github_cancel_issue_proposal", { proposal_id: id }, 182333)).toEqual({
      proposal_id: id,
      status: "cancelled",
    });
    await s.click(id);
    expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it("keeps actual forum topics isolated for listing, cancellation and confirmation", async () => {
    const s = setup(true);
    const id = await s.propose();
    expect(s.api.sendMessage.mock.calls[0]?.[2]).toHaveProperty("message_thread_id", 182311);
    expect(await s.turn("github_pending_issue_proposals", {}, 182322)).toMatchObject({
      proposals: [],
      cards_sent: 0,
    });
    expect(
      await s.turn("github_cancel_issue_proposal", { proposal_id: id }, 182322),
    ).toHaveProperty("error");
    await s.click(id, 182322);
    await s.click(id);
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.api.editMessageText).not.toHaveBeenCalled();
    await s.click(id, 182311);
    expect(s.fetchMock).toHaveBeenCalledOnce();
  });
  it("cancels an ordinary-group proposal through its card in another reply thread", async () => {
    const s = setup(false);
    const id = await s.propose();
    await s.click(id, 182322, "no");
    expect(s.api.editMessageText).toHaveBeenCalledWith(
      -100,
      20,
      expect.stringContaining("已取消"),
      expect.any(Object),
    );
    await s.click(id);
    expect(s.fetchMock).not.toHaveBeenCalled();
  });
  it("does not rewrite or bypass immutable topic bindings on legacy cards", async () => {
    const s = setup(false);
    const legacy = await s.port.propose({
      userId: 7,
      chatId: -100,
      threadId: 182311,
      repository: "owner/repo",
      title: "Legacy",
      body: "Body",
    });
    await s.click(legacy.id);
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.api.editMessageText).not.toHaveBeenCalled();
    expect(s.api.sendMessage).toHaveBeenCalledWith(-100, expect.stringContaining("旧回复串"), {});
    expect(await s.port.list({ userId: 7, chatId: -100, threadId: 182311 })).toEqual([legacy]);
  });
  it("still rejects another administrator, another group and revoked access", async () => {
    const s = setup(false);
    const id = await s.propose();
    await s.click(id, undefined, "yes", 8);
    await s.click(id, undefined, "no", 8);
    await s.click(id, undefined, "yes", 7, -101);
    s.current.admins = [];
    await s.click(id);
    expect(s.fetchMock).not.toHaveBeenCalled();
    expect(s.api.editMessageText).not.toHaveBeenCalled();
  });
});
