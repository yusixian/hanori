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
const extraContent = [
  [
    "story",
    { chat: { id: -200, type: "channel", title: "Source", username: "source" }, id: 12 },
    "Story",
    "Source",
  ],
  ["paid_media", { star_count: 20, paid_media: [{ type: "preview" }] }, "付费媒体", "20"],
  [
    "poll",
    {
      question: "Pick a route",
      options: [{ text: "Scenic https://example.com/route", voter_count: 2 }],
      total_voter_count: 2,
      is_closed: false,
    },
    "投票",
    "Scenic https://example.com/route",
  ],
  [
    "contact",
    {
      first_name: "Example",
      last_name: "Person",
      phone_number: "+1234567",
      vcard: "private-vcard",
    },
    "联系人",
    "+1234567",
  ],
  ["location", { latitude: 30, longitude: 120, live_period: 3600 }, "位置", "30, 120"],
  [
    "venue",
    { title: "Library", address: "Example road", location: { latitude: 30, longitude: 120 } },
    "地点",
    "Example road",
  ],
  ["dice", { emoji: "🎲", value: 4 }, "骰子", "4"],
  [
    "game",
    { title: "Game title", description: "Game description", text: "https://example.com/game" },
    "游戏",
    "https://example.com/game",
  ],
  [
    "checklist",
    { title: "Packing", tasks: [{ id: 1, text: "Camera", completion_date: 0 }] },
    "清单",
    "Camera",
  ],
  [
    "rich_message",
    {
      blocks: [
        {
          type: "paragraph",
          text: { type: "url", text: "Useful resource", url: "https://example.com/rich" },
        },
      ],
    },
    "富文本",
    "https://example.com/rich",
  ],
  ["live_photo", { ...media }, "实况照片", "未解析"],
] as const;
const prompt = () => JSON.stringify(streamTextMock.mock.calls.at(-1)?.[0]?.messages);

describe("media context through the AI handler", () => {
  it.each(extraContent)(
    "retains %s through persistence, ring buffer and a direct request",
    async (kind, value, label, detail) => {
      const store = history();
      const message = {
        [kind]: value,
        forward_origin: { type: "hidden_user", date: 1, sender_user_name: "Origin" },
      };
      await runtime(store).handler(context(message), vi.fn());
      expect(store.upsertUserMessage).toHaveBeenCalledOnce();
      const row = vi.mocked(store.upsertUserMessage!).mock.calls[0]![0];
      expect(row.content).toContain(label);
      expect(row.content).toContain(detail);
      expect(row.meta?.forwardOrigin).toMatchObject({ name: "Origin" });
      const buffered = runtime();
      await buffered.handler(context(message), vi.fn());
      await buffered.handler(
        context({ message_id: 8, text: "sample explain the previous message" }),
        vi.fn(),
      );
      expect(prompt()).toContain(detail);
      expect(prompt()).toContain("Origin");
      const direct = context(message);
      Object.assign(direct, { chat: { id: 42, type: "private" } });
      await runtime().handler(direct, vi.fn());
      expect(prompt()).toContain(detail);
      expect(direct.api.getFile).not.toHaveBeenCalled();
      expect(prompt()).not.toContain("private-vcard");
    },
  );

  it.each(extraContent)("keeps %s visible in reply context", async (kind, value, label) => {
    const reply = {
      message_id: 6,
      from: { id: 55, first_name: "Original", is_bot: false },
      [kind]: value,
    };
    const ctx = context({ text: "sample explain this", reply_to_message: reply });
    Object.assign(ctx, { reply_to_message: reply });
    await runtime().handler(ctx, vi.fn());
    expect(prompt()).toContain(label);
  });

  it.each([
    { new_chat_title: "changed" },
    { checklist_tasks_added: { tasks: [{ text: "private service text" }] } },
    { successful_payment: { currency: "XTR", total_amount: 20 } },
  ])("does not admit service events: %j", async (message) => {
    const store = history();
    await runtime(store).handler(context(message), vi.fn());
    expect(store.upsertUserMessage).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it.each([
    { rich_message: { blocks: [{ type: "paragraph", text: "sample rich request" }] } },
    {
      poll: {
        question: "sample poll request",
        options: [],
        total_voter_count: 0,
        is_closed: false,
      },
    },
    { checklist: { title: "sample checklist request", tasks: [] } },
  ])("uses visible text to trigger a group request without duplicating it: %j", async (message) => {
    const ctx = context(message);
    await runtime().handler(ctx, vi.fn());
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(prompt().match(/sample (rich|poll|checklist) request/g)).toHaveLength(1);
  });

  it("keeps static-photo processing for live photos and describes the unparsed motion", async () => {
    const ctx = context({ live_photo: media, photo: [{ ...media }], caption: "sample live" });
    vi.mocked(ctx.api.getFile).mockResolvedValue({ file_id: "fixture", file_unique_id: "fixture" });
    await runtime().handler(ctx, vi.fn());
    expect(prompt()).toContain("动态部分未解析");
    expect(prompt()).toContain("图片");
    expect(ctx.api.getFile).toHaveBeenCalledWith("fixture");
  });

  it("preserves a selected rich-text quote without repeating the unselected body", async () => {
    const reply = {
      message_id: 6,
      from: { id: 55, first_name: "Source", is_bot: false },
      rich_message: { blocks: [{ type: "paragraph", text: "Unselected text. Selected text." }] },
    };
    const ctx = context({
      text: "sample explain",
      reply_to_message: reply,
      quote: { text: "Selected text.", position: 17 },
    });
    Object.assign(ctx, { reply_to_message: reply });
    const store = history();
    await runtime(store).handler(ctx, vi.fn());
    expect(prompt()).toContain("Selected text.");
    expect(prompt()).toContain("富文本消息");
    expect(prompt()).not.toContain("Unselected text.");
    expect(vi.mocked(store.upsertUserMessage!).mock.calls[0]![0].content).not.toContain(
      "Unselected text.",
    );
  });

  it("applies existing privacy and chat access rules to newly admitted contacts", async () => {
    const store = history();
    const handler = runtime(store, {
      privacy: {
        getMode: vi.fn().mockResolvedValue("off"),
        runExclusive: async (_id, operation) => operation(),
        setMode: vi.fn(),
        forget: vi.fn(),
      },
    });
    await handler.handler(
      context({ contact: { first_name: "Example", phone_number: "+1234" } }),
      vi.fn(),
    );
    expect(store.upsertUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userAuthoredContent: undefined,
        content: expect.stringContaining("+1234"),
      }),
    );
    expect(streamTextMock).not.toHaveBeenCalled();
    const denied = context({ contact: { first_name: "Example", phone_number: "denied-phone" } });
    Object.assign(denied, { chat: { id: -999, type: "supergroup" } });
    await handler.handler(denied, vi.fn());
    expect(store.upsertUserMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(store.upsertUserMessage!).mock.calls)).not.toContain(
      "denied-phone",
    );
  });

  it.each([
    [{ video: media }, "视频"],
    [{ story: { chat: { id: -200, type: "channel", title: "sample" }, id: 1 } }, "sample"],
    [{ rich_message: { blocks: [{ type: "photo", photo: [media] }] } }, "未解析"],
  ])("does not trigger on generated metadata or source labels: %j", async (message, word) => {
    await runtime(undefined, {
      triggerConfig: {
        replyToBot: true,
        mentionBot: true,
        triggerWords: [word],
        randomReplyPercent: 0,
        randomReplyCooldown: 60,
      },
    }).handler(context(message), vi.fn());
    expect(streamTextMock).not.toHaveBeenCalled();
  });

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
