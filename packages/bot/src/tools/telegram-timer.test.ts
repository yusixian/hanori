import type { ScheduledTaskPort, ScheduledTaskRecord } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Api } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingActionRegistry } from "../services/pending-actions.js";
import { createTelegramTools } from "./telegram.js";

type ExecutableTool = {
  execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
};

type TimerSchema = {
  jsonSchema: { properties: { seconds: { maximum: number; description: string } } };
};

function timerToolCall(seconds: number) {
  return {
    type: "tool-call" as const,
    toolCallId: "timer-call",
    toolName: "set_timer",
    input: JSON.stringify({ seconds, reason: "AI SDK validation" }),
  };
}

function mockTimerModel(seconds: number) {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [timerToolCall(seconds)],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

function timerSecondsSchema(
  timerMaxSeconds?: number,
): TimerSchema["jsonSchema"]["properties"]["seconds"] {
  const tools = createTelegramTools({
    api: {} as Api,
    chatId: 42,
    recentBotMessageIds: [],
    timerMaxSeconds,
  });
  return (tools.set_timer!.inputSchema as unknown as TimerSchema).jsonSchema.properties.seconds;
}

describe("set_timer date range", () => {
  it("does not expose the legacy one-day or seven-day product ceiling", () => {
    for (const ceiling of [undefined, 30, 604800])
      expect(timerSecondsSchema(ceiling).maximum).toBeUndefined();
  });
});

describe("telegram timer scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns legacy timer requests into pending proposals instead of starting timers", async () => {
    const plan = {
      name: "later",
      instructions: "later",
      dataScope: { kind: "none" as const },
      destination: { chatId: 42 },
      schedule: { kind: "once" as const, at: "2030-01-01T00:00:00Z", timezone: "UTC" },
      agent: {},
    };
    const propose = vi.fn().mockResolvedValue({
      id: "task",
      pendingVersion: 1,
      pendingPlan: plan,
      proposerId: 1,
      proposerName: "member",
      status: "pending",
    } as ScheduledTaskRecord);
    const bindConfirmation = vi.fn();
    const onTimerCreate = vi.fn();
    const tools = createTelegramTools({
      api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }) } as unknown as Api,
      chatId: 42,
      recentBotMessageIds: [],
      scheduledTaskActor: { botId: "bot", chatId: 42, userId: 1, isAdmin: false },
      scheduledTasks: { propose, bindConfirmation } as unknown as ScheduledTaskPort,
      onTimerCreate,
    });
    const result = await (tools.set_timer as unknown as ExecutableTool).execute(
      { seconds: 100 * 86400, reason: "later" },
      { abortSignal: new AbortController().signal },
    );
    expect(result).toMatchObject({ status: "awaiting_admin_confirmation" });
    expect(propose).toHaveBeenCalledOnce();
    expect(onTimerCreate).not.toHaveBeenCalled();
    expect(bindConfirmation).toHaveBeenCalledWith(expect.anything(), "task", 1, 10);
  });
  it("does not overflow a standalone native timer", async () => {
    const onTimerFired = vi.fn();
    const pendingActions = new PendingActionRegistry();
    const tools = createTelegramTools({
      api: {} as Api,
      chatId: 42,
      recentBotMessageIds: [],
      pendingActions,
      onTimerFired,
    });
    const result = await (tools.set_timer as unknown as ExecutableTool).execute(
      { seconds: 100 * 86400, reason: "later" },
      { abortSignal: new AbortController().signal },
    );
    expect(result).toHaveProperty("error");
    await vi.advanceTimersByTimeAsync(10);
    expect(onTimerFired).not.toHaveBeenCalled();
    pendingActions.destroy();
  });
  it("accepts the minimum duration and sends it to the durable scheduler", async () => {
    const pendingActions = new PendingActionRegistry();
    const onTimerCreate = vi.fn(async () => {});
    const tools = createTelegramTools({
      api: {} as Api,
      chatId: 42,
      recentBotMessageIds: [],
      pendingActions,
      onTimerCreate,
      onTimerFired: vi.fn(async () => {}),
    });
    const result = await generateText({
      model: mockTimerModel(5),
      prompt: "Set a short timer.",
      tools,
    });

    expect(result.toolResults).toHaveLength(1);
    expect(onTimerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ seconds: 5, reason: "AI SDK validation" }),
    );
    pendingActions.destroy();
  });

  it("schedules the configured 7-day upper bound through the tool", async () => {
    const pendingActions = new PendingActionRegistry();
    const onTimerCreate = vi.fn(async () => {});
    const tools = createTelegramTools({
      api: {} as Api,
      chatId: 42,
      recentBotMessageIds: [],
      pendingActions,
      onTimerCreate,
      onTimerFired: vi.fn(async () => {}),
      timerMaxSeconds: 604_800,
    });
    const result = await generateText({
      model: mockTimerModel(604_800),
      prompt: "Set a timer for the configured maximum.",
      tools,
    });

    expect(result.toolResults).toHaveLength(1);
    expect(onTimerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ seconds: 604_800, reason: "AI SDK validation" }),
    );
    pendingActions.destroy();
  });

  it("accepts dates beyond seven days and native timer range through durable scheduling", async () => {
    const pendingActions = new PendingActionRegistry();
    const onTimerCreate = vi.fn(async () => {});
    const tools = createTelegramTools({
      api: {} as Api,
      chatId: 42,
      recentBotMessageIds: [],
      pendingActions,
      onTimerCreate,
      onTimerFired: vi.fn(),
      timerMaxSeconds: 604800,
    });
    const result = await generateText({
      model: mockTimerModel(100 * 86400),
      prompt: "Set a remote date",
      tools,
    });
    expect(result.toolResults).toHaveLength(1);
    expect(onTimerCreate).toHaveBeenCalledWith(expect.objectContaining({ seconds: 100 * 86400 }));
    pendingActions.destroy();
  });

  it.each([{ seconds: 4, timerMaxSeconds: undefined, bound: "5", label: "below minimum" }])(
    "returns an explicit error for $label without scheduling",
    async ({ seconds, timerMaxSeconds, bound }) => {
      const pendingActions = new PendingActionRegistry();
      const onTimerCreate = vi.fn(async () => {});
      const tools = createTelegramTools({
        api: {} as Api,
        chatId: 42,
        recentBotMessageIds: [],
        pendingActions,
        onTimerCreate,
        onTimerFired: vi.fn(async () => {}),
        timerMaxSeconds,
      });
      const result = await generateText({
        model: mockTimerModel(seconds),
        prompt: `Set a timer for ${seconds} seconds.`,
        tools,
      });

      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool-error", error: expect.stringContaining(bound) }),
        ]),
      );
      expect(onTimerCreate).not.toHaveBeenCalled();
      pendingActions.destroy();
    },
  );

  it("delegates a persisted timer to its durable scheduler instead of firing a local handle", async () => {
    const pendingActions = new PendingActionRegistry();
    const onTimerCreate = vi.fn(async () => {});
    const onTimerFired = vi.fn(async () => {});
    const tools = createTelegramTools({
      api: {} as Api,
      chatId: 42,
      recentBotMessageIds: [],
      pendingActions,
      onTimerCreate,
      onTimerFired,
    });

    const result = await (tools.set_timer as Tool as unknown as ExecutableTool).execute(
      { seconds: 5, reason: "durable" },
      { abortSignal: new AbortController().signal },
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(result).toMatchObject({ success: true, seconds: 5, reason: "durable" });
    expect(onTimerCreate).toHaveBeenCalledOnce();
    expect(onTimerFired).not.toHaveBeenCalled();
    pendingActions.destroy();
  });

  it("reports creation failure and removes the pending timer when persistence rejects", async () => {
    const pendingActions = new PendingActionRegistry();
    const registerTimer = vi.spyOn(pendingActions, "registerTimer");
    const onTimerCreate = vi.fn(async () => Promise.reject(new Error("database unavailable")));
    const onTimerFired = vi.fn(async () => {});
    const tools = createTelegramTools({
      api: {} as Api,
      chatId: 42,
      recentBotMessageIds: [],
      pendingActions,
      onTimerCreate,
      onTimerFired,
    });

    const result = await (tools.set_timer as Tool as unknown as ExecutableTool).execute(
      { seconds: 5, reason: "must persist" },
      { abortSignal: new AbortController().signal },
    );
    const pending = registerTimer.mock.results[0]?.value;

    expect(result).toEqual({ error: "Error: database unavailable" });
    expect(pending).toBeDefined();
    expect(pendingActions.getTimer(pending!.timerId)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTimerFired).not.toHaveBeenCalled();
    pendingActions.destroy();
  });
});

it("keeps the pending timer when its durable cancellation fails, then allows retry", async () => {
  const pendingActions = new PendingActionRegistry();
  const onTimerCancel = vi
    .fn()
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValue(undefined);
  const tools = createTelegramTools({
    api: {} as Api,
    chatId: 42,
    recentBotMessageIds: [],
    pendingActions,
    onTimerCancel,
  });
  const timer = pendingActions.registerTimer(
    42,
    "test",
    setTimeout(() => {}, 60_000),
  );
  const cancel = tools.cancel_timer as unknown as ExecutableTool;
  try {
    await expect(
      cancel.execute({ timer_id: timer.timerId }, { abortSignal: new AbortController().signal }),
    ).resolves.toEqual({ error: "Error: database unavailable" });
    expect(pendingActions.getTimer(timer.timerId)).toBe(timer);
    await expect(
      cancel.execute({ timer_id: timer.timerId }, { abortSignal: new AbortController().signal }),
    ).resolves.toEqual({ success: true, cancelled_timer_id: timer.timerId });
    expect(pendingActions.getTimer(timer.timerId)).toBeUndefined();
  } finally {
    pendingActions.destroy();
  }
});

it("does not cancel another chat's timer even when its ID is known", async () => {
  const pendingActions = new PendingActionRegistry();
  const onTimerCancel = vi.fn(async () => {});
  const timer = pendingActions.registerTimer(
    -1002,
    "other chat",
    setTimeout(() => {}, 60_000),
  );
  const tools = createTelegramTools({
    api: {} as Api,
    chatId: -1001,
    recentBotMessageIds: [],
    pendingActions,
    onTimerCancel,
  });
  try {
    const cancel = tools.cancel_timer as unknown as ExecutableTool;
    await expect(
      cancel.execute({ timer_id: timer.timerId }, { abortSignal: new AbortController().signal }),
    ).resolves.toEqual({ error: "Timer not found or already expired" });
    expect(onTimerCancel).not.toHaveBeenCalled();
    expect(pendingActions.getTimer(timer.timerId)).toBe(timer);
  } finally {
    pendingActions.destroy();
  }
});
