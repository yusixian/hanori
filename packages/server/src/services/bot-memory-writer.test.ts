import type { BotMemory } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { BotMemoryWriter, type MemoryEmbedder } from "./bot-memory-writer.js";

const botId = "00000000-0000-4000-8000-000000000001";
const options = { embeddingTimeoutMs: 1_000 };

function memory(overrides: Partial<BotMemory> = {}): BotMemory {
  return {
    id: 7,
    botId,
    telegramId: 42,
    content: "Likes tea",
    category: null,
    kind: "preference",
    scopeChatId: null,
    origin: "agent",
    sourceChatId: null,
    sourceMessageId: null,
    sourceUserId: null,
    expiresAt: null,
    factValidAt: null,
    isActive: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const vectorFor = (text: string) => [text.length];

/** Shaped like a Drizzle query error: the message repeats the query parameters. */
function queryError(parameter: string) {
  return new Error(`Failed query: update bot_memories\nparams: ${parameter}`, {
    cause: Object.assign(new Error("dimension mismatch"), { code: "22000" }),
  });
}

function fakeEmbedder() {
  return {
    generateEmbedding: vi.fn(async (text: string) => vectorFor(text) as number[] | null),
    generateEmbeddings: vi.fn(async (texts: string[]) =>
      texts.map((text) => vectorFor(text) as number[] | null),
    ),
  } satisfies MemoryEmbedder;
}

function setup(config: { embedder?: boolean } = {}) {
  const store = {
    findSimilar: vi.fn(async (): Promise<Array<BotMemory & { distance: number }>> => []),
    getMemory: vi.fn(async (): Promise<BotMemory | null> => memory()),
    saveMemory: vi.fn(async (_botId: string, data: { content: string }) =>
      memory({ id: 8, content: data.content }),
    ),
    touchMemory: vi.fn(async () => undefined),
    updateEmbeddingIfContentMatches: vi.fn(async () => true),
    updateMemory: vi.fn(
      async (_botId: string, memoryId: number, changes: { content?: string }) =>
        memory({ id: memoryId, content: changes.content ?? "Likes tea" }) as BotMemory | null,
    ),
  };
  const embedder = fakeEmbedder();
  const resolveEmbedder = vi.fn(() => (config.embedder === false ? undefined : embedder));
  const logger = { info: vi.fn(), warn: vi.fn() };
  const writer = new BotMemoryWriter(
    store as unknown as ConstructorParameters<typeof BotMemoryWriter>[0],
    resolveEmbedder,
    logger as unknown as Pick<Logger, "info" | "warn">,
  );
  return { writer, store, embedder, resolveEmbedder, logger };
}

describe("BotMemoryWriter.create", () => {
  it("stores a new memory with the vector of its content", async () => {
    const { writer, store, embedder } = setup();

    await expect(
      writer.create(botId, { content: "Likes tea", telegramId: 42 }, options),
    ).resolves.toMatchObject({ id: 8, content: "Likes tea" });

    expect(embedder.generateEmbedding).toHaveBeenCalledWith("Likes tea", expect.any(AbortSignal));
    expect(store.saveMemory).toHaveBeenCalledWith(botId, {
      content: "Likes tea",
      telegramId: 42,
      embedding: [9],
    });
    expect(store.findSimilar).not.toHaveBeenCalled();
  });

  it("returns and touches an exact repeat in the same owner and chat scope", async () => {
    const { writer, store } = setup();
    const existing = { ...memory({ content: "  likes TEA " }), distance: 0.01 };
    store.findSimilar.mockResolvedValue([existing]);

    await expect(
      writer.create(
        botId,
        { content: "Likes tea", telegramId: 42, scopeChatId: -100 },
        { ...options, dedup: true },
      ),
    ).resolves.toBe(existing);

    expect(store.findSimilar).toHaveBeenCalledWith(botId, [9], 0.15, {
      telegramId: 42,
      scopeChatId: -100,
    });
    expect(store.touchMemory).toHaveBeenCalledWith(7);
    expect(store.saveMemory).not.toHaveBeenCalled();
  });

  it("inserts when similar memories differ in text or are not close enough", async () => {
    const { writer, store } = setup();
    store.findSimilar.mockResolvedValue([
      { ...memory({ id: 5, content: "Likes coffee" }), distance: 0.01 },
      { ...memory({ id: 6, content: "Likes tea" }), distance: 0.1 },
    ]);

    await writer.create(botId, { content: "Likes tea" }, { ...options, dedup: true });

    expect(store.touchMemory).not.toHaveBeenCalled();
    expect(store.saveMemory).toHaveBeenCalledWith(botId, { content: "Likes tea", embedding: [9] });
  });

  it("still saves the text when no vector can be produced", async () => {
    const noEmbedder = setup({ embedder: false });
    await noEmbedder.writer.create(botId, { content: "Likes tea" }, { ...options, dedup: true });
    expect(noEmbedder.store.saveMemory).toHaveBeenCalledWith(botId, {
      content: "Likes tea",
      embedding: undefined,
    });
    expect(noEmbedder.store.findSimilar).not.toHaveBeenCalled();

    const failed = setup();
    failed.embedder.generateEmbedding.mockResolvedValue(null);
    await failed.writer.create(botId, { content: "Likes tea" }, { ...options, dedup: true });
    expect(failed.store.saveMemory).toHaveBeenCalledWith(botId, {
      content: "Likes tea",
      embedding: undefined,
    });
    expect(failed.store.findSimilar).not.toHaveBeenCalled();
  });
});

describe("BotMemoryWriter.update", () => {
  it("embeds replaced content before the update and stores its vector right after", async () => {
    const { writer, store, embedder } = setup();

    await expect(
      writer.update(botId, 7, { content: "Likes green tea" }, options),
    ).resolves.toMatchObject({ id: 7, content: "Likes green tea" });

    expect(store.getMemory).toHaveBeenCalledWith(botId, 7);
    expect(embedder.generateEmbedding).toHaveBeenCalledWith(
      "Likes green tea",
      expect.any(AbortSignal),
    );
    expect(store.updateMemory).toHaveBeenCalledWith(
      botId,
      7,
      { content: "Likes green tea" },
      undefined,
    );
    expect(store.updateEmbeddingIfContentMatches).toHaveBeenCalledWith(
      botId,
      7,
      "Likes green tea",
      [15],
    );
    const order = [
      store.getMemory,
      embedder.generateEmbedding,
      store.updateMemory,
      store.updateEmbeddingIfContentMatches,
    ].map((fn) => fn.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("uses the expected-content guard of an agent edit instead of reading first", async () => {
    const { writer, store } = setup();
    const access = { chatId: -100, userId: 42, includeUnscopedPersonal: false };
    const changes = { content: "Likes green tea", expectedContent: "Likes tea" };

    await writer.update(botId, 7, changes, { ...options, access });

    expect(store.getMemory).not.toHaveBeenCalled();
    expect(store.updateMemory).toHaveBeenCalledWith(botId, 7, changes, access);
    expect(store.updateEmbeddingIfContentMatches).toHaveBeenCalledWith(
      botId,
      7,
      "Likes green tea",
      [15],
    );
  });

  it("keeps the stored vector when the content is unchanged or not edited", async () => {
    const { writer, store, embedder } = setup();

    await writer.update(botId, 7, { content: "Likes tea", category: "drinks" }, options);
    await writer.update(botId, 7, { category: "drinks" }, options);

    expect(store.getMemory).toHaveBeenCalledTimes(1);
    expect(store.updateMemory).toHaveBeenCalledTimes(2);
    expect(embedder.generateEmbedding).not.toHaveBeenCalled();
    expect(store.updateEmbeddingIfContentMatches).not.toHaveBeenCalled();
  });

  it("stores no vector for a rejected update", async () => {
    const { writer, store, embedder } = setup();
    store.updateMemory.mockResolvedValue(null);

    await expect(
      writer.update(botId, 7, { content: "Likes green tea" }, options),
    ).resolves.toBeNull();

    expect(embedder.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(store.updateEmbeddingIfContentMatches).not.toHaveBeenCalled();
  });

  it("updates only the text when the Bot has no embedder", async () => {
    const { writer, store } = setup({ embedder: false });

    await expect(
      writer.update(botId, 7, { content: "Likes green tea" }, options),
    ).resolves.toMatchObject({ content: "Likes green tea" });

    expect(store.getMemory).not.toHaveBeenCalled();
    expect(store.updateEmbeddingIfContentMatches).not.toHaveBeenCalled();
  });

  it("returns the committed update when storing its vector fails", async () => {
    const { writer, store, logger } = setup();
    store.updateEmbeddingIfContentMatches.mockRejectedValue(queryError("Likes green tea"));

    await expect(
      writer.update(botId, 7, { content: "Likes green tea" }, options),
    ).resolves.toMatchObject({ id: 7, content: "Likes green tea" });

    expect(logger.warn).toHaveBeenCalledWith(
      { botId, memoryIds: [7], errorCodes: ["22000"] },
      "Memory embedding refresh failed; text kept without a vector",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("green tea");
  });
});

describe("BotMemoryWriter.refreshEmbeddings", () => {
  it("embeds a batch once and stores only the vectors that were produced", async () => {
    const { writer, store, embedder } = setup();
    embedder.generateEmbeddings.mockResolvedValue([[1], null]);

    await writer.refreshEmbeddings(
      botId,
      [
        { id: 7, content: "Plans a trip" },
        { id: 8, content: "Owes a reply" },
      ],
      options,
    );

    expect(embedder.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(store.updateEmbeddingIfContentMatches).toHaveBeenCalledTimes(1);
    expect(store.updateEmbeddingIfContentMatches).toHaveBeenCalledWith(
      botId,
      7,
      "Plans a trip",
      [1],
    );
  });

  it("keeps storing the other vectors when one write fails", async () => {
    const { writer, store, logger } = setup();
    store.updateEmbeddingIfContentMatches.mockRejectedValueOnce(queryError("Plans a trip"));

    await writer.refreshEmbeddings(
      botId,
      [
        { id: 7, content: "Plans a trip" },
        { id: 8, content: "Owes a reply" },
        { id: 9, content: "Likes jazz" },
      ],
      options,
    );

    expect(store.updateEmbeddingIfContentMatches.mock.calls).toEqual([
      [botId, 7, "Plans a trip", [12]],
      [botId, 8, "Owes a reply", [12]],
      [botId, 9, "Likes jazz", [10]],
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { botId, memoryIds: [7], errorCodes: ["22000"] },
      "Memory embedding refresh failed; text kept without a vector",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Plans a trip");
  });

  it("uses the caller's fallback embedder only when the resolver has none", async () => {
    const running = setup();
    const unused = vi.fn();
    await running.writer.refreshEmbeddings(botId, [{ id: 7, content: "Plans a trip" }], {
      ...options,
      fallbackEmbedder: unused,
    });
    expect(unused).not.toHaveBeenCalled();

    const stopped = setup({ embedder: false });
    const fallback = fakeEmbedder();
    await stopped.writer.refreshEmbeddings(botId, [{ id: 7, content: "Plans a trip" }], {
      ...options,
      fallbackEmbedder: () => fallback,
    });
    expect(fallback.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(stopped.store.updateEmbeddingIfContentMatches).toHaveBeenCalledWith(
      botId,
      7,
      "Plans a trip",
      [12],
    );
  });

  it("logs one line for a batch that no embedder can serve", async () => {
    const { writer, store, logger } = setup({ embedder: false });

    await writer.refreshEmbeddings(
      botId,
      [
        { id: 7, content: "Plans a trip" },
        { id: 8, content: "Owes a reply" },
      ],
      { ...options, fallbackEmbedder: () => undefined },
    );

    expect(logger.info).toHaveBeenCalledWith(
      { botId, count: 2 },
      "No embedder for this Bot; memories kept without vectors",
    );
    expect(store.updateEmbeddingIfContentMatches).not.toHaveBeenCalled();
  });

  it("does not resolve an embedder for an empty batch", async () => {
    const { writer, resolveEmbedder, logger } = setup();

    await writer.refreshEmbeddings(botId, [], options);

    expect(resolveEmbedder).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
