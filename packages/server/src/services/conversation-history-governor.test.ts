import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationStore } from "./conversation-store.js";
import { ConversationHistoryGovernor } from "./conversation-history-governor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationHistoryGovernor", () => {
  it("prunes at the hard limit even when summarization fails", async () => {
    const events: string[] = [];
    const store = {
      getMessageCount: vi.fn().mockResolvedValue(50_000),
      enforceHistoryLimit: vi.fn(async () => {
        events.push("prune");
        return {
          countBefore: 50_000,
          countAfter: 40_000,
          limit: 50_000,
          warningThreshold: 40_000,
          prunedCount: 10_000,
          warning: true,
        };
      }),
    } as unknown as ConversationStore;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const governor = new ConversationHistoryGovernor(store, logger);
    const summarize = vi.fn(async () => {
      events.push("summarize");
      throw new Error("provider unavailable");
    });

    await governor.run({
      botId: "00000000-0000-4000-8000-000000000017",
      chatId: 42,
      maxRawMessagesPerChat: 50_000,
      summarize,
    });

    expect(events).toEqual(["summarize", "prune"]);
    expect(store.enforceHistoryLimit).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000017",
      42,
      50_000,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "00000000-0000-4000-8000-000000000017",
        chatId: 42,
        prunedCount: 10_000,
      }),
      "Conversation history hard limit enforced",
    );
  });

  it("does not let a hanging summary block hard-limit pruning", async () => {
    vi.useFakeTimers();
    const store = {
      getMessageCount: vi.fn().mockResolvedValue(50_000),
      enforceHistoryLimit: vi.fn().mockResolvedValue({
        countBefore: 50_000,
        countAfter: 40_000,
        limit: 50_000,
        warningThreshold: 40_000,
        prunedCount: 10_000,
        warning: true,
      }),
    } as unknown as ConversationStore;
    const logger = { warn: vi.fn() } as unknown as Logger;
    const governor = new ConversationHistoryGovernor(store, logger);
    let completed = false;

    void governor
      .run({
        botId: "00000000-0000-4000-8000-000000000017",
        chatId: 42,
        maxRawMessagesPerChat: 50_000,
        summarize: () => new Promise(() => {}),
      })
      .then(() => {
        completed = true;
      });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(completed).toBe(true);
    expect(store.enforceHistoryLimit).toHaveBeenCalledOnce();
  });

  it("logs the 80% warning only once while the chat remains above the threshold", async () => {
    const store = {
      getMessageCount: vi.fn().mockResolvedValue(40_000),
      enforceHistoryLimit: vi.fn().mockResolvedValue({
        countBefore: 40_000,
        countAfter: 40_000,
        limit: 50_000,
        warningThreshold: 40_000,
        prunedCount: 0,
        warning: true,
      }),
    } as unknown as ConversationStore;
    const logger = { warn: vi.fn() } as unknown as Logger;
    const governor = new ConversationHistoryGovernor(store, logger);
    const options = {
      botId: "00000000-0000-4000-8000-000000000017",
      chatId: 42,
      maxRawMessagesPerChat: 50_000,
      summarize: vi.fn().mockResolvedValue(undefined),
    };

    await governor.run(options);
    await governor.run(options);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 40_000, warningThreshold: 40_000 }),
      "Conversation history reached the warning threshold",
    );
  });

  it("logs the 80% warning before waiting for a slow summary", async () => {
    const store = {
      getMessageCount: vi.fn().mockResolvedValue(40_000),
      enforceHistoryLimit: vi.fn(),
    } as unknown as ConversationStore;
    const logger = { warn: vi.fn() } as unknown as Logger;
    const governor = new ConversationHistoryGovernor(store, logger);

    void governor.run({
      botId: "00000000-0000-4000-8000-000000000017",
      chatId: 42,
      maxRawMessagesPerChat: 50_000,
      summarize: () => new Promise(() => {}),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 40_000, warningThreshold: 40_000 }),
      "Conversation history reached the warning threshold",
    );
    expect(store.enforceHistoryLimit).not.toHaveBeenCalled();
  });
});
