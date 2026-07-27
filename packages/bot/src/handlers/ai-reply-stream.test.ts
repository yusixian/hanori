import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../context.js";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

const { streamTextMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

function sentMessage(messageId: number, text: string): Message.TextMessage {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: 123, type: "private" },
    text,
  } as Message.TextMessage;
}

function createContext() {
  const replies: string[] = [];
  const streamError = new Error("Rich Message content cannot be empty");
  const api = {
    sendRichMessageDraft: vi.fn().mockResolvedValue(true),
    sendPhoto: vi.fn().mockResolvedValue(sentMessage(31, "photo")),
    sendMessage: vi.fn().mockResolvedValue(sentMessage(33, "fallback")),
    sendPoll: vi.fn().mockResolvedValue({ message_id: 32, poll: { id: "poll-1" } }),
    getChat: vi.fn().mockResolvedValue({ id: -100, type: "supergroup", title: "Test" }),
    getChatMemberCount: vi.fn().mockResolvedValue(3),
  } as unknown as Api;
  let ctx!: BotContext;
  ctx = {
    update: { update_id: 42 },
    message: { message_id: 7, text: "hello" },
    chat: { id: 123, type: "private" },
    from: { id: 123, is_bot: false, first_name: "Tester" },
    api,
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    replyWithMarkdownStream: vi.fn(async (stream: AsyncIterable<string>) => {
      let text = "";
      for await (const chunk of stream) text += chunk;
      if (!text.trim()) throw streamError;
      return sentMessage(20, text);
    }),
    deleteWaiting: vi.fn(async () => {
      ctx.waiting_message = undefined;
    }),
    resolveWait: vi.fn(async (text: string) => {
      replies.push(text);
      return 21;
    }),
    directlyReply: vi.fn(async (text: string) => sentMessage(22, text)),
  } as unknown as BotContext;

  return { ctx, replies };
}

function createConfig(onLog: (entry: BotLogEntry) => void): AiReplyConfig {
  return {
    botId: "bot-1",
    apiKey: "test-key",
    baseURL: "https://example.com/v1",
    model: "test-model",
    systemPrompt: "You are helpful.",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {},
    adminChatIds: [123],
    messageConfig: {
      replyMode: "stream",
      richMessageEnabled: true,
      autoSplitThreshold: 0,
      splitDelayMs: 0,
    },
    token: "test-token",
    onLog,
  };
}

describe("AI reply streaming", () => {
  it("uses one selection snapshot for request execution and usage", async () => {
    async function* textStream() {
      yield "Complete";
    }
    let publishNextSnapshot!: () => void;
    streamTextMock.mockImplementation(() => {
      publishNextSnapshot();
      return {
        textStream: textStream(),
        text: Promise.resolve("Complete"),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        finishReason: Promise.resolve("stop"),
      };
    });
    const onTokenUsage = vi.fn();
    const { ctx } = createContext();
    const config = createConfig(vi.fn());
    config.providers = [
      {
        id: "provider-a",
        label: "Provider A",
        apiKey: "secret-a",
        baseURL: "https://a.example/v1",
        providerFormat: "openai",
        defaultModel: "model-a",
        models: [{ id: "model-a" }],
      },
      {
        id: "provider-b",
        label: "Provider B",
        apiKey: "secret-b",
        baseURL: "https://b.example/v1",
        providerFormat: "gemini",
        defaultModel: "model-b",
        models: [{ id: "model-b" }],
      },
    ];
    config.activeProviderId = "provider-a";
    config.aiSelectionSnapshot = {
      global: { activeProviderId: "provider-a", activeModelId: null },
      chats: {},
    };
    config.onTokenUsage = onTokenUsage;
    const result = createAiReplyHandler(config);
    publishNextSnapshot = () =>
      result.applyAiSelectionSnapshot({
        global: { activeProviderId: "provider-b", activeModelId: null },
        chats: {},
      });

    if (typeof result.handler !== "function") throw new Error("Expected a middleware function");
    await result.handler(ctx, vi.fn());

    expect(onTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "model-a" }));
    expect(result.getSelectionForChat(123)).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b",
    });
  });

  it("uses the empty-reply fallback when the complete Rich stream result is empty", async () => {
    async function* emptyStream() {}
    streamTextMock.mockReturnValue({
      textStream: emptyStream(),
      text: Promise.resolve(" \n"),
      steps: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
      finishReason: Promise.resolve("stop"),
    });
    const onLog = vi.fn<(entry: BotLogEntry) => void>();
    const { ctx, replies } = createContext();
    const { handler } = createAiReplyHandler(createConfig(onLog));

    if (typeof handler !== "function") throw new Error("Expected a middleware function");
    await handler(ctx, vi.fn());

    expect(replies).toEqual(["(AI 未生成回复内容)"]);
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", message: "AI returned empty text" }),
    );
    expect(onLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", message: expect.stringContaining("failed") }),
    );
  });

  it.each(["stream", "segment"] as const)(
    "delivers a deterministic fallback for an empty %s continuation",
    async (replyMode) => {
      async function* emptyStream() {}
      streamTextMock.mockReturnValue({
        textStream: emptyStream(),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        finishReason: Promise.resolve("stop"),
      });
      const { ctx } = createContext();
      const config = createConfig(vi.fn());
      config.messageConfig = {
        replyMode,
        richMessageEnabled: true,
        autoSplitThreshold: 0,
        splitDelayMs: 0,
      };
      config.initialApi = ctx.api;
      const result = createAiReplyHandler(config);

      await expect(
        result.fireTimerEvent(-100, "timer-empty", "empty response", undefined, true),
      ).resolves.toBe(true);
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        -100,
        "(事件已处理，但 AI 未生成回复内容)",
        undefined,
      );
    },
  );

  it.each([
    ["send_photo", { photo: "file-id" }],
    ["set_timer", { seconds: 5, reason: "nested timer" }],
    ["send_poll", { question: "Continue?", poll_options: ["Yes", "No"] }],
  ] as const)("accepts successful %s with empty continuation text", async (toolName, input) => {
    const { ctx } = createContext();
    streamTextMock.mockImplementation((options: any) => {
      async function* toolOnlyStream() {
        await options.tools[toolName].execute(input, {});
        yield* [] as string[];
      }
      return {
        textStream: toolOnlyStream(),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        finishReason: Promise.resolve("tool-calls"),
      };
    });
    const config = createConfig(vi.fn());
    config.initialApi = ctx.api;
    const result = createAiReplyHandler(config);

    await expect(
      result.fireTimerEvent(-100, "timer-tool", "tool event", undefined, true),
    ).resolves.toBe(true);
  });

  it("adds a visible fallback after a read-only get_chat_info call", async () => {
    const { ctx } = createContext();
    streamTextMock.mockImplementation((options: any) => {
      async function* readOnlyStream() {
        await options.tools.get_chat_info.execute({}, {});
        yield* [] as string[];
      }
      return {
        textStream: readOnlyStream(),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        finishReason: Promise.resolve("tool-calls"),
      };
    });
    const config = createConfig(vi.fn());
    config.initialApi = ctx.api;
    const result = createAiReplyHandler(config);

    await expect(
      result.fireTimerEvent(-100, "timer-read", "read event", undefined, true),
    ).resolves.toBe(true);
    expect(ctx.api.sendMessage).toHaveBeenCalled();
  });

  it("retries when only a read-only tool ran and fallback delivery failed", async () => {
    const { ctx } = createContext();
    vi.mocked(ctx.api.sendMessage).mockRejectedValue(new Error("Telegram unavailable"));
    streamTextMock.mockImplementation((options: any) => {
      async function* readOnlyStream() {
        await options.tools.get_chat_info.execute({}, {});
        yield* [] as string[];
      }
      return {
        textStream: readOnlyStream(),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        finishReason: Promise.resolve("tool-calls"),
      };
    });
    const config = createConfig(vi.fn());
    config.initialApi = ctx.api;
    const result = createAiReplyHandler(config);

    await expect(
      result.fireTimerEvent(-100, "timer-read-failed", "read event", undefined, true),
    ).rejects.toThrow("Telegram unavailable");
  });

  it.each([-100, 123])(
    "does not expose RSS writes or consume items before scheduled digest delivery in chat %s",
    async (chatId) => {
      const { ctx } = createContext();
      vi.mocked(ctx.api.sendMessage).mockRejectedValue(new Error("Telegram unavailable"));
      const onMarkDigested = vi.fn();
      streamTextMock.mockImplementation((options: any) => {
        expect(options.tools.check_rss).toBeDefined();
        expect(options.tools.mark_rss_read).toBeUndefined();
        async function* digestStream() {
          yield "digest";
        }
        return {
          textStream: digestStream(),
          text: Promise.resolve("digest"),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          finishReason: Promise.resolve("stop"),
        };
      });
      const config = createConfig(vi.fn());
      config.messageConfig = {
        replyMode: "segment",
        richMessageEnabled: true,
        autoSplitThreshold: 0,
        splitDelayMs: 0,
      };
      config.initialApi = ctx.api;
      config.rssCallbacks = {
        onListCollections: vi.fn(),
        onGetNewItems: vi.fn(),
        onMarkDigested,
        onAddFeed: vi.fn(),
        onRemoveFeed: vi.fn(),
        onCreateCollection: vi.fn(),
      } as unknown as NonNullable<AiReplyConfig["rssCallbacks"]>;
      const result = createAiReplyHandler(config);

      await expect(
        result.fireTimerEvent(
          chatId,
          "rss-digest",
          "scheduled digest",
          chatId > 0 ? chatId : undefined,
          chatId < 0,
          false,
        ),
      ).rejects.toThrow("Telegram unavailable");
      expect(onMarkDigested).not.toHaveBeenCalled();
    },
  );

  it("does not replay a visible tool when trailing text delivery fails", async () => {
    const { ctx } = createContext();
    vi.mocked(ctx.api.sendMessage).mockRejectedValue(new Error("Telegram unavailable"));
    streamTextMock.mockImplementation((options: any) => {
      async function* toolStream() {
        await options.tools.send_photo.execute({ photo: "file-id" }, {});
        yield "final text";
      }
      return {
        textStream: toolStream(),
        text: Promise.resolve("final text"),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        finishReason: Promise.resolve("stop"),
      };
    });
    const config = createConfig(vi.fn());
    config.messageConfig = {
      replyMode: "segment",
      richMessageEnabled: true,
      autoSplitThreshold: 0,
      splitDelayMs: 0,
    };
    config.initialApi = ctx.api;
    const result = createAiReplyHandler(config);

    await expect(
      result.fireTimerEvent(-100, "timer-tool-text", "tool event", undefined, true),
    ).resolves.toBe(false);
  });

  it("cleans a waiting status created after the final streamed chunk", async () => {
    const onLog = vi.fn<(entry: BotLogEntry) => void>();
    const { ctx } = createContext();
    async function* terminalToolStream() {
      yield "Complete";
      ctx.waiting_message = sentMessage(30, "🖼️ 查看作品...");
    }
    streamTextMock.mockReturnValue({
      textStream: terminalToolStream(),
      text: Promise.resolve("Complete"),
      steps: Promise.resolve([
        {
          toolCalls: [{ toolName: "fetch_artwork_info" }],
          toolResults: [{ toolName: "fetch_artwork_info" }],
        },
      ]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("stop"),
    });
    const { handler } = createAiReplyHandler(createConfig(onLog));

    if (typeof handler !== "function") throw new Error("Expected a middleware function");
    await handler(ctx, vi.fn());

    expect(ctx.waiting_message).toBeUndefined();
    expect(ctx.deleteWaiting).toHaveBeenCalled();
  });
});
