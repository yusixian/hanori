import type { PluginRuntimePort, PluginTurnSession } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotContext } from "../context.js";
import { createAiReplyHandler, type AiReplyConfig } from "../handlers/ai-reply.js";
import { continueChat, type ContinueChatConfig } from "../services/continue-chat.js";
import { PendingActionRegistry } from "../services/pending-actions.js";
import { createPluginTools } from "./plugins.js";
import { createToolsetConfig } from "./turn-toolset-test-helpers.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

function session(): PluginTurnSession {
  return {
    tools: [
      {
        name: "plg_fixture_read",
        description: "Read fixture",
        inputSchema: { type: "object" },
        effect: "read_only",
        access: "all",
        execute: vi.fn(async () => ({ ok: true })),
      },
    ],
    searchProviders: [],
    dispose: vi.fn(async () => {}),
  };
}
function stream(text = "Complete") {
  async function* textStream() {
    yield text;
  }
  return {
    textStream: textStream(),
    text: Promise.resolve(text),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    finishReason: Promise.resolve("stop"),
  };
}
function message(id: number, text: string, chatId = -100): Message.TextMessage {
  return {
    message_id: id,
    date: 0,
    chat: { id: chatId, type: "supergroup", title: "Test" },
    text,
  } as Message.TextMessage;
}
function api(): Api {
  return {
    sendChatAction: vi.fn(async () => true),
    sendMessage: vi.fn(async (_id: number, text: string) => message(50, text)),
  } as unknown as Api;
}
function config(
  plugins: PluginRuntimePort,
  overrides: Partial<ContinueChatConfig> = {},
): ContinueChatConfig {
  return {
    ...createToolsetConfig({
      plugins,
      memory: undefined,
      botMemory: undefined,
      webTools: undefined,
      artworkToolsConfig: undefined,
      dataFiles: undefined,
      generationLibraryPort: undefined,
      imageGenerationPort: undefined,
      skills: [],
      rssCallbacks: undefined,
    }),
    systemPrompt: "system",
    resolveSelection: () => ({ model: {} as never, modelId: "test", providerId: "fixture" }),
    messageConfig: {
      replyMode: "segment",
      richMessageEnabled: false,
      autoSplitThreshold: 0,
      splitDelayMs: 0,
    },
    pendingActions: new PendingActionRegistry(),
    recentBotMessageIds: new Map(),
    moodState: new Map(),
    ...overrides,
  };
}
beforeEach(() => {
  streamTextMock.mockReset();
});

describe("plugin AI tool adapter", () => {
  it("passes structured input and the current tool-call signal to the host-bound tool", async () => {
    const bound = session();
    const tools = createPluginTools(bound);
    const controller = new AbortController();
    const input = { query: "fixture", botId: "untrusted-input" };
    await expect(
      tools.plg_fixture_read!.execute!(input as never, {
        toolCallId: "call",
        messages: [],
        abortSignal: controller.signal,
      }),
    ).resolves.toEqual({ ok: true });
    expect(bound.tools[0]!.execute).toHaveBeenCalledWith(input, controller.signal);
  });
  it("maps private exception contents to a safe result", async () => {
    const bound = session();
    bound.tools[0]!.execute = vi.fn(async () => {
      throw new Error("Cookie=synthetic-secret");
    });
    const result = await createPluginTools(bound).plg_fixture_read!.execute!({} as never, {
      toolCallId: "call",
      messages: [],
    });
    expect(result).toEqual({ error: "plugin_call_failed" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it("preserves parent cancellation instead of turning it into an ordinary plugin error", async () => {
    const bound = session();
    const controller = new AbortController();
    const reason = new Error("parent stopped");
    bound.tools[0]!.execute = vi.fn(async () => {
      controller.abort(reason);
      throw new Error("private plugin error");
    });
    await expect(
      createPluginTools(bound).plg_fixture_read!.execute!({} as never, {
        toolCallId: "call",
        messages: [],
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
  it("does not invoke host code when the tool call is already cancelled", async () => {
    const bound = session();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createPluginTools(bound).plg_fixture_read!.execute!({} as never, {
        toolCallId: "call",
        messages: [],
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(bound.tools[0]!.execute).not.toHaveBeenCalled();
  });
});

describe("continuation plugin lifecycle", () => {
  it.each(["success", "model failure", "context failure"])(
    "disposes the plugin session after %s",
    async (outcome) => {
      const bound = session();
      const createSession = vi.fn<PluginRuntimePort["createSession"]>(async () => bound);
      if (outcome === "model failure")
        streamTextMock.mockImplementationOnce(() => {
          throw new Error("model unavailable");
        });
      else streamTextMock.mockReturnValueOnce(stream());
      const dataFiles =
        outcome === "context failure"
          ? {
              dataDir: "/tmp/plugin-turn-test",
              injectableFiles: new Set<string>(),
              loadFiles: vi.fn(async () => {
                throw new Error("context unavailable");
              }),
            }
          : undefined;
      await continueChat(api(), config({ createSession }, { dataFiles }), {
        chatId: -100,
        userId: 42,
        eventDescription: "timer fired",
      });
      expect(createSession).toHaveBeenCalledWith(
        {
          botId: "bot-1",
          chatId: -100,
          userId: 42,
          isAdmin: true,
          isPrivate: false,
          readOnly: true,
        },
        expect.any(AbortSignal),
      );
      expect(bound.dispose).toHaveBeenCalledOnce();
      if (outcome === "success")
        expect(streamTextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            tools: expect.objectContaining({ plg_fixture_read: expect.any(Object) }),
          }),
        );
    },
  );
  it("registers manual cancellation before a pending plugin factory and cleans up a cancelled turn", async () => {
    let registered: AbortController | undefined;
    let factorySignal: AbortSignal | undefined;
    const reason = new Error("Bot disabled during plugin startup");
    const unregister = vi.fn();
    const createSession = vi.fn<PluginRuntimePort["createSession"]>(async (_actor, signal) => {
      factorySignal = signal;
      expect(registered).toBeDefined();
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
    });
    const running = continueChat(
      api(),
      config(
        { createSession },
        {
          registerAbortController: (controller) => {
            registered = controller;
          },
          unregisterAbortController: unregister,
        },
      ),
      { chatId: -100, userId: 42, eventDescription: "timer fired" },
    );
    await vi.waitFor(() => expect(factorySignal).toBeDefined());
    registered!.abort(reason);
    await expect(running).resolves.toBe(false);
    expect(factorySignal!.aborted).toBe(true);
    expect(factorySignal!.reason).toBe(reason);
    expect(unregister).toHaveBeenCalledWith(registered);
    expect(streamTextMock).not.toHaveBeenCalled();
  });
  it("disposes an assembled session when the running model is cancelled", async () => {
    const bound = session();
    const controller = new AbortController();
    streamTextMock.mockImplementationOnce((options: { abortSignal: AbortSignal }) => ({
      ...stream(),
      textStream: (async function* () {
        await new Promise<void>((_resolve, reject) =>
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          }),
        );
        yield "Unexpected late output";
      })(),
    }));
    const running = continueChat(
      api(),
      config(
        { createSession: async () => bound },
        {
          runWithExecution: (_scope, operation) =>
            operation({ signal: controller.signal, isCurrent: () => !controller.signal.aborted }),
        },
      ),
      { chatId: -100, userId: 42, eventDescription: "timer fired" },
    );
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).resolves.toBe(false);
    expect(bound.dispose).toHaveBeenCalledOnce();
  });
});

describe("reply plugin lifecycle", () => {
  it.each(["success", "failure", "cancellation"])(
    "supplies the trusted private actor and disposes after model %s",
    async (outcome) => {
      const bound = session();
      const createSession = vi.fn<PluginRuntimePort["createSession"]>(async () => bound);
      if (outcome === "failure")
        streamTextMock.mockImplementationOnce(() => {
          throw new Error("model failed");
        });
      else if (outcome === "cancellation")
        streamTextMock.mockImplementationOnce((options: { abortSignal: AbortSignal }) => ({
          ...stream(),
          textStream: (async function* () {
            await new Promise<void>((_resolve, reject) =>
              options.abortSignal.addEventListener(
                "abort",
                () => reject(options.abortSignal.reason),
                { once: true },
              ),
            );
            yield "Unexpected late output";
          })(),
        }));
      else streamTextMock.mockReturnValueOnce(stream());
      const replyConfig: AiReplyConfig = {
        botId: "reply-bot",
        apiKey: "test-key",
        baseURL: "https://example.com/v1",
        model: "test",
        systemPrompt: "system",
        triggerConfig: {
          replyToBot: true,
          mentionBot: true,
          triggerWords: [],
          randomReplyPercent: 0,
          randomReplyCooldown: 60,
        },
        groupOverrides: {},
        adminChatIds: [42],
        privateChatWhitelist: [42],
        messageConfig: {
          replyMode: "segment",
          richMessageEnabled: false,
          autoSplitThreshold: 0,
          splitDelayMs: 0,
        },
        plugins: { createSession },
        token: "test-token",
      };
      const runtime = createAiReplyHandler(replyConfig);
      const ctx = {
        update: { update_id: 1 },
        message: { message_id: 7, text: "hello" },
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Tester" },
        me: { id: 99, is_bot: true, username: "fixture_bot", first_name: "Bot" },
        api: api(),
        replyWithChatAction: vi.fn(async () => true),
        wait: vi.fn(async () => 40),
        resolveWait: vi.fn(async () => 41),
        deleteWaiting: vi.fn(async () => {}),
        directlyReply: vi.fn(async (text: string) => message(42, text, 42)),
      } as unknown as BotContext;
      try {
        const running = runtime.handler(ctx, vi.fn());
        if (outcome === "cancellation") {
          await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
          runtime.setAiEnabled(false);
        }
        if (outcome === "cancellation")
          await expect(running).rejects.toMatchObject({ name: "AiRunCancelledError" });
        else await running;
        expect(createSession).toHaveBeenCalledWith(
          {
            botId: "reply-bot",
            chatId: 42,
            userId: 42,
            isAdmin: true,
            isPrivate: true,
            readOnly: false,
          },
          expect.any(AbortSignal),
        );
        expect(bound.dispose).toHaveBeenCalledOnce();
      } finally {
        await runtime.destroy();
      }
    },
  );
});
