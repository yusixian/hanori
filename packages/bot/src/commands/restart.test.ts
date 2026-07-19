import { afterEach, describe, expect, test, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createRestartCommand } from "./restart.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRestartCommand", () => {
  test("contains a deferred async restart failure and notification failure", async () => {
    vi.useFakeTimers();
    const onRestart = vi.fn().mockRejectedValue(new Error("restart failed"));
    const ctx = {
      wait: vi.fn().mockResolvedValue(undefined),
      resolveWait: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockRejectedValue(new Error("notification failed")),
    } as unknown as WrapperContext;
    const command = createRestartCommand(onRestart);

    if (typeof command !== "function")
      throw new Error("Expected restart command middleware function");
    await command(ctx as never, vi.fn());
    await vi.advanceTimersByTimeAsync(2000);

    expect(onRestart).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith("重启失败: restart failed");
  });
});
