import type { ConversationCallbacks, ConversationForwardOrigin } from "@cos-tool-bot/shared";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { BotContext } from "../context.js";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  streamText: streamTextMock,
}));

const runtimes: ReturnType<typeof createAiReplyHandler>[] = [];
beforeEach(() => {
  streamTextMock.mockReset().mockImplementation(() => ({
    textStream: (async function* () {
      yield "answer";
    })(),
    text: Promise.resolve("answer"),
    steps: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    finishReason: Promise.resolve("stop"),
  }));
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy();
});

function history(): ConversationCallbacks {
  return {
    getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
    addMessage: vi.fn(),
    addMessages: vi.fn(),
    upsertUserMessage: vi.fn(),
    triggerCompression: vi.fn(),
    clearHistory: vi.fn(),
  };
}
function runtime(conversation?: ConversationCallbacks, overrides: Partial<AiReplyConfig> = {}) {
  const result = createAiReplyHandler({
    botId: "test",
    apiKey: "key",
    baseURL: "https://example.com/v1",
    model: "model",
    systemPrompt: "system",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: ["sample"],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: { "-100": { chatId: -100, whitelisted: true } },
    adminChatIds: [],
    privateChatWhitelist: [42],
    token: "token",
    conversation,
    ...overrides,
  });
  runtimes.push(result);
  return result;
}
function context(message: Record<string, unknown>, threadId?: number): BotContext {
  return {
    message: {
      message_id: 7,
      ...message,
      ...(threadId === undefined ? {} : { is_topic_message: true, message_thread_id: threadId }),
    },
    chat: { id: -100, type: "supergroup", title: "Test forum", is_forum: threadId !== undefined },
    from: { id: 42, is_bot: false, first_name: "Sender" },
    me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
    api: { getFile: vi.fn(), sendChatAction: vi.fn() },
    replyWithChatAction: vi.fn(),
    resolveWait: vi.fn().mockResolvedValue(20),
    deleteWaiting: vi.fn(),
    directlyReply: vi.fn(),
  } as unknown as BotContext;
}
const media = {
  file_id: "fixture",
  file_unique_id: "fixture",
  duration: 1,
  width: 10,
  height: 10,
  length: 10,
};
const kinds = [
  ["video", "视频"],
  ["animation", "动图"],
  ["audio", "音频"],
  ["voice", "语音"],
  ["video_note", "视频笔记"],
] as const;
const prompt = () => JSON.stringify(streamTextMock.mock.calls.at(-1)?.[0]?.messages);

describe("media context through the AI handler", () => {
  it.each(kinds)(
    "captures captionless %s once and exposes it to the next ring-buffer turn",
    async (kind, label) => {
      const store = history();
      const persistent = runtime(store);
      const ctx = context({ [kind]: media });
      await persistent.handler(ctx, vi.fn());
      expect(store.upsertUserMessage).toHaveBeenCalledOnce();
      expect(store.upsertUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(`[${label}：未解析媒体内容`),
          userId: 42,
        }),
      );
      expect(streamTextMock).not.toHaveBeenCalled();
      const buffered = runtime();
      await buffered.handler(ctx, vi.fn());
      await buffered.handler(context({ message_id: 8, text: "sample 分析一下这个" }), vi.fn());
      expect(prompt()).toContain(`[#7 Sender]: [${label}：未解析媒体内容`);
      expect(ctx.api.getFile).not.toHaveBeenCalled();
    },
  );

  it.each(kinds)(
    "includes %s metadata and caption in a directly triggered request",
    async (kind, label) => {
      const ctx = context({
        [kind]: media,
        caption: "@sample_bot fixture caption",
        caption_entities: [{ type: "mention", offset: 0, length: 11 }],
      });
      const store = history();
      await runtime(store).handler(ctx, vi.fn());
      expect(streamTextMock).toHaveBeenCalledOnce();
      expect(prompt()).toContain(`${label}：未解析媒体内容`);
      expect(prompt().match(/fixture caption/g)).toHaveLength(1);
      expect(ctx.api.getFile).not.toHaveBeenCalled();
      const saved = vi.mocked(store.upsertUserMessage!).mock.calls.at(-1)![0];
      expect(saved.content).toContain(`${label}：未解析媒体内容`);
    },
  );

  it("keeps a captionless private voice message visible without inventing a transcript", async () => {
    const store = history();
    const ctx = context({ voice: media });
    Object.assign(ctx, { chat: { id: 42, type: "private" } });
    await runtime(store).handler(ctx, vi.fn());
    expect(prompt()).toContain("语音：未解析媒体内容");
    expect(store.addMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("语音：未解析媒体内容"),
        }),
      ]),
    );
    expect(ctx.api.getFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      { type: "user", date: 1, sender_user: { id: 50, first_name: "Original", is_bot: false } },
      "user",
    ],
    [{ type: "hidden_user", date: 1, sender_user_name: "Original" }, "hidden user"],
    [
      {
        type: "chat",
        date: 1,
        sender_chat: { id: -200, type: "supergroup", title: "Original" },
        author_signature: "Editor",
      },
      "chat",
    ],
    [
      {
        type: "channel",
        date: 1,
        chat: { id: -200, type: "channel", title: "Original" },
        message_id: 1,
        author_signature: "Editor",
      },
      "channel",
    ],
  ])(
    "keeps forward origin %j separate from the current sender across persisted history",
    async (origin, label) => {
      const store = history();
      const first = runtime(store);
      await first.handler(
        context({
          video: media,
          caption: "clip notes https://example.com/clip",
          forward_origin: origin,
        }),
        vi.fn(),
      );
      const row = vi.mocked(store.upsertUserMessage!).mock.calls[0]![0];
      expect(row).toMatchObject({ userName: "Sender", userId: 42, userAuthoredContent: undefined });
      expect(row.content.match(/clip notes/g)).toHaveLength(1);
      vi.mocked(store.getHistory).mockResolvedValue({
        summary: null,
        messages: [
          {
            role: "user",
            content: row.content,
            userName: row.userName ?? null,
            tgMessageId: 7,
            forwardOrigin: row.meta?.forwardOrigin as ConversationForwardOrigin,
          },
        ],
      });
      // A fresh runtime has no ring buffer: this exercises actual history assembly.
      await runtime(store).handler(
        context({ message_id: 8, text: "sample 分析一下这个" }),
        vi.fn(),
      );
      expect(prompt()).toContain(`#7 Sender`);
      expect(prompt()).toContain(`[Forwarded from ${label}: Original`);
      expect(prompt()).toContain("clip notes https://example.com/clip");
      expect(prompt()).toContain("未解析媒体内容");
    },
  );

  it.each(["mention", "reply"])(
    "uses existing %s triggers on media captions without duplicate content",
    async (trigger) => {
      const store = history();
      const ctx = context({
        animation: media,
        document: { ...media, file_name: "clip.mp4" },
        caption: trigger === "mention" ? "@sample_bot clip notes" : "clip notes",
        caption_entities: trigger === "mention" ? [{ type: "mention", offset: 0, length: 11 }] : [],
      });
      if (trigger === "reply")
        Object.assign(ctx, {
          reply_to_message: {
            message_id: 6,
            from: { id: 99, is_bot: true, first_name: "Ai" },
            text: "send a clip",
          },
        });
      if (trigger === "reply")
        Object.assign(ctx.message!, { reply_to_message: ctx.reply_to_message });
      await runtime(store).handler(ctx, vi.fn());
      expect(streamTextMock).toHaveBeenCalledOnce();
      expect(prompt().match(/clip notes/g)).toHaveLength(1);
      expect(prompt()).toContain("动图：未解析媒体内容");
      expect(prompt()).not.toContain("clip.mp4");
      expect(ctx.api.getFile).not.toHaveBeenCalled();
      expect(store.addMessage).not.toHaveBeenCalled();
      const rows = vi.mocked(store.upsertUserMessage!).mock.calls.map(([row]) => row);
      expect(new Set(rows.map((row) => row.sourceKey)).size).toBe(1);
    },
  );

  it.each(kinds)(
    "preserves %s metadata with a selected forwarded-caption quote",
    async (kind, label) => {
      const store = history();
      const reply = {
        message_id: 6,
        from: { id: 55, first_name: "Forwarder", is_bot: false },
        [kind]: media,
        caption: "unselected opening. Selected caption片段🙂. unselected ending.",
        forward_origin: { type: "hidden_user", date: 1, sender_user_name: "Original" },
      };
      const ctx = context({
        text: "sample explain this part",
        quote: { text: "Selected caption片段🙂", position: 20 },
        reply_to_message: reply,
      });
      Object.assign(ctx, { reply_to_message: reply });
      await runtime(store).handler(ctx, vi.fn());
      expect(prompt()).toContain("局部引用");
      expect(prompt()).toContain("Selected caption片段🙂");
      expect(prompt()).toContain(`${label}：未解析媒体内容`);
      expect(prompt()).not.toContain("unselected opening");
      expect(prompt()).not.toContain("unselected ending");
      expect(ctx.api.getFile).not.toHaveBeenCalled();
      for (const [row] of vi.mocked(store.upsertUserMessage!).mock.calls) {
        expect(row.content).toContain("局部引用");
        expect(row.content).toContain(`${label}：未解析媒体内容`);
        expect(row.userId).toBe(42);
      }
    },
  );

  it("does not duplicate the legacy add-only history row on a triggered media turn", async () => {
    const store = history();
    delete store.upsertUserMessage;
    await runtime(store).handler(context({ video: media, caption: "sample clip notes" }), vi.fn());
    expect(store.addMessage).toHaveBeenCalledOnce();
  });

  it("isolates ring-buffer media by forum topic and scopes persistent history reads", async () => {
    const buffered = runtime();
    await buffered.handler(context({ video: media, caption: "other-topic-marker" }, 10), vi.fn());
    await buffered.handler(context({ message_id: 8, text: "sample analyze" }, 20), vi.fn());
    expect(prompt()).not.toContain("other-topic-marker");
    const store = history();
    await runtime(store).handler(context({ message_id: 9, text: "sample analyze" }, 20), vi.fn());
    expect(store.getHistory).toHaveBeenCalledWith(
      -100,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ threadId: 20 }),
    );
  });

  it("retains public media without personalization in off mode and rejects unauthorized chats", async () => {
    const store = history();
    const handler = runtime(store, {
      privacy: {
        getMode: vi.fn().mockResolvedValue("off"),
        runExclusive: async (_id, operation) => operation(),
        setMode: vi.fn(),
        forget: vi.fn(),
      },
    });
    await handler.handler(context({ voice: media, caption: "sample ambient caption" }), vi.fn());
    expect(store.upsertUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userAuthoredContent: undefined,
        content: expect.stringContaining("ambient caption"),
      }),
    );
    expect(streamTextMock).not.toHaveBeenCalled();
    const denied = context({ video: media });
    Object.assign(denied, { chat: { id: -999, type: "supergroup" } });
    await handler.handler(denied, vi.fn());
    expect(store.upsertUserMessage).toHaveBeenCalledOnce();
  });

  it.each([
    [{ photo: [media] }, "[图片]"],
    [{ document: { ...media, file_name: "fixture.txt" } }, "[文件: fixture.txt]"],
    [
      { sticker: { ...media, type: "regular", is_animated: false, is_video: false, emoji: "🙂" } },
      "贴纸",
    ],
  ])("preserves existing attachment capture: %j", async (attachment, expected) => {
    const store = history();
    await runtime(store).handler(context({ ...attachment, caption: "fixture caption" }), vi.fn());
    expect(store.upsertUserMessage).toHaveBeenCalledOnce();
    const content = vi.mocked(store.upsertUserMessage!).mock.calls[0]![0].content;
    expect(content).toContain(expected);
    expect(content.match(/fixture caption/g)).toHaveLength(1);
  });
});
