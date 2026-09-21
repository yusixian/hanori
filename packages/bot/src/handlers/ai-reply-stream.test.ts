import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { Tool } from "ai";
import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../context.js";
import { createAiReplyHandler, type AiReplyConfig, wrapToolsWithStatus } from "./ai-reply.js";

const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
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

function createContext(options: { chatId?: number; userId?: number } = {}) {
  const chatId = options.chatId ?? 123;
  const userId = options.userId ?? 123;
  const isGroup = chatId < 0;
  const replies: string[] = [];
  const streamError = new Error("Rich Message content cannot be empty");
  const api = {
    sendChatAction: vi.fn().mockResolvedValue(true),
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
    chat: isGroup
      ? { id: chatId, type: "supergroup", title: "Test group" }
      : { id: chatId, type: "private" },
    from: { id: userId, is_bot: false, first_name: "Tester" },
    me: { id: 999, is_bot: true, first_name: "Test Bot", username: "test_bot" },
    api,
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    wait: vi.fn(async (text: string) => {
      replies.push(text);
      ctx.waiting_message = sentMessage(23, text);
      return 23;
    }),
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

function createRssCallbacks(): NonNullable<AiReplyConfig["rssCallbacks"]> {
  return {
    onListCollections: vi.fn(),
    onGetNewItems: vi.fn(),
    onListFeeds: vi.fn(),
    onMarkDigested: vi.fn(),
    onAddFeed: vi.fn(),
    onRemoveFeed: vi.fn(),
    onCreateCollection: vi.fn(),
  };
}

describe("AI reply streaming", () => {
  it.each([1000, undefined])(
    "records whole-turn usage and preserves unknown cache usage (last-step cache: %s)",
    async (cachedTokens) => {
      const onLog = vi.fn<(entry: BotLogEntry) => void>();
      const onTokenUsage = vi.fn();
      const { ctx } = createContext();
      const lastUsage = { inputTokens: 1200, outputTokens: 20, totalTokens: 1220 };
      async function* textStream() {
        yield "Complete";
      }
      streamTextMock.mockReturnValue({
        textStream: textStream(),
        text: Promise.resolve("Complete"),
        steps: Promise.resolve(
          [800, cachedTokens].map((cached) => ({
            toolCalls: [],
            toolResults: [],
            usage: { raw: { prompt_tokens_details: { cached_tokens: cached } } },
          })),
        ),
        usage: Promise.resolve(lastUsage),
        totalUsage: Promise.resolve({ inputTokens: 2200, outputTokens: 30, totalTokens: 2230 }),
        finishReason: Promise.resolve("stop"),
      });
      const { handler } = createAiReplyHandler({ ...createConfig(onLog), onTokenUsage });

      await handler(ctx, vi.fn());

      expect(onTokenUsage).toHaveBeenCalledOnce();
      const record = onTokenUsage.mock.calls[0]![0];
      expect(record).toMatchObject({
        promptTokens: 2200,
        completionTokens: 30,
        totalTokens: 2230,
      });
      if (cachedTokens === undefined) expect(record).not.toHaveProperty("cacheReadTokens");
      else expect(record.cacheReadTokens / record.promptTokens).toBeCloseTo(1800 / 2200);
      expect(record).not.toHaveProperty("cacheWriteTokens");
      expect(
        onLog.mock.calls.find(([entry]) => entry.message === "AI response")?.[0].meta,
      ).toMatchObject({ usage: lastUsage });
    },
  );

  it("keeps the original provider error and links it to the request and failed execution", async () => {
    const providerError = Object.assign(new Error("upstream quota exceeded"), {
      statusCode: 429,
      responseBody: '{"error":"quota exhausted"}',
    });
    streamTextMock.mockImplementation((options) => {
      async function* failedStream() {
        options.onError({ error: providerError });
        yield* [] as string[];
      }
      return {
        textStream: failedStream(),
        get text() {
          return Promise.reject(new Error("No output generated"));
        },
      };
    });
    const onLog = vi.fn<(entry: BotLogEntry) => void>();
    const { ctx } = createContext();
    const runtime = createAiReplyHandler(createConfig(onLog));
    try {
      await runtime.handler(ctx, vi.fn());
      await vi.waitFor(() =>
        expect(onLog).toHaveBeenCalledWith(
          expect.objectContaining({ message: "AI reply execution finished" }),
        ),
      );
      const logs = onLog.mock.calls.map(([entry]) => entry);
      const request = logs.find((entry) => entry.message === "AI request")!;
      const failure = logs.find((entry) => entry.message === "AI provider stream failed")!;
      expect(failure.meta).toMatchObject({
        correlationId: request.meta!.correlationId,
        chatId: 123,
        messageId: 7,
        error: {
          statusCode: 429,
          responseBody: '{"error":"quota exhausted"}',
          stack: expect.any(String),
        },
      });
      expect(
        logs.find((entry) => entry.message === "AI reply execution finished")?.meta,
      ).toMatchObject({ outcome: "failed", correlationId: request.meta!.correlationId });
      expect(
        logs.find((entry) => entry.message.startsWith("AI reply failed:"))?.meta,
      ).toMatchObject({ error: { message: "upstream quota exceeded" } });
    } finally {
      await runtime.destroy();
    }
  });

  it.each([
    ["web_search", "🌐 搜索中..."],
    ["search_danbooru_character_tags", "🏷️ 查找角色标签..."],
    ["mcp7_lookup", "🛠️ 使用工具中..."],
  ])("shows a waiting status for the %s tool", async (toolName, expectedStatus) => {
    const { ctx, replies } = createContext();
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tools = wrapToolsWithStatus({ [toolName]: { execute } as unknown as Tool }, ctx);

    await tools[toolName]!.execute!({}, {} as never);

    expect(replies).toEqual([expectedStatus]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "admin", userId: 123, hasAdminTools: true },
    { name: "ordinary member", userId: 456, hasAdminTools: false },
  ])("uses the requester identity for RSS tools in a group $name request", async (testCase) => {
    const { ctx } = createContext({ chatId: -100, userId: testCase.userId });
    streamTextMock.mockImplementation((options: any) => {
      expect(options.tools.check_rss).toBeDefined();
      if (testCase.hasAdminTools) {
        expect(options.tools.list_rss_feeds).toBeDefined();
        expect(options.tools.mark_rss_read).toBeDefined();
        expect(options.tools.add_rss_feed).toBeDefined();
        expect(options.tools.remove_rss_feed).toBeDefined();
        expect(options.tools.create_rss_collection).toBeDefined();
      } else {
        expect(options.tools.list_rss_feeds).toBeUndefined();
        expect(options.tools.mark_rss_read).toBeUndefined();
        expect(options.tools.add_rss_feed).toBeUndefined();
        expect(options.tools.remove_rss_feed).toBeUndefined();
        expect(options.tools.create_rss_collection).toBeUndefined();
      }
      async function* textStream() {
        yield "Complete";
      }
      return {
        textStream: textStream(),
        text: Promise.resolve("Complete"),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        finishReason: Promise.resolve("stop"),
      };
    });
    const config = createConfig(vi.fn());
    config.triggerConfig.triggerWords = ["hello"];
    config.rssCallbacks = createRssCallbacks();
    const result = createAiReplyHandler(config);

    if (typeof result.handler !== "function") throw new Error("Expected a middleware function");
    await result.handler(ctx, vi.fn());
  });

  it.each([
    { name: "admin", userId: 123, hasAdminTools: true },
    { name: "ordinary member", userId: 456, hasAdminTools: false },
  ])("preserves requester RSS permissions in a group $name continuation", async (testCase) => {
    const { ctx } = createContext();
    streamTextMock.mockImplementation((options: any) => {
      expect(options.tools.check_rss).toBeDefined();
      if (testCase.hasAdminTools) {
        expect(options.tools.list_rss_feeds).toBeDefined();
        expect(options.tools.mark_rss_read).toBeDefined();
        expect(options.tools.add_rss_feed).toBeDefined();
        expect(options.tools.remove_rss_feed).toBeDefined();
        expect(options.tools.create_rss_collection).toBeDefined();
      } else {
        expect(options.tools.list_rss_feeds).toBeUndefined();
        expect(options.tools.mark_rss_read).toBeUndefined();
        expect(options.tools.add_rss_feed).toBeUndefined();
        expect(options.tools.remove_rss_feed).toBeUndefined();
        expect(options.tools.create_rss_collection).toBeUndefined();
      }
      async function* textStream() {
        yield "Complete";
      }
      return {
        textStream: textStream(),
        text: Promise.resolve("Complete"),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        finishReason: Promise.resolve("stop"),
      };
    });
    const config = createConfig(vi.fn());
    config.initialApi = ctx.api;
    config.rssCallbacks = createRssCallbacks();
    const result = createAiReplyHandler(config);

    await expect(
      result.fireTimerEvent(
        -100,
        `rss-${testCase.name}`,
        "continue RSS task",
        testCase.userId,
        false,
        true,
      ),
    ).resolves.toBe(true);
  });

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
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
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
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
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

  it.each([
    ["mark_rss_read", { collection_id: 7 }, "onMarkDigested"],
    [
      "add_rss_feed",
      { collection_id: 7, feed_url: "https://example.com/feed.xml?token=secret" },
      "onAddFeed",
    ],
    ["remove_rss_feed", { feed_id: 21 }, "onRemoveFeed"],
    [
      "create_rss_collection",
      { name: "Frontend", description: "Focus", digest_hour: 8, digest_minute: 30 },
      "onCreateCollection",
    ],
  ] as const)(
    "executes %s immediately and leaves a completion status when the model reply is empty",
    async (toolName, input, callbackName) => {
      const { ctx, replies } = createContext();
      ctx.waiting_message = sentMessage(30, "waiting");
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
          totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
          finishReason: Promise.resolve("tool-calls"),
        };
      });
      const config = createConfig(vi.fn());
      config.rssCallbacks = createRssCallbacks();
      const result = createAiReplyHandler(config);

      if (typeof result.handler !== "function") throw new Error("Expected a middleware function");
      await result.handler(ctx, vi.fn());

      expect(config.rssCallbacks[callbackName]).toHaveBeenCalledOnce();
      expect(ctx.api.sendMessage).not.toHaveBeenCalled();
      expect(replies).toEqual(["🛠️ 使用工具中...", "✅ 操作完成"]);
      await result.destroy();
    },
  );

  it("uses the empty fallback when an immediate RSS action fails", async () => {
    const { ctx, replies } = createContext();
    streamTextMock.mockImplementation((options: any) => {
      async function* toolOnlyStream() {
        await options.tools.add_rss_feed.execute(
          { collection_id: 7, feed_url: "https://example.com/feed.xml" },
          {},
        );
        yield* [] as string[];
      }
      return {
        textStream: toolOnlyStream(),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        finishReason: Promise.resolve("tool-calls"),
      };
    });
    const config = createConfig(vi.fn());
    config.rssCallbacks = createRssCallbacks();
    vi.mocked(config.rssCallbacks.onAddFeed).mockRejectedValueOnce(new Error("RSS unavailable"));
    const result = createAiReplyHandler(config);

    if (typeof result.handler !== "function") throw new Error("Expected a middleware function");
    await result.handler(ctx, vi.fn());

    expect(replies).toEqual(["🛠️ 使用工具中...", "(AI 未生成回复内容)"]);
    await result.destroy();
  });

  it("still delivers the empty fallback after a result-only delegated task", async () => {
    generateTextMock.mockResolvedValue({ text: "delegated answer", steps: [] });
    const { ctx, replies } = createContext();
    ctx.waiting_message = sentMessage(30, "waiting");
    let delegatedOutput: unknown;
    streamTextMock.mockImplementation((options: any) => {
      async function* toolOnlyStream() {
        delegatedOutput = await options.tools.delegate_task.execute(
          { agent: "translator", task: "translate this" },
          {},
        );
        yield* [] as string[];
      }
      return {
        textStream: toolOnlyStream(),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        finishReason: Promise.resolve("tool-calls"),
      };
    });
    const config = createConfig(vi.fn());
    config.agentToolsConfig = { enabled: true };
    const result = createAiReplyHandler(config);

    if (typeof result.handler !== "function") throw new Error("Expected a middleware function");
    await result.handler(ctx, vi.fn());

    expect(replies.at(-1)).toBe("(AI 未生成回复内容)");
    expect(delegatedOutput).toEqual({ agent: "translator", result: "delegated answer", steps: 0 });
    expect(generateTextMock).toHaveBeenCalled();
    await result.destroy();
  });

  it("waits for active administrator actions while destroying the AI runtime", async () => {
    const result = createAiReplyHandler(createConfig(vi.fn()));
    const registry = result.state.getPendingAdminActions();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const action = registry.register({
      kind: "rss:add_rss_feed",
      chatId: 123,
      userId: 123,
      description: "add feed",
      execute: async (signal) => {
        started();
        await gate;
        signal?.throwIfAborted();
        return { summary: "done" };
      },
    });
    const run = registry.run(action);
    const runResult = expect(run).rejects.toThrow("Admin action registry was destroyed");
    await didStart;

    const destroy = result.destroy();
    let destroyed = false;
    void destroy.then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);

    release();
    await runResult;
    await expect(destroy).resolves.toBeUndefined();
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
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
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
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
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
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
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
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
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
        expect(options.tools.list_rss_feeds).toBeDefined();
        expect(options.tools.mark_rss_read).toBeUndefined();
        expect(options.tools.add_rss_feed).toBeUndefined();
        expect(options.tools.remove_rss_feed).toBeUndefined();
        expect(options.tools.create_rss_collection).toBeUndefined();
        async function* digestStream() {
          yield "digest";
        }
        return {
          textStream: digestStream(),
          text: Promise.resolve("digest"),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
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
        onListFeeds: vi.fn(),
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

  it("accepts a visible tool effect without replay when trailing text delivery fails", async () => {
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
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
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
    ).resolves.toBe(true);
    expect(ctx.api.sendPhoto).toHaveBeenCalledOnce();
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
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("stop"),
    });
    const { handler } = createAiReplyHandler(createConfig(onLog));

    if (typeof handler !== "function") throw new Error("Expected a middleware function");
    await handler(ctx, vi.fn());

    expect(ctx.waiting_message).toBeUndefined();
    expect(ctx.deleteWaiting).toHaveBeenCalled();
  });
});
