import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createStatusCommand } from "./status.js";

describe("/status AI execution metrics", () => {
  it("shows Bot-scoped queue counts and timing without message content", async () => {
    const command = createStatusCommand(
      {
        model: "test-model",
        conversationEnabled: true,
        memoryEnabled: false,
        webToolsEnabled: false,
        agentToolsEnabled: false,
        stickerPacksCount: 0,
      },
      {
        getMood: () => undefined,
        getAllMoods: () => new Map(),
        getActiveGroupCount: () => 0,
        getAiExecutionStats: () => ({
          active: 2,
          activeUsers: 2,
          queued: 3,
          maxConcurrent: 4,
          maxQueued: 100,
          tracked: 5,
          started: 8,
          completed: 5,
          rejected: 1,
          cancelled: 2,
          totalWaitMs: 800,
          totalRunMs: 8_000,
          lastWaitMs: 50,
          lastRunMs: 500,
        }),
      } as never,
    );
    if (typeof command !== "function") throw new Error("Expected command middleware function");
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = { chat: { id: -100 }, reply } as unknown as WrapperContext;

    await command(ctx as never, vi.fn());

    const text = String(reply.mock.calls[0]?.[0]);
    expect(text).toContain("运行中: 2/4");
    expect(text).toContain("排队: 3");
    expect(text).toContain("完成/拒绝/取消: 5/1/2");
    expect(text).toContain("平均等待/运行: 100ms/1.0s");
  });
});
