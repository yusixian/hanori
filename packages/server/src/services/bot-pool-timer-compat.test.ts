import type { IBotManager } from "@cos-tool-bot/shared";
import type { Database } from "@cos-tool-bot/database";
import type { BotTimerHandlers } from "@cos-tool-bot/bot";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { TimerRegistry } from "./timer-registry.js";
import { BotPool } from "./bot-pool.js";

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key" },
}));

function createPool() {
  const markFired = vi.fn().mockResolvedValue(undefined);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const pool = new BotPool({} as Database, logger, { markFired } as unknown as TimerRegistry);
  const fireTimer = vi.fn();
  const internals = pool as unknown as {
    managers: Map<string, IBotManager>;
    botTimerHandlers: Map<string, BotTimerHandlers>;
  };
  internals.managers.set("bot-1", {} as IBotManager);
  internals.botTimerHandlers.set("bot-1", {
    fireTimer,
    cancelPendingTimer: vi.fn(),
  });
  return { pool, fireTimer, markFired };
}

describe("BotPool recovered timer compatibility", () => {
  it("infers the owner for a legacy private timer", async () => {
    const { pool, fireTimer, markFired } = createPool();

    pool.fireRecoveredTimer("timer-1", "bot-1", 42, { reason: "legacy private" });

    expect(fireTimer).toHaveBeenCalledWith(42, "timer-1", "legacy private", 42, false);
    await vi.waitFor(() => expect(markFired).toHaveBeenCalledWith("timer-1"));
  });

  it("fires a legacy group timer in memoryless compatibility mode", async () => {
    const { pool, fireTimer, markFired } = createPool();

    pool.fireRecoveredTimer("timer-2", "bot-1", -100, { reason: "legacy group" });

    expect(fireTimer).toHaveBeenCalledWith(-100, "timer-2", "legacy group", undefined, true);
    await vi.waitFor(() => expect(markFired).toHaveBeenCalledWith("timer-2"));
  });
});
