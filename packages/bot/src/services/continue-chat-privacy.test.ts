import type {
  BotLogEntry,
  ConversationCallbacks,
  MemoryCallbacks,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import type { JSONValue, ModelMessage, Tool } from "ai";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { continueChat, fallbackExecutionLock, type ContinueChatConfig } from "./continue-chat.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

beforeEach(() => {
  streamTextMock.mockReset();
});

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

function createApi(): Api {
  let nextMessageId = 201;
  return {
    sendChatAction: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn(
      async (_chatId: number, text: string) =>
        ({
          message_id: nextMessageId++,
          date: 0,
          chat: { id: -100, type: "supergroup", title: "Test group" },
          text,
        }) as Message.TextMessage,
    ),
  } as unknown as Api;
}

function createConfig(overrides: Partial<ContinueChatConfig> = {}): ContinueChatConfig {
  return {
    botId: "bot-1",
    systemPrompt: "system",
    resolveSelection: () => ({ model: {} as never, modelId: "model-a", providerId: "p" }),
    messageConfig: {
      replyMode: "segment",
      richMessageEnabled: false,
      autoSplitThreshold: 0,
      splitDelayMs: 0,
    },
    pendingActions: {} as never,
    pendingAdminActions: {} as never,
    recentBotMessageIds: new Map<number, number[]>(),
    moodState: new Map(),
    ...overrides,
  };
}

function successfulStream(text: string) {
  async function* textStream() {
    yield text;
  }
  return {
    textStream: textStream(),
    text: Promise.resolve(text),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  };
}

describe("continueChat privacy", () => {
  it("includes continuation content in the bounded correlated diagnostic", async () => {
    const onLog = vi.fn();
    const secretDescription = "private timer reason that must not reach logs";

    await continueChat(
      {} as Api,
      {
        onLog,
        resolveSelection: () => ({ model: {} as never, modelId: "model-a" }),
      } as unknown as ContinueChatConfig,
      {
        chatId: -100,
        userId: 42,
        eventDescription: secretDescription,
      },
    );

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "continueChat triggered",
        meta: expect.objectContaining({ eventDescriptionLength: secretDescription.length }),
      }),
    );
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("continueChat failed:"),
        meta: expect.objectContaining({
          correlationId: expect.any(String),
          eventDescription: secretDescription,
        }),
      }),
    );
  });

  it("rechecks timer ownership under the user privacy lock and skips off users", async () => {
    const getMode = vi.fn().mockResolvedValue("off");
    const runExclusive = vi.fn(async (_userId: number, operation: () => Promise<void>) =>
      operation(),
    );
    const privacy = {
      getMode,
      runExclusive,
    } as unknown as UserPrivacyCallbacks;
    const getProfileAvatar = vi.fn();
    const onLog = vi.fn();

    await continueChat(
      {} as Api,
      {
        privacy,
        onLog,
        memory: { getProfileAvatar } as unknown as MemoryCallbacks,
        memoryConfig: {
          enabled: true,
          maxSteps: 3,
          autoReadProfile: false,
          autoUpdateLastSeen: false,
          toolChoice: "auto",
        },
      } as unknown as ContinueChatConfig,
      {
        chatId: 42,
        userId: 42,
        eventDescription: "timer fired",
      },
    );

    expect(runExclusive).toHaveBeenCalledWith(42, expect.any(Function));
    expect(getMode).toHaveBeenCalledWith(42);
    expect(getProfileAvatar).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Personalized continuation skipped because personalization is off",
      }),
    );
  });

  it("acquires max-one execution ownership before the privacy lock", async () => {
    const order: string[] = [];
    let executionOwned = false;
    const runWithExecution: NonNullable<ContinueChatConfig["runWithExecution"]> = async (
      _scope,
      operation,
    ) => {
      order.push("execution");
      expect(executionOwned).toBe(false);
      executionOwned = true;
      try {
        return await operation({
          signal: new AbortController().signal,
          isCurrent: () => true,
        });
      } finally {
        executionOwned = false;
      }
    };
    const privacy = {
      runExclusive: vi.fn(async (_userId: number, operation: () => Promise<boolean>) => {
        order.push("privacy");
        expect(executionOwned).toBe(true);
        return operation();
      }),
      getMode: vi.fn(async () => {
        order.push("mode");
        return "off" as const;
      }),
    } as unknown as UserPrivacyCallbacks;

    await continueChat({} as Api, { privacy, runWithExecution } as unknown as ContinueChatConfig, {
      chatId: 42,
      userId: 42,
      eventDescription: "timer fired",
    });

    expect(order).toEqual(["execution", "privacy", "mode"]);
    expect(executionOwned).toBe(false);
  });

  it("rejects privacy and AI-disabled skips when reliable delivery is required", async () => {
    const privacy = {
      getMode: vi.fn().mockResolvedValue("off"),
      runExclusive: vi.fn(async (_userId: number, operation: () => Promise<void>) => operation()),
    } as unknown as UserPrivacyCallbacks;

    await expect(
      continueChat({} as Api, { privacy } as unknown as ContinueChatConfig, {
        chatId: 42,
        userId: 42,
        eventDescription: "timer fired",
        requireDelivery: true,
      }),
    ).rejects.toThrow("personalization is off");

    await expect(
      continueChat({} as Api, { isAiDisabled: () => true } as unknown as ContinueChatConfig, {
        chatId: -100,
        eventDescription: "rss digest",
        requireDelivery: true,
      }),
    ).rejects.toThrow("AI is disabled");
  });

  it("fails closed for an ownerless private continuation", async () => {
    const privacy = {
      getMode: vi.fn(),
      runExclusive: vi.fn(),
    } as unknown as UserPrivacyCallbacks;
    const onLog = vi.fn();

    await continueChat({} as Api, { privacy, onLog } as unknown as ContinueChatConfig, {
      chatId: 42,
      eventDescription: "legacy event",
    });

    expect(privacy.getMode).not.toHaveBeenCalled();
    expect(privacy.runExclusive).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Ownerless private continuation skipped because privacy cannot be evaluated",
      }),
    );
  });

  it("binds continuation avatar reads to the event owner and keeps image bytes ephemeral", async () => {
    const avatarBytes = Uint8Array.from([211, 17, 99, 207]);
    const byteSignature = JSON.stringify(avatarBytes);
    const getProfileAvatar = vi.fn().mockResolvedValue({
      status: "available" as const,
      telegramId: 77,
      avatarVersion: "avatar-v1",
      mediaType: "image/png" as const,
      data: avatarBytes,
    });
    const history = conversation();
    const logs: BotLogEntry[] = [];
    let toolOutput: unknown;
    let preparedMessages: ModelMessage[] = [];
    const steps: Array<{
      toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>;
      toolResults: Array<{ toolName: string; toolCallId: string; output: unknown }>;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }> = [];
    streamTextMock.mockImplementationOnce(
      (options: {
        tools: Record<string, Tool>;
        prepareStep: (input: {
          messages: ModelMessage[];
          steps: typeof steps;
          stepNumber: number;
        }) => { messages: ModelMessage[] };
      }) => {
        async function* textStream() {
          toolOutput = await options.tools.get_profile_avatar!.execute!(
            { telegram_id: 77 },
            { toolCallId: "avatar-call", messages: [] },
          );
          preparedMessages = options.prepareStep({
            steps,
            stepNumber: 1,
            messages: [
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolName: "get_profile_avatar",
                    toolCallId: "avatar-call",
                    output: { type: "json", value: toolOutput as JSONValue },
                  },
                ],
              },
            ],
          }).messages;
          steps.push({
            toolCalls: [
              {
                toolName: "get_profile_avatar",
                toolCallId: "avatar-call",
                input: { telegram_id: 77 },
              },
            ],
            toolResults: [
              { toolName: "get_profile_avatar", toolCallId: "avatar-call", output: toolOutput },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          yield "avatar answer";
        }
        return {
          textStream: textStream(),
          text: Promise.resolve("avatar answer"),
          steps: Promise.resolve(steps),
          totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        };
      },
    );

    await expect(
      continueChat(
        createApi(),
        createConfig({
          conversation: history,
          memory: { getProfileAvatar } as unknown as MemoryCallbacks,
          memoryConfig: {
            enabled: true,
            maxSteps: 3,
            autoReadProfile: false,
            autoUpdateLastSeen: false,
            toolChoice: "auto",
          },
          onLog: (entry) => {
            logs.push(entry);
          },
        }),
        {
          chatId: -100,
          userId: 42,
          userName: "Tester",
          eventDescription: "analyze their avatar",
        },
      ),
    ).resolves.toBe(true);

    expect(getProfileAvatar).toHaveBeenCalledWith(77, 42);
    expect(toolOutput).toMatchObject({
      status: "available",
      telegramId: 77,
      avatarVersion: "avatar-v1",
    });
    expect(toolOutput).not.toHaveProperty("data");
    expect(preparedMessages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining("77") },
        { type: "image", image: avatarBytes, mediaType: "image/png" },
      ],
    });
    expect(vi.mocked(history.addMessages)).toHaveBeenCalledWith([
      expect.objectContaining({ role: "system", content: "[事件] analyze their avatar" }),
      expect.objectContaining({ role: "assistant", content: "avatar answer" }),
    ]);
    expect(
      JSON.stringify({ history: vi.mocked(history.addMessages).mock.calls, logs }),
    ).not.toContain(byteSignature);
    expect(
      JSON.stringify({ history: vi.mocked(history.addMessages).mock.calls, logs }),
    ).not.toContain('"data"');
  });

  it("does not expose the avatar tool to an ownerless group continuation", async () => {
    const getProfileAvatar = vi.fn();
    streamTextMock.mockReturnValueOnce(successfulStream("ownerless answer"));

    await expect(
      continueChat(
        createApi(),
        createConfig({
          memory: { getProfileAvatar } as unknown as MemoryCallbacks,
          memoryConfig: {
            enabled: true,
            maxSteps: 3,
            autoReadProfile: false,
            autoUpdateLastSeen: false,
            toolChoice: "auto",
          },
        }),
        { chatId: -100, eventDescription: "ownerless event" },
      ),
    ).resolves.toBe(true);

    expect(getProfileAvatar).not.toHaveBeenCalled();
    expect(streamTextMock.mock.calls.at(-1)?.[0]?.tools).not.toHaveProperty("get_profile_avatar");
  });

  it("resolves one selection snapshot only after acquiring the chat lock", async () => {
    const chatId = -200;
    const botId = "bot-a";
    const releaseLock = await fallbackExecutionLock.acquire(`${botId}:${chatId}`);
    const resolveSelection = vi.fn(() => ({ model: {} as never, modelId: "model-a" }));

    const continuation = continueChat(
      {} as Api,
      { botId, resolveSelection } as unknown as ContinueChatConfig,
      { chatId, userId: 42, eventDescription: "timer fired" },
    );
    await Promise.resolve();
    expect(resolveSelection).not.toHaveBeenCalled();

    releaseLock();
    await continuation;
    expect(resolveSelection).toHaveBeenCalledOnce();
  });
});
