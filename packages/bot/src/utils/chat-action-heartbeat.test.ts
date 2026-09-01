import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_ACTION_REFRESH_INTERVAL_MS,
  startChatActionHeartbeat,
} from "./chat-action-heartbeat.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startChatActionHeartbeat", () => {
  it("refreshes the action until stopped", async () => {
    vi.useFakeTimers();
    const sendAction = vi.fn().mockResolvedValue(true);
    const stop = startChatActionHeartbeat(sendAction);

    expect(sendAction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHAT_ACTION_REFRESH_INTERVAL_MS * 2);
    expect(sendAction).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(CHAT_ACTION_REFRESH_INTERVAL_MS * 2);
    expect(sendAction).toHaveBeenCalledTimes(2);
  });

  it("does not overlap slow Telegram requests", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<true>((resolve) => {
      release = () => resolve(true);
    });
    const sendAction = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(true);
    const stop = startChatActionHeartbeat(sendAction);

    await vi.advanceTimersByTimeAsync(CHAT_ACTION_REFRESH_INTERVAL_MS * 3);
    expect(sendAction).toHaveBeenCalledOnce();

    release();
    await pending;
    await vi.advanceTimersByTimeAsync(CHAT_ACTION_REFRESH_INTERVAL_MS);
    expect(sendAction).toHaveBeenCalledTimes(2);
    stop();
  });
});
