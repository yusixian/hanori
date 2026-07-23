import type {
  BotMemoryCallbacks,
  BotLogEntry,
  ConversationCallbacks,
  MemoryCallbacks,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../context.js";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

function conversation(): ConversationCallbacks {
  return {
    getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
    getRecentUserMessagesAcrossChats: vi.fn().mockResolvedValue([]),
    addMessage: vi.fn(),
    addMessages: vi.fn(),
    upsertUserMessage: vi.fn(),
    ensureCompression: vi.fn(),
    triggerCompression: vi.fn(),
    clearHistory: vi.fn(),
  };
}

function privacy(mode: "normal" | "isolated" | "off"): UserPrivacyCallbacks {
  return {
    getMode: vi.fn().mockResolvedValue(mode),
    runExclusive: vi.fn(async (_userId, operation) => operation()),
    setMode: vi.fn(),
    forget: vi.fn(),
  };
}

function config(
  conversationCallbacks: ConversationCallbacks,
  privacyCallbacks: UserPrivacyCallbacks,
): AiReplyConfig {
  return {
    botId: "bot-1",
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
    groupOverrides: {
      "-100": { chatId: -100, whitelisted: true },
    },
    adminChatIds: [],
    privateChatWhitelist: [42],
    conversation: conversationCallbacks,
    privacy: privacyCallbacks,
    token: "token",
  };
}

function context(text: string): BotContext {
  return {
    message: { message_id: 7, text, entities: [] },
    chat: { id: -100, type: "supergroup", title: "Public group" },
    from: { id: 42, is_bot: false, first_name: "Tester" },
    me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
    api: {},
  } as unknown as BotContext;
}

describe("AI reply group capture and privacy", () => {
  it("durably captures an allowed group message even when it does not trigger a reply", async () => {
    const history = conversation();
    const runtime = createAiReplyHandler(config(history, privacy("normal")));
    const next = vi.fn();

    await runtime.handler(context("ambient message"), next);

    expect(history.upsertUserMessage).toHaveBeenCalledWith({
      chatId: -100,
      content: "ambient message",
      userId: 42,
      userName: "Tester",
      sourceKey: "telegram:7:user",
      meta: { tgMessageId: 7, publicGroupHistory: true },
    });
    expect(history.triggerCompression).toHaveBeenCalledWith(-100);
    expect(next).toHaveBeenCalled();
    runtime.destroy();
  });

  it("preserves attachment type and caption in ambient group history", async () => {
    const history = conversation();
    const runtime = createAiReplyHandler(config(history, privacy("normal")));
    const ctx = context("") as unknown as { message: unknown };
    ctx.message = {
      message_id: 7,
      caption: "diagram notes",
      entities: [],
      photo: [{ file_id: "small", file_unique_id: "small", width: 10, height: 10 }],
    };

    await runtime.handler(ctx as BotContext, vi.fn());

    expect(history.upsertUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "[图片]\ndiagram notes" }),
    );
    runtime.destroy();
  });

  it("suppresses keyword personalization in off mode but still captures public group history", async () => {
    const history = conversation();
    const runtime = createAiReplyHandler(config(history, privacy("off")));
    const next = vi.fn();

    await runtime.handler(context("sample should not passively reply"), next);

    expect(history.upsertUserMessage).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalled();
    runtime.destroy();
  });

  it("answers an explicit private request without any personalization reads, tools, or writes", async () => {
    async function* textStream() {
      yield "stateless answer";
    }
    streamTextMock.mockReturnValue({
      textStream: textStream(),
      text: Promise.resolve("stateless answer"),
      steps: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      finishReason: Promise.resolve("stop"),
    });
    const history = conversation();
    const getProfile = vi.fn();
    const touchProfile = vi.fn();
    const memory = {
      getProfile,
      touchProfile,
    } as unknown as MemoryCallbacks;
    const getMemoriesForQuery = vi.fn();
    const botMemory = {
      getMemoriesForQuery,
    } as unknown as BotMemoryCallbacks;
    const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
    const privateConfig = {
      ...config(history, privacy("off")),
      memory,
      memoryConfig: {
        enabled: true,
        maxSteps: 3,
        autoReadProfile: true,
        autoUpdateLastSeen: true,
        toolChoice: "auto" as const,
      },
      botMemory,
      botMemoryConfig: { enabled: true, autoInjectMemories: true, maxMemories: 5 },
      messageConfig: {
        replyMode: "segment" as const,
        richMessageEnabled: false,
        autoSplitThreshold: 0,
        splitDelayMs: 0,
      },
      onLog: (entry: BotLogEntry) => {
        logs.push(entry);
      },
    };
    const runtime = createAiReplyHandler(privateConfig);
    const ctx = {
      update: { update_id: 1 },
      message: { message_id: 8, text: "direct request", entities: [] },
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Tester" },
      me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
      api: { sendChatAction: vi.fn() },
      replyWithChatAction: vi.fn(),
      resolveWait: vi.fn().mockResolvedValue(20),
      deleteWaiting: vi.fn(),
      directlyReply: vi.fn(),
    } as unknown as BotContext;

    await runtime.handler(ctx, vi.fn());

    expect(history.getHistory).not.toHaveBeenCalled();
    expect(history.getRecentUserMessagesAcrossChats).not.toHaveBeenCalled();
    expect(history.addMessages).not.toHaveBeenCalled();
    expect(getProfile).not.toHaveBeenCalled();
    expect(touchProfile).not.toHaveBeenCalled();
    expect(getMemoriesForQuery).not.toHaveBeenCalled();
    const requestLog = logs.find((entry) => entry.message === "AI request");
    expect(requestLog?.meta?.["toolsEnabled"]).not.toContain("get_profile");
    expect(requestLog?.meta?.["toolsEnabled"]).not.toContain("save_memory");
    expect(requestLog?.meta?.["toolsEnabled"]).not.toContain("set_mood");
    runtime.destroy();
  });
});
