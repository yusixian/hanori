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

describe("set_timer duration ceiling", () => {
  it("follows the configured ceiling in both the schema and its description", () => {
    const seconds = timerSecondsSchema(604_800);

    expect(seconds.maximum).toBe(604_800);
    expect(seconds.description).toBe("定时秒数（5-604800，即最长7天）");
  });

  it("falls back to 24 hours when no ceiling is configured", () => {
    const seconds = timerSecondsSchema();

    expect(seconds.maximum).toBe(86_400);
    expect(seconds.description).toBe("定时秒数（5-86400，即最长1天）");
  });

  it("clamps a stored ceiling that sits outside the supported range", () => {
    expect(timerSecondsSchema(30).maximum).toBe(300);
    expect(timerSecondsSchema(30 * 86_400).maximum).toBe(604_800);
  });
});

describe("telegram timer scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("returns an explicit error above the configured ceiling without scheduling", async () => {
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
      model: mockTimerModel(604_801),
      prompt: "Set a timer above the configured maximum.",
      tools,
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.output).toMatchObject({
      error: expect.stringContaining("604800"),
    });
    expect(onTimerCreate).not.toHaveBeenCalled();
    pendingActions.destroy();
  });

  it.each([
    { seconds: 4, timerMaxSeconds: undefined, bound: "5", label: "below minimum" },
    { seconds: 86_401, timerMaxSeconds: undefined, bound: "86400", label: "above default ceiling" },
  ])(
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

      expect(result.toolResults[0]?.output).toMatchObject({
        error: expect.stringContaining(bound),
      });
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
