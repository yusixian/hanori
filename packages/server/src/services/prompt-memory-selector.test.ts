import type { BotMemory } from "@cos-tool-bot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_MEMORY_EMBEDDING_TIMEOUT_MS,
  PROMPT_MEMORY_MAX_COSINE_DISTANCE,
  selectMemoriesForPrompt,
} from "./prompt-memory-selector.js";

const memory: BotMemory = {
  id: 1,
  botId: "bot-1",
  telegramId: null,
  content: "Likes cats",
  category: "preference",
  kind: null,
  scopeChatId: null,
  origin: null,
  sourceChatId: null,
  sourceMessageId: null,
  sourceUserId: null,
  expiresAt: null,
  factValidAt: null,
  isActive: true,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

function createStore() {
  return {
    getMemoriesForPrompt: vi.fn().mockResolvedValue([memory]),
    recallMemories: vi.fn().mockResolvedValue([memory]),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("selectMemoriesForPrompt", () => {
  it("uses query embedding and the current user's safe combined scope", async () => {
    const store = createStore();
    const generateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2]);

    await expect(
      selectMemoriesForPrompt({
        botId: "bot-1",
        query: "  cats  ",
        telegramId: 42,
        limit: 8,
        store,
        embeddingService: { generateEmbedding },
      }),
    ).resolves.toEqual([memory]);

    expect(generateEmbedding).toHaveBeenCalledWith("cats", expect.any(AbortSignal));
    expect(store.recallMemories).toHaveBeenCalledWith("bot-1", {
      query: "cats",
      telegramId: 42,
      scope: "all",
      limit: 8,
      queryEmbedding: [0.1, 0.2],
      maxDistance: PROMPT_MEMORY_MAX_COSINE_DISTANCE,
    });
    expect(store.getMemoriesForPrompt).not.toHaveBeenCalled();
  });

  it("restricts query recall without a user to general memories", async () => {
    const store = createStore();

    await selectMemoriesForPrompt({
      botId: "bot-1",
      query: "rules",
      limit: 5,
      store,
    });

    expect(store.recallMemories).toHaveBeenCalledWith("bot-1", {
      query: "rules",
      telegramId: undefined,
      scope: "general_only",
      limit: 5,
      queryEmbedding: undefined,
      maxDistance: PROMPT_MEMORY_MAX_COSINE_DISTANCE,
    });
  });

  it("falls back to recent scoped memories only for an empty query", async () => {
    const store = createStore();
    const generateEmbedding = vi.fn();

    await selectMemoriesForPrompt({
      botId: "bot-1",
      query: "   ",
      telegramId: 42,
      limit: 3,
      store,
      embeddingService: { generateEmbedding },
    });

    expect(store.getMemoriesForPrompt).toHaveBeenCalledWith("bot-1", {
      telegramId: 42,
      limit: 3,
    });
    expect(store.recallMemories).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it("falls back to recent scoped memories when embedding returns null and keywords miss", async () => {
    const store = createStore();
    store.recallMemories.mockResolvedValue([]);
    const generateEmbedding = vi.fn().mockResolvedValue(null);

    await selectMemoriesForPrompt({
      botId: "bot-1",
      query: "cats",
      telegramId: 42,
      limit: 8,
      store,
      embeddingService: { generateEmbedding },
    });

    expect(store.recallMemories).toHaveBeenCalledWith(
      "bot-1",
      expect.objectContaining({ query: "cats", queryEmbedding: undefined }),
    );
    expect(store.getMemoriesForPrompt).toHaveBeenCalledWith("bot-1", {
      telegramId: 42,
      limit: 8,
    });
  });

  it("falls back for a complete-sentence query when embeddings are unavailable and keywords miss", async () => {
    const store = createStore();
    store.recallMemories.mockResolvedValue([]);

    await expect(
      selectMemoriesForPrompt({
        botId: "bot-1",
        query: "What food does Alice prefer for breakfast?",
        telegramId: 42,
        limit: 6,
        store,
      }),
    ).resolves.toEqual([memory]);

    expect(store.recallMemories).toHaveBeenCalledWith(
      "bot-1",
      expect.objectContaining({
        query: "What food does Alice prefer for breakfast?",
        queryEmbedding: undefined,
      }),
    );
    expect(store.getMemoriesForPrompt).toHaveBeenCalledOnce();
  });

  it("falls back when embedding generation throws and keywords miss", async () => {
    const store = createStore();
    store.recallMemories.mockResolvedValue([]);
    const generateEmbedding = vi.fn().mockRejectedValue(new Error("provider failure"));

    await expect(
      selectMemoriesForPrompt({
        botId: "bot-1",
        query: "cats",
        limit: 4,
        store,
        embeddingService: { generateEmbedding },
      }),
    ).resolves.toEqual([memory]);

    expect(store.getMemoriesForPrompt).toHaveBeenCalledWith("bot-1", {
      telegramId: undefined,
      limit: 4,
    });
  });

  it("aborts a timed-out embedding request and falls back without waiting indefinitely", async () => {
    vi.useFakeTimers();
    const store = createStore();
    store.recallMemories.mockResolvedValue([]);
    let receivedSignal: AbortSignal | undefined;
    const generateEmbedding = vi.fn((_query: string, abortSignal?: AbortSignal) => {
      receivedSignal = abortSignal;
      return new Promise<number[] | null>(() => {});
    });

    const selection = selectMemoriesForPrompt({
      botId: "bot-1",
      query: "cats",
      telegramId: 42,
      limit: 4,
      store,
      embeddingService: { generateEmbedding },
    });
    await vi.advanceTimersByTimeAsync(PROMPT_MEMORY_EMBEDDING_TIMEOUT_MS);

    await expect(selection).resolves.toEqual([memory]);
    expect(receivedSignal?.aborted).toBe(true);
    expect(store.recallMemories).toHaveBeenCalledWith(
      "bot-1",
      expect.objectContaining({ queryEmbedding: undefined }),
    );
    expect(store.getMemoriesForPrompt).toHaveBeenCalledOnce();
  });

  it("does not replace an empty semantic result with unrelated recent memories", async () => {
    const store = createStore();
    store.recallMemories.mockResolvedValue([]);
    const generateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2]);

    await expect(
      selectMemoriesForPrompt({
        botId: "bot-1",
        query: "cats",
        telegramId: 42,
        limit: 8,
        store,
        embeddingService: { generateEmbedding },
      }),
    ).resolves.toEqual([]);

    expect(store.getMemoriesForPrompt).not.toHaveBeenCalled();
  });
});
