import type {
  ImageGenerationActor,
  ImageGenerationPort,
  ImageRouteCapabilities,
} from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiExecutionCoordinator } from "./ai-execution-coordinator.js";
import { createOfflineProviderStream } from "../utils/provider-stream-test-helpers.js";
import {
  ContinuationNotDeliveredError,
  continueChat,
  type ContinueChatConfig,
} from "./continue-chat.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

const CHAT_ID = -100;
const USER_ID = 42;
const FAILURE_MESSAGE = "已记录你的选择，但暂时无法继续处理，请稍后再试。";
const coordinators: AiExecutionCoordinator[] = [];

beforeEach(() => {
  streamTextMock.mockReset();
});

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.destroy();
});

function createCoordinator() {
  const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1, maxQueued: 10 });
  coordinators.push(coordinator);
  return coordinator;
}

function createApi() {
  let nextMessageId = 201;
  const sendMessage = vi.fn(
    async (_chatId: number, text: string) =>
      ({
        message_id: nextMessageId++,
        date: 0,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
        text,
      }) as Message.TextMessage,
  );
  return {
    api: {
      sendChatAction: vi.fn().mockResolvedValue(true),
      sendMessage,
    } as unknown as Api,
    sendMessage,
  };
}

function createConfig(
  coordinator: AiExecutionCoordinator,
  overrides: Partial<ContinueChatConfig> = {},
): ContinueChatConfig {
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
    runWithExecution: async (scope, operation) => {
      const scheduled = coordinator.schedule(scope, operation);
      scheduled.start();
      return scheduled.result;
    },
    ...overrides,
  };
}

function abortableStreamResult(signal: AbortSignal) {
  const text = new Promise<string>((_resolve, reject) => {
    const rejectFromAbort = () => reject(signal.reason ?? new Error("execution aborted"));
    if (signal.aborted) rejectFromAbort();
    else signal.addEventListener("abort", rejectFromAbort, { once: true });
  });
  async function* textStream() {
    yield await text;
  }
  return {
    textStream: textStream(),
    text,
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  };
}

function deniedUsageGovernance(): NonNullable<ContinueChatConfig["usageGovernance"]> {
  return {
    reserve: vi.fn().mockResolvedValue({
      allowed: false,
      reason: "hour",
      scope: "chat",
      subjectKey: String(CHAT_ID),
      limit: 120,
      used: 120,
    }),
    settle: vi.fn(),
    refund: vi.fn(),
    getSnapshot: vi.fn(),
  } as unknown as NonNullable<ContinueChatConfig["usageGovernance"]>;
}

function route(): ImageRouteCapabilities {
  return {
    purpose: "anime_illustration",
    enabled: true,
    provider: "mcp_pixai",
    label: "Anime illustration",
    useWhen: "Generate an anime portrait",
    avoidWhen: "",
    examples: [],
    presets: [],
  };
}

describe("choice continuation tools", () => {
  it.each([1000, undefined])(
    "records whole-turn usage and preserves unknown cache usage (last-step cache: %s)",
    async (cachedTokens) => {
      const onTokenUsage = vi.fn();
      const { api } = createApi();
      async function* textStream() {
        yield "Complete";
      }
      streamTextMock.mockReturnValueOnce({
        textStream: textStream(),
        text: Promise.resolve("Complete"),
        steps: Promise.resolve(
          [800, cachedTokens].map((cached) => ({
            toolCalls: [],
            toolResults: [],
            usage: { raw: { prompt_tokens_details: { cached_tokens: cached } } },
          })),
        ),
        usage: Promise.resolve({ inputTokens: 1200, outputTokens: 20, totalTokens: 1220 }),
        totalUsage: Promise.resolve({ inputTokens: 2200, outputTokens: 30, totalTokens: 2230 }),
      });

      await expect(
        continueChat(api, createConfig(createCoordinator(), { onTokenUsage }), {
          chatId: CHAT_ID,
          userId: USER_ID,
          eventDescription: "usage test",
        }),
      ).resolves.toBe(true);

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
    },
  );

  it.each([
    {
      state: "queued",
      accepted: true,
      deliveryState: undefined,
      expected: "图片请求已提交，排队中（任务 generation-1）",
    },
    {
      state: "succeeded",
      accepted: true,
      deliveryState: "unknown",
      expected: "图片投递结果未知，请核对回执；不会自动重发（任务 generation-1）",
    },
    {
      state: "queued",
      accepted: false,
      deliveryState: undefined,
      expected: "图片生成请求未提交成功，请查看工具错误后再处理",
    },
  ])(
    "keeps selecting identity and reports image state ($state, accepted=$accepted)",
    async ({ state, accepted, deliveryState, expected }) => {
      const coordinator = createCoordinator();
      const onLog = vi.fn();
      const create = vi.fn().mockResolvedValue(
        accepted
          ? {
              accepted: true,
              generation: {
                id: "generation-1",
                purpose: "anime_illustration",
                provider: "mcp_pixai",
                state,
                deliveryState,
                approval: "not_required",
                artifacts: [],
                createdAt: "2026-09-17T00:00:00.000Z",
                updatedAt: "2026-09-17T00:00:00.000Z",
              },
            }
          : { accepted: false, reason: "provider_unavailable" },
      );
      const imageGenerationPort = {
        listRoutes: vi.fn().mockResolvedValue([route()]),
        create,
      } as unknown as ImageGenerationPort;
      let executeImage!: Promise<unknown>;
      streamTextMock.mockImplementationOnce((options: { tools: Record<string, Tool> }) => {
        const createImage = options.tools.create_image;
        expect(createImage?.execute).toBeTypeOf("function");
        executeImage = createImage!.execute!(
          {
            purpose: "anime_illustration",
            routingIntent: "semantic",
            prompt: "侧脸少年，冷感插画风",
          },
          { abortSignal: new AbortController().signal } as never,
        );
        async function* textStream() {
          await executeImage;
          yield "";
        }
        return {
          textStream: textStream(),
          text: Promise.resolve(""),
          steps: Promise.resolve([]),
          totalUsage: Promise.reject(new Error("usage metadata failed after tool delivery")),
        };
      });
      const { api, sendMessage } = createApi();
      const config = createConfig(coordinator, {
        imageGenerationPort,
        isDelegatedGroupAdmin: vi.fn().mockResolvedValue(true),
        onLog,
      });

      await expect(
        continueChat(api, config, {
          chatId: CHAT_ID,
          userId: USER_ID,
          userName: "Krau",
          eventDescription: "用户 Krau 选择了: 侧脸少年（冷感插画风）",
          requireDelivery: true,
          failureMessage: FAILURE_MESSAGE,
        }),
      ).resolves.toBe(true);

      const actor: ImageGenerationActor = {
        botId: "bot-1",
        chatId: CHAT_ID,
        userId: USER_ID,
        chatType: "supergroup",
        isBotAdmin: false,
        isDelegatedGroupAdmin: true,
        requestContext: { threadId: undefined, traceId: undefined },
      };
      expect(imageGenerationPort.listRoutes).toHaveBeenCalledWith(actor, { includePresets: false });
      expect(create).toHaveBeenCalledWith(actor, {
        purpose: "anime_illustration",
        routingIntent: "semantic",
        prompt: "侧脸少年，冷感插画风",
      });
      expect(sendMessage).toHaveBeenCalledWith(CHAT_ID, expected, undefined);
      expect(sendMessage).not.toHaveBeenCalledWith(CHAT_ID, FAILURE_MESSAGE);
      expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).toContain("侧脸少年");
      const requestLog = onLog.mock.calls.find(
        ([entry]) => entry.message === "AI continuation request",
      )?.[0];
      const toolLog = onLog.mock.calls.find(([entry]) => entry.message === "AI tool call")?.[0];
      expect(toolLog?.meta).toMatchObject({
        correlationId: requestLog?.meta?.correlationId,
        chatId: CHAT_ID,
        userId: USER_ID,
        eventType: "continuation",
        toolName: "create_image",
      });
    },
  );

  it("logs bounded continuation request and response content in one diagnostic scope", async () => {
    const coordinator = createCoordinator();
    const onLog = vi.fn();
    async function* textStream() {
      yield "continuation answer";
    }
    streamTextMock.mockReturnValueOnce({
      textStream: textStream(),
      text: Promise.resolve("continuation answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
    });
    const { api } = createApi();

    await expect(
      continueChat(api, createConfig(coordinator, { onLog }), {
        chatId: CHAT_ID,
        userId: USER_ID,
        userName: "Krau",
        eventDescription: "diagnostic event body",
        requireDelivery: true,
      }),
    ).resolves.toBe(true);

    const entries = onLog.mock.calls.map(([entry]) => entry);
    const request = entries.find((entry) => entry.message === "AI continuation request");
    const response = entries.find((entry) => entry.message === "AI continuation response");
    const completed = entries.find((entry) => entry.message === "continueChat completed");
    expect(request?.meta).toMatchObject({
      botId: "bot-1",
      chatId: CHAT_ID,
      userId: USER_ID,
      eventType: "continuation",
      providerId: "p",
      model: "model-a",
      eventDescription: "diagnostic event body",
      userName: "Krau",
    });
    expect(JSON.stringify(request?.meta?.messages)).toContain("diagnostic event body");
    expect(response?.meta).toMatchObject({
      correlationId: request?.meta?.correlationId,
      rawResponseText: "continuation answer",
      responseText: "continuation answer",
    });
    expect(completed?.meta).toMatchObject({
      correlationId: request?.meta?.correlationId,
      responseText: "continuation answer",
    });
  });

  it.each([false, true])(
    "returns the original SSE error promptly without replaying a completed tool (closed: %s)",
    async (closeAfterError) => {
      const coordinator = createCoordinator();
      const actualAi = await vi.importActual<typeof import("ai")>("ai");
      const providerError = "Internal error during token generation";
      const offline = createOfflineProviderStream({
        error: providerError,
        closeAfterError,
        completedTool: { name: "get_chat_info", input: {} },
      });
      const toolExecute = vi.fn();
      streamTextMock.mockImplementationOnce((options) => {
        const execute = options.tools.get_chat_info.execute;
        options.tools.get_chat_info.execute = (...args: unknown[]) => {
          toolExecute();
          return execute(...args);
        };
        return actualAi.streamText({ ...options, model: offline.model });
      });
      const onLog = vi.fn();
      const { api, sendMessage } = createApi();
      api.getChat = vi.fn().mockResolvedValue({ id: CHAT_ID, type: "supergroup", title: "Test" });
      api.getChatMemberCount = vi.fn().mockResolvedValue(3);
      const run = continueChat(
        api,
        createConfig(coordinator, {
          onLog,
          timeoutConfig: { ...DEFAULT_TIMEOUT_CONFIG, aiReplyMs: 10_000, perStepMs: 10_000 },
        }),
        {
          chatId: CHAT_ID,
          userId: USER_ID,
          eventDescription: "provider failure event",
          requireDelivery: true,
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await vi.waitFor(
          () =>
            expect(onLog).toHaveBeenCalledWith(
              expect.objectContaining({ message: `continueChat failed: ${providerError}` }),
            ),
          { timeout: 500 },
        );
        expect(await run).toBe(providerError);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(offline.fetch).toHaveBeenCalledTimes(2);
        expect(toolExecute).toHaveBeenCalledOnce();
        if (!closeAfterError) expect(offline.onAbort).toHaveBeenCalledOnce();
      } finally {
        await coordinator.cancelChat(CHAT_ID);
        await run;
      }
    },
  );

  it.each(["overall", "step"])("preserves a genuine %s timeout cause", async (kind) => {
    const coordinator = createCoordinator();
    const actualAi = await vi.importActual<typeof import("ai")>("ai");
    const offline = createOfflineProviderStream({ error: null });
    streamTextMock.mockImplementationOnce((options) =>
      actualAi.streamText({ ...options, model: offline.model }),
    );
    const { api, sendMessage } = createApi();
    await expect(
      continueChat(
        api,
        createConfig(coordinator, {
          timeoutConfig: {
            ...DEFAULT_TIMEOUT_CONFIG,
            aiReplyMs: kind === "overall" ? 30 : 10_000,
            perStepMs: kind === "step" ? 30 : 10_000,
          },
        }),
        {
          chatId: CHAT_ID,
          userId: USER_ID,
          eventDescription: "timeout event",
          requireDelivery: true,
        },
      ),
    ).rejects.toMatchObject({
      message:
        kind === "overall"
          ? "The operation was aborted due to timeout"
          : "Per-step timeout: 30ms exceeded",
    });
    expect(offline.onAbort).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves active SDK cancellation without emitting a failure notice", async () => {
    const coordinator = createCoordinator();
    const actualAi = await vi.importActual<typeof import("ai")>("ai");
    const offline = createOfflineProviderStream({ error: null });
    streamTextMock.mockImplementationOnce((options) =>
      actualAi.streamText({ ...options, model: offline.model }),
    );
    const { api, sendMessage } = createApi();
    const run = continueChat(api, createConfig(coordinator), {
      chatId: CHAT_ID,
      userId: USER_ID,
      eventDescription: "cancel event",
      requireDelivery: true,
      failureMessage: FAILURE_MESSAGE,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(offline.fetch).toHaveBeenCalledOnce());
    await coordinator.cancelChat(CHAT_ID);
    expect(await run).toMatchObject({ reason: "execution_cancelled" });
    expect(offline.onAbort).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalledWith(CHAT_ID, FAILURE_MESSAGE);
  });

  it("reports a provider error after partial text without delivering the partial summary as complete", async () => {
    const coordinator = createCoordinator();
    const actualAi = await vi.importActual<typeof import("ai")>("ai");
    const providerError = "Internal error during token generation";
    const offline = createOfflineProviderStream({
      error: providerError,
      textBeforeError: "部分总结",
    });
    streamTextMock.mockImplementationOnce((options) =>
      actualAi.streamText({ ...options, model: offline.model }),
    );
    const { api, sendMessage } = createApi();
    await expect(
      continueChat(api, createConfig(coordinator), {
        chatId: CHAT_ID,
        userId: USER_ID,
        eventDescription: "partial event",
        requireDelivery: true,
      }),
    ).rejects.toBe(providerError);
    expect(offline.onAbort).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the original provider error when the stream ends as NoOutputGenerated", async () => {
    const coordinator = createCoordinator();
    const onLog = vi.fn();
    const providerError = Object.assign(new Error("upstream rejected request"), {
      statusCode: 429,
      responseBody: {
        error: "rate limited",
        authorization: "Bearer provider-secret-value",
      },
    });
    const finalError = new Error("No output generated");
    finalError.name = "AI_NoOutputGeneratedError";
    streamTextMock.mockImplementationOnce(
      (options: { onError?: (event: { error: unknown }) => void }) => {
        async function* textStream() {
          options.onError?.({ error: providerError });
          yield await Promise.reject(finalError);
        }
        return {
          textStream: textStream(),
          text: Promise.resolve(""),
          steps: Promise.resolve([]),
          totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        };
      },
    );
    const { api } = createApi();

    await expect(
      continueChat(api, createConfig(coordinator, { onLog }), {
        chatId: CHAT_ID,
        userId: USER_ID,
        eventDescription: "provider failure event",
        requireDelivery: true,
      }),
    ).rejects.toBe(providerError);

    const entries = onLog.mock.calls.map(([entry]) => entry);
    const providerFailure = entries.find(
      (entry) => entry.message === "AI continuation provider stream error",
    );
    const finalFailure = entries.find((entry) =>
      String(entry.message).startsWith("continueChat failed:"),
    );
    expect(providerFailure?.meta).toMatchObject({
      providerId: "p",
      model: "model-a",
      error: {
        name: "Error",
        message: "upstream rejected request",
        statusCode: 429,
        responseBody: {
          error: "rate limited",
          authorization: "[REDACTED]",
        },
      },
    });
    expect(providerFailure?.meta?.error).toHaveProperty("stack");
    expect(finalFailure?.meta).toMatchObject({
      correlationId: providerFailure?.meta?.correlationId,
      error: { message: "upstream rejected request", statusCode: 429 },
      providerError: {
        message: "upstream rejected request",
        statusCode: 429,
      },
    });
  });

  it("surfaces selection resolution failures before model execution", async () => {
    const onLog = vi.fn();
    const config = {
      resolveSelection: () => {
        throw new Error("configured provider is unavailable");
      },
      onLog,
    } as unknown as ContinueChatConfig;

    await expect(
      continueChat({} as Api, config, {
        chatId: CHAT_ID,
        userId: USER_ID,
        eventDescription: "用户 Krau 选择了: 侧脸少年",
        requireDelivery: true,
      }),
    ).rejects.toThrow("configured provider is unavailable");

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "continueChat failed: configured provider is unavailable",
      }),
    );
  });

  it("delivers an ordinary model failure inside the coordinator lifecycle", async () => {
    const coordinator = createCoordinator();
    streamTextMock.mockImplementationOnce(() => {
      throw new Error("model unavailable");
    });
    const { api, sendMessage } = createApi();

    await expect(
      continueChat(api, createConfig(coordinator), {
        chatId: CHAT_ID,
        userId: USER_ID,
        eventDescription: "用户 Krau 选择了: 侧脸少年",
        requireDelivery: true,
        failureMessage: FAILURE_MESSAGE,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(CHAT_ID, FAILURE_MESSAGE);
  });

  it("does not expose a usage-denied choice when personalization is off", async () => {
    const coordinator = createCoordinator();
    const getMode = vi.fn().mockResolvedValue("off");
    const runExclusive = vi.fn(async (_userId: number, operation: () => Promise<boolean>) =>
      operation(),
    );
    const { api, sendMessage } = createApi();

    await expect(
      continueChat(
        api,
        createConfig(coordinator, {
          usageGovernance: deniedUsageGovernance(),
          privacy: { getMode, runExclusive } as unknown as NonNullable<
            ContinueChatConfig["privacy"]
          >,
        }),
        {
          chatId: CHAT_ID,
          userId: USER_ID,
          eventDescription: "用户 Krau 选择了: 侧脸少年",
          requireDelivery: true,
          failureMessage: FAILURE_MESSAGE,
        },
      ),
    ).rejects.toMatchObject({ reason: "usage_denied" });

    expect(runExclusive).toHaveBeenCalledWith(USER_ID, expect.any(Function));
    expect(getMode).toHaveBeenCalledWith(USER_ID);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rechecks privacy after a usage-denied notice waits in the execution queue", async () => {
    const coordinator = createCoordinator();
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = coordinator.schedule({ chatId: CHAT_ID, userId: USER_ID }, async () => {
      await blockerGate;
      return true;
    });
    blocker.start();
    await vi.waitFor(() => expect(coordinator.stats.started).toBe(1));

    let privacyMode: "standard" | "off" = "standard";
    const modesRead: string[] = [];
    const getMode = vi.fn(async () => {
      modesRead.push(privacyMode);
      return privacyMode;
    });
    const runExclusive = vi.fn(async (_userId: number, operation: () => Promise<boolean>) =>
      operation(),
    );
    const { api, sendMessage } = createApi();
    const continuation = continueChat(
      api,
      createConfig(coordinator, {
        usageGovernance: deniedUsageGovernance(),
        privacy: { getMode, runExclusive } as unknown as NonNullable<ContinueChatConfig["privacy"]>,
      }),
      {
        chatId: CHAT_ID,
        userId: USER_ID,
        eventDescription: "用户 Krau 选择了: 侧脸少年",
        requireDelivery: true,
        failureMessage: FAILURE_MESSAGE,
      },
    );
    await vi.waitFor(() => expect(coordinator.stats.queued).toBe(1));

    privacyMode = "off";
    releaseBlocker();

    await expect(blocker.result).resolves.toBe(true);
    await expect(continuation).rejects.toMatchObject({ reason: "usage_denied" });
    expect(modesRead).toEqual(["off"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not report complete failure after multi_message delivered before the stream failed", async () => {
    const coordinator = createCoordinator();
    streamTextMock.mockImplementationOnce((options: { tools: Record<string, Tool> }) => {
      const multiMessage = options.tools.multi_message;
      expect(multiMessage?.execute).toBeTypeOf("function");
      async function* textStream() {
        await multiMessage!.execute!(
          { messages: [{ text: "第一条已送达" }, { text: "第二条发送失败" }] },
          { abortSignal: new AbortController().signal } as never,
        );
        yield "";
        throw new Error("provider stream failed after tool delivery");
      }
      return {
        textStream: textStream(),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      };
    });
    const { api, sendMessage } = createApi();
    sendMessage.mockImplementation(async (_chatId: number, text: string) => {
      if (text === "第二条发送失败") throw new Error("telegram send failed");
      return {
        message_id: 201,
        date: 0,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test group" },
        text,
      } as Message.TextMessage;
    });

    await expect(
      continueChat(api, createConfig(coordinator), {
        chatId: CHAT_ID,
        userId: USER_ID,
        eventDescription: "用户 Krau 选择了: 侧脸少年",
        requireDelivery: true,
        failureMessage: FAILURE_MESSAGE,
      }),
    ).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(CHAT_ID, "第一条已送达", undefined);
    expect(sendMessage).not.toHaveBeenCalledWith(CHAT_ID, FAILURE_MESSAGE);
  });

  it("does not emit a failure notice when an active continuation is cancelled", async () => {
    const coordinator = createCoordinator();
    streamTextMock.mockImplementationOnce((options: { abortSignal: AbortSignal }) =>
      abortableStreamResult(options.abortSignal),
    );
    const { api, sendMessage } = createApi();
    const continuation = continueChat(api, createConfig(coordinator), {
      chatId: CHAT_ID,
      userId: USER_ID,
      eventDescription: "用户 Krau 选择了: 侧脸少年",
      requireDelivery: true,
      failureMessage: FAILURE_MESSAGE,
    });
    const outcome = continuation.then(
      (value) => value,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());

    await coordinator.cancelChat(CHAT_ID);

    const error = await outcome;
    expect(error).toBeInstanceOf(ContinuationNotDeliveredError);
    expect((error as ContinuationNotDeliveredError).reason).toBe("execution_cancelled");
    expect(sendMessage).not.toHaveBeenCalledWith(CHAT_ID, FAILURE_MESSAGE);
  });

  it("does not emit a failure notice when a queued continuation is cancelled", async () => {
    const coordinator = createCoordinator();
    streamTextMock.mockImplementationOnce((options: { abortSignal: AbortSignal }) =>
      abortableStreamResult(options.abortSignal),
    );
    const { api, sendMessage } = createApi();
    const config = createConfig(coordinator);
    const first = continueChat(api, config, {
      chatId: CHAT_ID,
      userId: USER_ID,
      eventDescription: "first choice",
      requireDelivery: true,
      failureMessage: FAILURE_MESSAGE,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledOnce());
    const queued = continueChat(api, config, {
      chatId: CHAT_ID,
      userId: USER_ID,
      eventDescription: "queued choice",
      requireDelivery: true,
      failureMessage: FAILURE_MESSAGE,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(coordinator.stats.queued).toBe(1));

    await coordinator.cancelChat(CHAT_ID);

    expect(await first).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalledWith(CHAT_ID, FAILURE_MESSAGE);
  });
});

it("redacts continuation credentials before request and tool diagnostics are truncated", async () => {
  const secret = "private-continuation-key";
  const text = "x".repeat(16_380) + secret;
  const onLog = vi.fn();
  streamTextMock.mockImplementationOnce(({ tools }) => {
    async function* textStream() {
      await tools.inspect.execute({ text }, { toolCallId: "inspect-1", messages: [] });
      yield "done";
    }
    return {
      textStream: textStream(),
      text: Promise.resolve("done"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
    };
  });
  const { api } = createApi();
  await expect(
    continueChat(
      api,
      createConfig(createCoordinator(), {
        onLog,
        diagnosticSecrets: [secret],
        webTools: { inspect: { execute: async () => ({ text }) } as unknown as Tool },
      }),
      {
        chatId: CHAT_ID,
        userId: USER_ID,
        eventDescription: text,
        requireDelivery: true,
      },
    ),
  ).resolves.toBe(true);
  const entries = onLog.mock.calls.map(([entry]) => entry);
  for (const message of ["AI continuation request", "AI tool call", "AI tool result"]) {
    const entry = entries.find((item) => item.message === message);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain("priv");
    expect(JSON.stringify(entry)).toContain("truncated");
  }
});
