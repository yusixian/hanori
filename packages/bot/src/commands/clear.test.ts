import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createClearCommand } from "./clear.js";

describe("/clear", () => {
  it("cancels the chat run before clearing durable history", async () => {
    const events: string[] = [];
    const command = createClearCommand(
      {
        clearHistory: vi.fn(async () => {
          events.push("clear");
        }),
      } as never,
      [42],
      vi.fn(async () => {
        events.push("cancel");
      }),
      vi.fn(async (_chatId, operation) => {
        events.push("lock:start");
        await operation();
        events.push("lock:end");
      }),
    );
    if (typeof command !== "function") throw new Error("Expected command middleware function");
    const ctx = {
      chat: { id: -100, type: "supergroup" },
      from: { id: 42 },
      reply: vi.fn(async () => undefined),
    } as unknown as WrapperContext;

    await command(ctx as never, vi.fn());

    expect(events).toEqual(["lock:start", "cancel", "clear", "lock:end"]);
    expect(ctx.reply).toHaveBeenCalledWith("已清除当前对话的历史记录");
  });

  it("does not clear history when the active AI run fails to drain", async () => {
    const clearHistory = vi.fn(async () => undefined);
    const command = createClearCommand(
      { clearHistory } as never,
      [42],
      vi.fn(async () => {
        throw new Error("Timed out waiting for the active AI reply");
      }),
    );
    if (typeof command !== "function") throw new Error("Expected command middleware function");
    const ctx = {
      chat: { id: -100, type: "supergroup" },
      from: { id: 42 },
      reply: vi.fn(async () => undefined),
    } as unknown as WrapperContext;

    await command(ctx as never, vi.fn());

    expect(clearHistory).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "清除对话历史失败: Timed out waiting for the active AI reply",
    );
  });
});
