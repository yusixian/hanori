import type { Tool } from "ai";
import type { Api } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingActionRegistry } from "../services/pending-actions.js";
import { createTelegramTools } from "./telegram.js";

type ExecutableTool = {
  execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
};

describe("telegram timer scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
