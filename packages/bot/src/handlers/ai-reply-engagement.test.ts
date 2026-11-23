import { beginTaskDiscussion, endTaskDiscussion } from "../services/task-discussion.js";
import type { ScheduledTaskPort, ScheduledTaskRecord } from "@cos-tool-bot/shared";
import { AiExecutionCoordinator } from "../services/ai-execution-coordinator.js";
import { AiReplyQueueFullError } from "../services/ai-reply-scheduler.js";
import {
  ENGAGEMENT_MODEL,
  type EngagementSample,
  type ConversationCallbacks,
  type UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotContext } from "../context.js";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

const runtimes: Array<ReturnType<typeof createAiReplyHandler>> = [];

beforeEach(() => streamTextMock.mockReset());
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.destroy()));
});

function responseBody(choice: "addressed" | "continue" | "join" | "silent") {
  return {
    model: ENGAGEMENT_MODEL,
    answers: {
      reply: {
        type: "choice",
        choice: choice === "silent" ? "silent" : "answer",
        confidence: 0.9,
        probabilities: {
          answer: choice === "silent" ? 0.05 : 0.95,
          silent: choice === "silent" ? 0.95 : 0.05,
        },
      },
      participation: {
        type: "choice",
        choice: choice === "addressed" ? "addressed" : choice === "continue" ? "continue" : "join",
        confidence: 0.9,
        probabilities: {
          addressed: choice === "addressed" ? 0.95 : 0,
          continue: choice === "addressed" ? 0.025 : choice === "continue" ? 0.95 : 0.05,
          join: choice === "addressed" ? 0.025 : choice === "continue" ? 0.05 : 0.95,
        },
      },
    },
    usage: { input_tokens: 10 },
  };
}

function response(choice: "addressed" | "continue" | "join" | "silent") {
  return new Response(JSON.stringify(responseBody(choice)), { status: 200 });
}

function privacy(
  getMode: UserPrivacyCallbacks["getMode"] = async () => "normal",
): UserPrivacyCallbacks {
  return {
    getMode,
    runExclusive: vi.fn(async (_userId, operation) => operation()),
    setMode: vi.fn(),
    forget: vi.fn(),
  } satisfies UserPrivacyCallbacks;
}

function config(
  mode: "off" | "shadow" | "active",
  onEngagementSample = vi.fn<(sample: EngagementSample) => void>(),
  privacyCallbacks = privacy(),
): AiReplyConfig {
  return {
    botId: "bot-1",
    apiKey: "model-key",
    baseURL: "https://model.example/v1",
    model: "model",
    systemPrompt: "system",
    triggerConfig: {
      replyToBot: false,
      mentionBot: false,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    engagement: {
      apiKey: "jev-key",
      mode,
      style: "natural",
      preferences: "",
      keywordDirect: false,
      cooldownSeconds: 60,
      confidenceThreshold: 0.8,
      addressedConfidenceThreshold: 0.8,
      continueConfidenceThreshold: 0.8,
      continuationWindowSeconds: 120,
      contextMessages: 20,
      timeoutMs: 1000,
    },
    groupOverrides: { "-100": { chatId: -100, whitelisted: true } },
    adminChatIds: [],
    privacy: privacyCallbacks,
    token: "token",
    onEngagementSample,
  };
}

function context(
  text: string,
  options: {
    messageId?: number;
    userId?: number;
    threadId?: number;
    isPrivate?: boolean;
    entities?: Array<{ type: "mention"; offset: number; length: number }>;
  } = {},
): BotContext {
  return {
    update: { update_id: options.messageId ?? 1 },
    message: {
      message_id: options.messageId ?? 1,
      date: 1_700_000_000,
      text,
      entities: options.entities ?? [],
      message_thread_id: options.threadId,
    },
    chat: options.isPrivate
      ? { id: options.userId ?? 42, type: "private", first_name: "Tester" }
      : { id: -100, type: "supergroup", title: "Public group" },
    from: { id: options.userId ?? 42, is_bot: false, first_name: "Tester" },
    me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
    api: { sendChatAction: vi.fn() },
    replyWithChatAction: vi.fn(),
    resolveWait: vi.fn().mockResolvedValue(20),
    deleteWaiting: vi.fn(),
    directlyReply: vi.fn(),
  } as unknown as BotContext;
}

function streamResult(text = "answer") {
  async function* textStream() {
    yield text;
  }
  return {
    textStream: textStream(),
    text: Promise.resolve(text),
    steps: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    finishReason: Promise.resolve("stop"),
  };
}

describe("AI engagement decisions", () => {
  it("accepts configuration follow-ups before a plan card exists", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = config("active");
    cfg.scheduledTasks = {
      getPendingDiscussion: vi.fn().mockResolvedValue(null),
    } as unknown as ScheduledTaskPort;
    const actor = {
      botId: cfg.botId,
      chatId: -100,
      userId: 42,
      userName: "Tester",
      isAdmin: false,
    };
    beginTaskDiscussion(actor);
    streamTextMock.mockImplementation(() => streamResult());
    const runtime = createAiReplyHandler(cfg);
    runtimes.push(runtime);
    try {
      await runtime.handler(context("每个月一号", { messageId: 1 }), vi.fn());
      await runtime.handler(context("上午九点", { messageId: 2 }), vi.fn());
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.stringify(streamTextMock.mock.calls[1])).toContain("用户正在补充定时任务配置");
    } finally {
      endTaskDiscussion(actor);
    }
  });

  it.each([true, false])(
    "keeps task configuration responsive and records only actual topic identity (%s)",
    async (isTopic) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("silent"));
      vi.stubGlobal("fetch", fetchMock);
      const cfg = config("active");
      cfg.scheduledTasks = {
        getPendingDiscussion: vi.fn().mockResolvedValue({
          id: "task-pending",
          pendingVersion: 2,
          pendingPlan: { name: "monthly" },
        } as ScheduledTaskRecord),
      } as unknown as ScheduledTaskPort;
      const upsertUserMessage = vi.fn().mockResolvedValue({ id: 1 });
      const addMessages = vi.fn();
      cfg.conversation = {
        getHistory: async () => ({ summary: null, messages: [] }),
        addMessage: vi.fn(),
        addMessages,
        upsertUserMessage,
        triggerCompression: vi.fn(),
        clearHistory: vi.fn(),
      };
      cfg.messageConfig = {
        replyMode: "segment",
        richMessageEnabled: false,
        autoSplitThreshold: 0,
        splitDelayMs: 0,
      };
      streamTextMock.mockImplementation(() => streamResult());
      const runtime = createAiReplyHandler(cfg);
      runtimes.push(runtime);
      const first = context("改成每月一次", { messageId: 1, threadId: 7 });
      const second = context("周一发到本群", { messageId: 2, threadId: 7 });
      if (isTopic) {
        first.message!.is_topic_message = true;
        second.message!.is_topic_message = true;
      }
      await runtime.handler(first, vi.fn());
      await runtime.handler(second, vi.fn());
      expect(upsertUserMessage.mock.calls[0]![0].meta.threadId).toBe(isTopic ? 7 : null);
      const assistant = addMessages.mock.calls
        .flatMap(([rows]) => rows)
        .find((row) => row.role === "assistant");
      expect(assistant.meta.threadId).toBe(isTopic ? 7 : null);
      expect(assistant.meta).toHaveProperty("threadId");
      expect(upsertUserMessage.mock.calls[0]![0].meta).toHaveProperty("threadId");
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.stringify(streamTextMock.mock.calls[1])).toContain("task-pending");
    },
  );

  it("uses edited text in the next prompt and engagement context, including after handler restart", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response("addressed"));
    vi.stubGlobal("fetch", fetchMock);
    const rows: Parameters<ConversationCallbacks["addMessages"]>[0] = [];
    const conversation: ConversationCallbacks = {
      getHistory: async () => ({
        summary: null,
        messages: rows
          .filter((row) => row.role === "assistant")
          .map((row) => ({
            role: row.role,
            content: row.content,
            userName: null,
            tgMessageId: row.meta?.["tgMessageId"] as number,
          })),
      }),
      addMessage: async (row) => {
        rows.push(row);
      },
      addMessages: async (batch) => {
        rows.push(...batch);
      },
      findOwnMessage: async (chatId, messageId) =>
        rows.some(
          (row) =>
            row.chatId === chatId &&
            row.role === "assistant" &&
            row.meta?.["tgMessageId"] === messageId,
        ),
      updateOwnMessage: async (chatId, messageId, content) => {
        const row = rows.find(
          (row) =>
            row.chatId === chatId &&
            row.role === "assistant" &&
            row.meta?.["tgMessageId"] === messageId,
        );
        if (!row) throw new Error("missing history");
        row.content = content;
      },
      triggerCompression: vi.fn(),
      clearHistory: vi.fn(),
    };
    const runtimeConfig = config("active");
    runtimeConfig.conversation = conversation;
    runtimeConfig.messageConfig = {
      replyMode: "segment",
      richMessageEnabled: false,
      autoSplitThreshold: 0,
      splitDelayMs: 0,
    };
    const prompts: string[] = [];
    const editResults: unknown[] = [];
    let turn = 0;
    streamTextMock.mockImplementation(
      (options: {
        messages: unknown[];
        tools: Record<string, { execute: (input: unknown) => Promise<unknown> }>;
      }) => {
        prompts.push(JSON.stringify(options.messages));
        const current = ++turn;
        const result = streamResult(current === 1 ? "obsolete bot answer" : "done");
        if (current === 2)
          result.textStream = (async function* () {
            editResults.push(
              await options.tools.edit_own_message!.execute({
                message_id: 20,
                text: "corrected bot answer",
              }),
            );
            yield "done";
          })();
        return result;
      },
    );
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);
    const makeContext = (messageId: number) => {
      const ctx = context("please answer", { messageId });
      ctx.wait = vi.fn().mockResolvedValue(30);
      ctx.api.editMessageText = vi.fn().mockResolvedValue({ message_id: 20 });
      vi.mocked(ctx.resolveWait).mockResolvedValue(messageId === 1 ? 20 : messageId + 20);
      return ctx;
    };
    await runtime.handler(makeContext(1), vi.fn());
    await runtime.handler(makeContext(2), vi.fn());
    await runtime.handler(makeContext(3), vi.fn());
    expect(editResults).toEqual([{ success: true, history_synced: true }]);
    expect(turn).toBe(3);
    expect(prompts[1]).toContain("#20");
    expect(prompts[2]).toContain("corrected bot answer");
    expect(prompts[2]).not.toContain("obsolete bot answer");
    const gate = String(fetchMock.mock.calls[2]?.[1]?.body);
    expect(gate).toContain("corrected bot answer");
    expect(gate).not.toContain("obsolete bot answer");
    await runtime.destroy();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const restarted = createAiReplyHandler(runtimeConfig);
    runtimes.push(restarted);
    await restarted.handler(makeContext(4), vi.fn());
    expect(prompts[3]).toContain("#20");
    expect(prompts[3]).toContain("corrected bot answer");
    expect(prompts[3]).not.toContain("obsolete bot answer");
    streamTextMock.mockReset();
  });

  it("sends the bot identity and effective group trigger words to the gate", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    const runtimeConfig = config("active");
    runtimeConfig.triggerConfig.triggerWords = ["default nickname"];
    runtimeConfig.groupOverrides["-100"]!.triggerConfig = { triggerWords: ["助手"] };
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);
    await runtime.handler(context("助手怎么不说话"), vi.fn());
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.state.assistant).toEqual({
      displayName: "Ai",
      username: "sample_bot",
      configuredTriggerWords: ["助手"],
    });
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("does not hold message ingress while shadow evaluations are pending", async () => {
    const releases: Array<(value: Response) => void> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(config("shadow", onSample));
    runtimes.push(runtime);

    await runtime.handler(context("first ambient", { messageId: 1 }), vi.fn());
    await runtime.handler(context("second ambient", { messageId: 2 }), vi.fn());

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSample).not.toHaveBeenCalled();
    releases[0]!(response("silent"));
    releases[1]!(response("join"));
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledTimes(2));
    expect(onSample.mock.calls.map(([sample]) => sample.actualTrigger)).toEqual([null, null]);
  });

  it("does not hold shadow ingress on the asynchronous context privacy recheck", async () => {
    let releasePrivacy!: () => void;
    const privacyPending = new Promise<void>((resolve) => {
      releasePrivacy = resolve;
    });
    let calls = 0;
    const privacyCallbacks = privacy(async () => {
      calls++;
      if (calls > 1) await privacyPending;
      return "normal";
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createAiReplyHandler(config("shadow", vi.fn(), privacyCallbacks));
    runtimes.push(runtime);

    await runtime.handler(context("ambient text"), vi.fn());

    expect(fetchMock).not.toHaveBeenCalled();
    releasePrivacy();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });

  it("bypasses JEV for an entity mention in active mode even when legacy mention is disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    streamTextMock.mockReturnValue(streamResult());
    const runtime = createAiReplyHandler(config("active"));
    runtimes.push(runtime);
    const text = "hey @sample_bot";

    await runtime.handler(
      context(text, {
        entities: [{ type: "mention", offset: 4, length: 11 }],
      }),
      vi.fn(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).not.toContain(
      "本轮群聊参与指导",
    );
  });

  it.each([
    ["addressed", "认真按问题实际需要回应", ["直接接上当前交流", "这是一次主动加入群聊"]],
    ["continue", "直接接上当前交流", ["认真按问题实际需要回应", "这是一次主动加入群聊"]],
    ["join", "这是一次主动加入群聊", ["认真按问题实际需要回应", "直接接上当前交流"]],
  ] as const)(
    "passes active %s participation to the reply model without replacing owner prompts",
    async (choice, expectedGuidance, excludedGuidance) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response(choice)));
      streamTextMock.mockReturnValue(streamResult());
      const runtimeConfig = config("active");
      runtimeConfig.systemPrompt = "owner system persona";
      runtimeConfig.groupBehavioralPrompt = "owner group behavior";
      const runtime = createAiReplyHandler(runtimeConfig);
      runtimes.push(runtime);

      await runtime.handler(context("group message"), vi.fn());

      expect(streamTextMock).toHaveBeenCalledOnce();
      const prompt = JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages);
      expect(prompt).toContain("owner system persona");
      expect(prompt).toContain("owner group behavior");
      expect(prompt).toContain(expectedGuidance);
      expect(prompt).toContain("继续遵循既有角色、提示词和工具使用判断");
      for (const excluded of excludedGuidance) expect(prompt).not.toContain(excluded);
    },
  );

  it.each(["off", "shadow"] as const)("keeps %s mode on the legacy prompt path", async (mode) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("join"));
    vi.stubGlobal("fetch", fetchMock);
    streamTextMock.mockReturnValue(streamResult());
    const runtimeConfig = config(mode);
    runtimeConfig.triggerConfig.triggerWords = ["wake"];
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("wake up"), vi.fn());

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).not.toContain(
      "本轮群聊参与指导",
    );
    expect(fetchMock).toHaveBeenCalledTimes(mode === "shadow" ? 1 : 0);
  });

  it("does not add participation guidance to an active provider-error fallback", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("bad json")));
    streamTextMock.mockReturnValue(streamResult());
    const runtimeConfig = config("active");
    runtimeConfig.triggerConfig.triggerWords = ["wake"];
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("wake up"), vi.fn());

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).not.toContain(
      "本轮群聊参与指导",
    );
  });

  it("keeps private chats on their existing prompt path", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    streamTextMock.mockReturnValue(streamResult());
    const runtime = createAiReplyHandler(config("active"));
    runtimes.push(runtime);
    const privateContext = context("private question", { isPrivate: true });

    await runtime.handler(privateContext, vi.fn());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).not.toContain(
      "本轮群聊参与指导",
    );
  });

  it("does not persist active participation guidance into a later explicit turn", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("join"));
    vi.stubGlobal("fetch", fetchMock);
    streamTextMock.mockImplementation(() => streamResult());
    const runtime = createAiReplyHandler(config("active"));
    runtimes.push(runtime);

    await runtime.handler(context("join this discussion", { messageId: 1 }), vi.fn());
    await runtime.handler(
      context("hey @sample_bot", {
        messageId: 2,
        entities: [{ type: "mention", offset: 4, length: 11 }],
      }),
      vi.fn(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).toContain(
      "这是一次主动加入群聊",
    );
    expect(JSON.stringify(streamTextMock.mock.calls[1]?.[0]?.messages)).not.toContain(
      "本轮群聊参与指导",
    );
  });

  it("keeps a JEV silent decision out of the reply scheduler and records no admission", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response("silent")));
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(config("active", onSample));
    runtimes.push(runtime);
    const next = vi.fn();

    await runtime.handler(context("ambient discussion"), next);
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({ choice: "silent", actualTrigger: null }),
    );
  });

  it("does not call JEV for filter style without a legacy keyword or random candidate", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const runtimeConfig = config("active");
    runtimeConfig.engagement = { ...runtimeConfig.engagement!, style: "filter" };
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);
    const next = vi.fn();

    await runtime.handler(context("ordinary ambient discussion"), next);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("lets keywordDirect bypass JEV and records the deterministic admission", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    streamTextMock.mockReturnValue(streamResult());
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtimeConfig = config("active", onSample);
    runtimeConfig.triggerConfig.triggerWords = ["wake"];
    runtimeConfig.engagement = { ...runtimeConfig.engagement!, keywordDirect: true };
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("wake up"), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(streamTextMock.mock.calls[0]?.[0]?.messages)).not.toContain(
      "本轮群聊参与指导",
    );
    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: "keyword_direct",
        actualTrigger: "keyword",
        confidence: null,
        inputTokens: 0,
      }),
    );
  });

  it("rolls a legacy random candidate once when a JEV failure falls back", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("bad json")));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    streamTextMock.mockReturnValue(streamResult());
    const reserve = vi.fn().mockResolvedValue(undefined);
    const runtimeConfig = config("active");
    runtimeConfig.triggerConfig.randomReplyPercent = 100;
    runtimeConfig.triggerConfig.randomReplyCooldown = 0;
    runtimeConfig.usageGovernance = {
      reserve,
      settle: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn(),
    } as never;
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("random candidate"), vi.fn());

    expect(random).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "proactive_reply", userId: undefined }),
    );
    expect(streamTextMock).toHaveBeenCalledOnce();
    random.mockRestore();
  });

  it("commits join cooldown only after proactive usage admission succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => response("join")),
    );
    streamTextMock.mockReturnValue(streamResult());
    const reserve = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: false,
        reason: "cooldown",
        scope: "chat",
        subjectKey: "-100",
        limit: 1,
        used: 1,
      })
      .mockResolvedValueOnce({
        allowed: true,
        reservationId: "reservation-2",
        reservedUnits: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtimeConfig = config("active", onSample);
    runtimeConfig.usageGovernance = {
      reserve,
      settle: vi.fn().mockResolvedValue(undefined),
      refund: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn(),
    } as never;
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("first join", { messageId: 1 }), vi.fn());
    await runtime.handler(context("second join", { messageId: 2 }), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledTimes(2));

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(onSample.mock.calls[0]?.[0]).toMatchObject({
      reasonCode: "usage_denied",
      actualTrigger: null,
    });
    expect(onSample.mock.calls[1]?.[0]).toMatchObject({
      reasonCode: "jev_answer",
      actualTrigger: "engagement_join",
    });
  });

  it("does not spend the engagement cooldown when scheduler admission fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => response("join")),
    );
    streamTextMock.mockReturnValue(streamResult());
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(config("active", onSample));
    runtimes.push(runtime);
    vi.spyOn(AiExecutionCoordinator.prototype, "schedule").mockImplementationOnce(() => {
      throw new AiReplyQueueFullError(100);
    });
    const first = context("queue full candidate", { messageId: 1 });
    vi.mocked(first.directlyReply).mockResolvedValue(undefined as never);
    await runtime.handler(first, vi.fn());
    await runtime.handler(context("next admitted candidate", { messageId: 2 }), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledTimes(2));
    expect(onSample.mock.calls[0]?.[0]).toMatchObject({
      reasonCode: "queue_full",
      actualTrigger: null,
    });
    expect(onSample.mock.calls[1]?.[0]).toMatchObject({ actualTrigger: "engagement_join" });
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("lets a recent bot utterance continue through an active join cooldown", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => response("join"))
      .mockImplementationOnce(async () => response("continue"));
    vi.stubGlobal("fetch", fetchMock);
    streamTextMock.mockReturnValue(streamResult());
    const runtime = createAiReplyHandler(config("active"));
    runtimes.push(runtime);

    await runtime.handler(context("join this discussion", { messageId: 1 }), vi.fn());
    await runtime.handler(context("and what next?", { messageId: 2 }), vi.fn());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "at the configured boundary",
      continuationWindowSeconds: 30,
      elapsedMs: 30_000,
      expectedReplies: 2,
      expectedSecondTrigger: "engagement_continue",
    },
    {
      name: "after the configured boundary",
      continuationWindowSeconds: 30,
      elapsedMs: 30_001,
      expectedReplies: 1,
      expectedSecondTrigger: null,
    },
    {
      name: "when the exemption is disabled",
      continuationWindowSeconds: 0,
      elapsedMs: 0,
      expectedReplies: 1,
      expectedSecondTrigger: null,
    },
  ] as const)(
    "applies the continuation window $name",
    async ({ continuationWindowSeconds, elapsedMs, expectedReplies, expectedSecondTrigger }) => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => response("join"))
        .mockImplementationOnce(async () => response("continue"));
      vi.stubGlobal("fetch", fetchMock);
      streamTextMock.mockReturnValue(streamResult());
      const onSample = vi.fn<(sample: EngagementSample) => void>();
      const runtimeConfig = config("active", onSample);
      runtimeConfig.engagement = {
        ...runtimeConfig.engagement!,
        continuationWindowSeconds,
      };
      const runtime = createAiReplyHandler(runtimeConfig);
      runtimes.push(runtime);

      await runtime.handler(context("join this discussion", { messageId: 1 }), vi.fn());
      now += elapsedMs;
      await runtime.handler(context("and what next?", { messageId: 2 }), vi.fn());
      await vi.waitFor(() => expect(onSample).toHaveBeenCalledTimes(2));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(streamTextMock).toHaveBeenCalledTimes(expectedReplies);
      expect(onSample.mock.calls[1]?.[0]).toMatchObject({
        participation: { choice: "continue", confidence: 0.9 },
        actualTrigger: expectedSecondTrigger,
        ...(expectedSecondTrigger === null ? { reasonCode: "engagement_cooldown" } : {}),
      });
    },
  );

  it("applies a group override for the continuation confidence threshold", async () => {
    const continuation = responseBody("continue");
    continuation.answers.participation.confidence = 0.7;
    continuation.answers.participation.probabilities = {
      addressed: 0.1,
      continue: 0.85,
      join: 0.05,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(continuation))),
    );
    streamTextMock.mockReturnValue(streamResult());
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtimeConfig = config("active", onSample);
    runtimeConfig.groupOverrides["-100"]!.engagement = {
      continueConfidenceThreshold: 0.6,
    };
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("continue this exchange"), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: "continue",
        actualTrigger: "engagement_continue",
        participation: { choice: "continue", confidence: 0.7 },
        configSnapshot: expect.objectContaining({ continueConfidenceThreshold: 0.6 }),
      }),
    );
  });

  it("uses participation defaults when legacy global and group configuration omit them", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response("silent")));
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtimeConfig = config("shadow", onSample);
    const legacyEngagement = runtimeConfig.engagement as unknown as Record<string, unknown>;
    delete legacyEngagement["addressedConfidenceThreshold"];
    delete legacyEngagement["continueConfidenceThreshold"];
    delete legacyEngagement["continuationWindowSeconds"];
    runtimeConfig.groupOverrides["-100"]!.engagement = {
      addressedConfidenceThreshold: undefined,
      continueConfidenceThreshold: undefined,
      continuationWindowSeconds: undefined,
    };
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("legacy configuration"), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());

    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({
        configSnapshot: expect.objectContaining({
          addressedConfidenceThreshold: 0.8,
          continueConfidenceThreshold: 0.8,
          continuationWindowSeconds: 120,
        }),
      }),
    );
  });

  it("blocks another ordinary join while the active engagement cooldown is running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => response("join")),
    );
    streamTextMock.mockReturnValue(streamResult());
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(config("active", onSample));
    runtimes.push(runtime);

    await runtime.handler(context("first join", { messageId: 1 }), vi.fn());
    await runtime.handler(context("second join", { messageId: 2 }), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledTimes(2));

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(onSample.mock.calls[1]?.[0]).toMatchObject({
      reasonCode: "engagement_cooldown",
      actualTrigger: null,
    });
  });

  it("keeps ambiguous participation under cooldown even when the reply decision is confident", async () => {
    const uncertain = responseBody("continue");
    uncertain.answers.participation.confidence = 0.1;
    uncertain.answers.participation.probabilities = { addressed: 0, continue: 0.55, join: 0.45 };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response("join"))
        .mockResolvedValueOnce(new Response(JSON.stringify(uncertain))),
    );
    streamTextMock.mockReturnValue(streamResult());
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(config("active", onSample));
    runtimes.push(runtime);
    await runtime.handler(context("first join", { messageId: 1 }), vi.fn());
    await runtime.handler(context("new exchange", { messageId: 2 }), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledTimes(2));
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(onSample.mock.calls[1]?.[0]).toMatchObject({
      choice: "join",
      engagement: "answer",
      reasonCode: "engagement_cooldown",
      actualTrigger: null,
    });
  });

  it.each([
    [0.9, 0.8],
    [0.5, 0.8],
    [0.5, 0.4],
  ] as const)(
    "applies direct-invitation confidence %s against threshold %s",
    async (confidence, threshold) => {
      const addressed = responseBody("join");
      addressed.answers.participation.choice = "addressed";
      addressed.answers.participation.confidence = confidence;
      addressed.answers.participation.probabilities = {
        addressed: 0.95,
        continue: 0.025,
        join: 0.025,
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(response("join"))
          .mockResolvedValueOnce(new Response(JSON.stringify(addressed))),
      );
      streamTextMock.mockReturnValue(streamResult());
      const onSample = vi.fn<(sample: EngagementSample) => void>();
      const runtimeConfig = config("active", onSample);
      runtimeConfig.engagement = {
        ...runtimeConfig.engagement!,
        addressedConfidenceThreshold: threshold,
      };
      const runtime = createAiReplyHandler(runtimeConfig);
      runtimes.push(runtime);
      await runtime.handler(context("first join", { messageId: 1 }), vi.fn());
      await runtime.handler(context("助手你怎么看", { messageId: 2 }), vi.fn());
      await vi.waitFor(() => expect(onSample).toHaveBeenCalledTimes(2));
      expect(streamTextMock).toHaveBeenCalledTimes(confidence >= threshold ? 2 : 1);
      expect(onSample.mock.calls[1]?.[0]).toMatchObject({
        addressed: confidence >= threshold,
        actualTrigger: confidence >= threshold ? "engagement_addressed" : null,
        participation: { choice: "addressed", confidence },
      });
    },
  );

  it("does not use a bot utterance from another forum topic to bypass cooldown", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => response("join"))
      .mockImplementationOnce(async () => response("join"))
      .mockImplementationOnce(async () => response("continue"));
    vi.stubGlobal("fetch", fetchMock);
    streamTextMock
      .mockReturnValueOnce(streamResult("topic one answer"))
      .mockImplementationOnce(() => {
        throw new Error("provider unavailable");
      });
    const runtime = createAiReplyHandler(config("active"));
    runtimes.push(runtime);

    await runtime.handler(context("topic one", { messageId: 1, threadId: 10 }), vi.fn());
    await runtime.handler(context("topic two", { messageId: 2, threadId: 20 }), vi.fn());
    await runtime.handler(context("topic two follow-up", { messageId: 3, threadId: 20 }), vi.fn());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("never carries an opted-out user's text into a later shadow request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    const privacyCallbacks = privacy(async (userId) => (userId === 42 ? "off" : "normal"));
    const runtime = createAiReplyHandler(config("shadow", vi.fn(), privacyCallbacks));
    runtimes.push(runtime);

    await runtime.handler(
      context("private phrase must not leave", { messageId: 1, userId: 42 }),
      vi.fn(),
    );
    await runtime.handler(context("ordinary group text", { messageId: 2, userId: 43 }), vi.fn());

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(request)).not.toContain("private phrase must not leave");
  });

  it("rechecks buffered authors so a later privacy opt-out removes already captured text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    let user42Mode: "normal" | "off" = "normal";
    const privacyCallbacks = privacy(async (userId) => (userId === 42 ? user42Mode : "normal"));
    const runtime = createAiReplyHandler(config("shadow", vi.fn(), privacyCallbacks));
    runtimes.push(runtime);

    await runtime.handler(
      context("captured before opt out", { messageId: 1, userId: 42 }),
      vi.fn(),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    user42Mode = "off";
    await runtime.handler(context("later group text", { messageId: 2, userId: 43 }), vi.fn());

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const laterRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(laterRequest)).not.toContain("captured before opt out");
  });

  it("does not resend forgotten buffered text after the user re-enables privacy", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    let resetAt: number | undefined;
    const callbacks = privacy();
    callbacks.getContextResetAt = (userId) => (userId === 42 ? resetAt : undefined);
    const runtime = createAiReplyHandler(config("shadow", vi.fn(), callbacks));
    runtimes.push(runtime);
    await runtime.handler(context("forgotten secret", { messageId: 1, userId: 42 }), vi.fn());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resetAt = Date.now();
    await runtime.handler(context("new speaker", { messageId: 2, userId: 43 }), vi.fn());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).not.toContain("forgotten secret");
  });

  it("invalidates a later bot response derived from context captured before forget", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => response("silent"))
      .mockImplementationOnce(async () => response("join"))
      .mockImplementation(async () => response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    let resetAt: number | undefined;
    const callbacks = privacy();
    callbacks.getContextResetAt = (userId) => (userId === 42 ? resetAt : undefined);
    streamTextMock.mockImplementation(() => {
      resetAt = Date.now();
      return streamResult("derived forgotten secret");
    });
    const runtime = createAiReplyHandler(config("active", vi.fn(), callbacks));
    runtimes.push(runtime);
    await runtime.handler(
      context("original forgotten secret", { messageId: 1, userId: 42 }),
      vi.fn(),
    );
    await runtime.handler(context("please explain", { messageId: 2, userId: 43 }), vi.fn());
    await runtime.handler(context("later topic", { messageId: 3, userId: 44 }), vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).not.toContain("forgotten secret");
  });

  it("does not send a forwarded user's text when that original user opted out", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("join"));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createAiReplyHandler(
      config(
        "active",
        vi.fn(),
        privacy(async (userId) => (userId === 43 ? "off" : "normal")),
      ),
    );
    runtimes.push(runtime);
    const forwarded = context("forwarded private phrase") as BotContext & {
      message: NonNullable<BotContext["message"]>;
    };
    Object.assign(forwarded.message, {
      forward_origin: {
        type: "user",
        date: 1_700_000_000,
        sender_user: { id: 43, is_bot: false, first_name: "Original" },
      },
    });

    await runtime.handler(forwarded, vi.fn());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("retains known forward provenance in samples without sending user IDs to JEV", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(config("shadow", onSample));
    runtimes.push(runtime);
    const forwarded = context("allowed forwarded phrase") as BotContext & {
      message: NonNullable<BotContext["message"]>;
    };
    Object.assign(forwarded.message, {
      forward_origin: {
        type: "user",
        date: 1_700_000_000,
        sender_user: { id: 43, is_bot: false, first_name: "Original" },
      },
    });

    await runtime.handler(forwarded, vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());

    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(requestBody).toContain("allowed forwarded phrase");
    expect(requestBody).not.toContain("privacyUserIds");
    expect(onSample.mock.calls[0]?.[0].context).toContainEqual(
      expect.objectContaining({ messageId: 1, privacyUserIds: [42, 43] }),
    );
  });

  it("never sends unverifiable forwarded text to JEV", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createAiReplyHandler(config("active"));
    runtimes.push(runtime);
    const forwarded = context("hidden forwarded phrase") as BotContext & {
      message: NonNullable<BotContext["message"]>;
    };
    Object.assign(forwarded.message, {
      forward_origin: {
        type: "hidden_user",
        date: 1_700_000_000,
        sender_user_name: "Hidden",
      },
    });

    await runtime.handler(forwarded, vi.fn());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("excludes an opted-out reply source while evaluating the current message", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("silent"));
    vi.stubGlobal("fetch", fetchMock);
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(
      config(
        "active",
        onSample,
        privacy(async (userId) => (userId === 43 ? "off" : "normal")),
      ),
    );
    runtimes.push(runtime);
    const current = Object.assign(context("current public question"), {
      reply_to_message: {
        message_id: 9,
        date: 1_700_000_000,
        text: "private replied phrase",
        from: { id: 43, is_bot: false, first_name: "Other" },
      },
    });

    await runtime.handler(current, vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());

    const requestBody = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(requestBody).toContain("current public question");
    expect(requestBody).not.toContain("private replied phrase");
    expect(onSample.mock.calls[0]?.[0].context).not.toContainEqual(
      expect.objectContaining({ messageId: 9 }),
    );
  });

  it("bounds privacy preparation, records timeout, and falls back once", async () => {
    let releasePrivacy!: () => void;
    const privacyPending = new Promise<void>((resolve) => {
      releasePrivacy = resolve;
    });
    let privacyCalls = 0;
    const privacyCallbacks = privacy(async () => {
      privacyCalls++;
      if (privacyCalls === 2) await privacyPending;
      return "normal";
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtimeConfig = config("active", onSample, privacyCallbacks);
    runtimeConfig.engagement = { ...runtimeConfig.engagement!, timeoutMs: 20 };
    runtimeConfig.triggerConfig.randomReplyPercent = 100;
    runtimeConfig.triggerConfig.randomReplyCooldown = 0;
    streamTextMock.mockReturnValue(streamResult());
    const runtime = createAiReplyHandler(runtimeConfig);
    runtimes.push(runtime);

    await runtime.handler(context("legacy fallback candidate"), vi.fn());
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());
    releasePrivacy();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: "timeout", actualTrigger: "random", context: [] }),
    );
    random.mockRestore();
  });

  it("does not revive a stale gate after stop and resume during privacy preparation", async () => {
    let releasePrivacy!: () => void;
    const privacyPending = new Promise<void>((resolve) => {
      releasePrivacy = resolve;
    });
    let privacyCalls = 0;
    const privacyCallbacks = privacy(async () => {
      privacyCalls++;
      if (privacyCalls > 1) await privacyPending;
      return "normal";
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("join"));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createAiReplyHandler(config("active", vi.fn(), privacyCallbacks));
    runtimes.push(runtime);

    const handling = runtime.handler(context("stale ambient gate"), vi.fn());
    await vi.waitFor(() => expect(privacyCalls).toBeGreaterThan(1));
    runtime.setAiEnabled(false);
    runtime.setAiEnabled(true);
    await handling;
    releasePrivacy();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("cancels an active gate when AI is stopped and suppresses the late reply", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSample = vi.fn<(sample: EngagementSample) => void>();
    const runtime = createAiReplyHandler(config("active", onSample));
    runtimes.push(runtime);

    const handling = runtime.handler(context("ambient decision"), vi.fn());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    runtime.setAiEnabled(false);
    await handling;
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: "aborted", actualTrigger: null }),
    );
  });
});
