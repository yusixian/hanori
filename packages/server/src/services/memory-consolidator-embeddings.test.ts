import type { Database } from "@cos-tool-bot/database";
import {
  EMBEDDING_DIMENSIONS,
  botMemories,
  bots,
  conversationMessages,
  memoryConsolidationState,
  userPrivacySettings,
} from "@cos-tool-bot/database";
import type { AiConfigStored, UsageGovernancePort } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../utils/crypto.js";
import { BotMemoryWriter } from "./bot-memory-writer.js";
import { MemoryConsolidator } from "./memory-consolidator.js";

const sdk = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn((settings: Record<string, unknown>) => ({
    embeddingModel: (modelId: string) => ({ modelId, settings }),
  })),
  embedMany: vi.fn(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((value) => [value.length]),
  })),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: sdk.createOpenAICompatible,
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  embedMany: sdk.embedMany,
}));

const encryptionKey = "consolidation-test-key";

const botId = "11111111-1111-4111-8111-111111111111";
const old = new Date("2026-01-01T00:00:00.000Z");
const source = {
  id: 101,
  botId,
  chatId: 41,
  role: "user",
  userId: 41,
  userAuthoredContent: "I switched to green tea and I am moving to Kyoto",
  sourceKey: "telegram:501:user",
  meta: { turnState: "complete" },
  createdAt: old,
};
const shown = {
  id: 7,
  botId,
  telegramId: 41,
  scopeChatId: null,
  content: "Prefers black tea",
  category: null,
  kind: "preference",
  origin: "consolidation",
  sourceChatId: 41,
  sourceMessageId: 400,
  sourceUserId: 41,
  expiresAt: null,
  factValidAt: null,
  supersededById: null,
  isActive: true,
  updatedAt: old,
};
const proposals = [
  {
    action: "update",
    kind: "preference",
    content: "Prefers green tea",
    targetId: 7,
    sourceMessageIds: [101],
    participantIds: [41],
  },
  {
    action: "add",
    kind: "fact",
    content: "Is moving to Kyoto",
    sourceMessageIds: [101],
    participantIds: [41],
  },
];

type Query = {
  op: "select" | "insert" | "update";
  inTransaction: boolean;
  table?: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
};

function memoryRow(id: number, content: unknown) {
  return { ...shown, id, content, createdAt: old, embedding: null };
}

/** Scripted Drizzle double for one private-chat consolidation batch. */
function consolidationDb(transactionSource: typeof source, aiConfig: Record<string, unknown>) {
  const events: string[] = [];
  const lease = { botId, cursorMessageId: 0, leaseOwner: "owner", leaseUntil: new Date(8e15) };
  const rows = (query: Query): unknown[] => {
    if (query.table === bots) {
      return [{ id: botId, isActive: true, aiConfig }];
    }
    if (query.table === memoryConsolidationState) return query.op === "update" ? [] : [lease];
    if (query.table === conversationMessages) {
      return [query.inTransaction ? transactionSource : source];
    }
    if (query.table === userPrivacySettings) return [];
    if (query.table === botMemories) {
      if (query.op === "insert") return [memoryRow(8, query.values?.["content"])];
      if (query.op === "update") return [memoryRow(7, query.set?.["content"])];
      return [{ ...shown }];
    }
    return [];
  };
  const builder = (query: Query) => {
    const chain = {
      from: (table: unknown) => {
        query.table = table;
        return chain;
      },
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      for: () => chain,
      values: (values: Record<string, unknown>) => {
        query.values = values;
        return chain;
      },
      set: (set: Record<string, unknown>) => {
        query.set = set;
        return chain;
      },
      onConflictDoUpdate: () => chain,
      returning: () => chain,
      // oxlint-disable-next-line unicorn/no-thenable -- Drizzle queries are intentionally awaitable.
      then: <TResult1 = unknown[], TResult2 = never>(
        onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows(query)).then(onFulfilled, onRejected),
    };
    return chain;
  };
  const executor = (inTransaction: boolean) => ({
    select: () => builder({ op: "select", inTransaction }),
    insert: (table: unknown) => builder({ op: "insert", inTransaction, table }),
    update: (table: unknown) => builder({ op: "update", inTransaction, table }),
    execute: async () => [],
  });
  const db = {
    ...executor(false),
    transaction: async <T>(run: (tx: ReturnType<typeof executor>) => Promise<T>) => {
      events.push("begin");
      const result = await run(executor(true));
      events.push("commit");
      return result;
    },
  };
  return { db: db as unknown as Database, events };
}

function consolidate(
  options: {
    transactionSource?: typeof source;
    runningEmbedder?: boolean;
    embeddingConfig?: Record<string, unknown>;
  } = {},
) {
  const aiConfig = {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "",
    model: "",
    botMemoryConfig: { enabled: true },
    ...(options.embeddingConfig ? { embeddingConfig: options.embeddingConfig } : {}),
  };
  const { db, events } = consolidationDb(options.transactionSource ?? source, aiConfig);
  const store = {
    updateEmbeddingIfContentMatches: vi.fn(async () => {
      events.push("store vector");
      return true;
    }),
  };
  const embedder = {
    generateEmbedding: vi.fn(async () => null),
    generateEmbeddings: vi.fn(async (texts: string[]) => {
      events.push("embed");
      return texts.map((text) => [text.length]);
    }),
  };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const usage = {
    reserve: vi.fn(async () => ({ allowed: true, reservationId: "reservation" })),
    refund: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
  };
  const consolidator = new MemoryConsolidator(
    db,
    logger as unknown as Logger,
    encryptionKey,
    usage as unknown as UsageGovernancePort,
    new BotMemoryWriter(
      store as unknown as ConstructorParameters<typeof BotMemoryWriter>[0],
      () => (options.runningEmbedder === false ? undefined : embedder),
      logger,
    ),
    async (_config: AiConfigStored, _prompt: string) => ({
      text: JSON.stringify(proposals),
      model: "model",
      providerId: "provider",
      inputTokens: 1,
      outputTokens: 1,
    }),
  );
  return { run: () => consolidator.tick(), events, store, embedder, logger };
}

beforeEach(() => {
  sdk.createOpenAICompatible.mockClear();
  sdk.embedMany.mockClear();
});

describe("memory consolidation embeddings", () => {
  it("embeds created and rewritten memories only after the batch commits", async () => {
    const { run, events, store, embedder, logger } = consolidate();

    await run();

    expect(logger.error).not.toHaveBeenCalled();
    expect(embedder.generateEmbeddings).toHaveBeenCalledWith(
      ["Prefers green tea", "Is moving to Kyoto"],
      expect.any(AbortSignal),
    );
    expect(store.updateEmbeddingIfContentMatches.mock.calls).toEqual([
      [botId, 7, "Prefers green tea", [17]],
      [botId, 8, "Is moving to Kyoto", [18]],
    ]);
    expect(events).toEqual(["begin", "commit", "embed", "store vector", "store vector"]);
  });

  it("embeds nothing when the batch rolls back", async () => {
    const { run, events, store, embedder, logger } = consolidate({
      transactionSource: { ...source, userAuthoredContent: "Edited after the model call" },
    });

    await run();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ botId }),
      "Memory consolidation failed",
    );
    expect(events).toEqual(["begin"]);
    expect(embedder.generateEmbeddings).not.toHaveBeenCalled();
    expect(store.updateEmbeddingIfContentMatches).not.toHaveBeenCalled();
  });

  it("embeds with the stored embedding config when the Bot is not running here", async () => {
    const { run, store, logger } = consolidate({
      runningEmbedder: false,
      embeddingConfig: {
        enabled: true,
        encryptedApiKey: encrypt("embedding-secret", encryptionKey),
        baseURL: "https://embedding.example/v1",
        model: "embedding-model",
        dimensions: EMBEDDING_DIMENSIONS,
      },
    });

    await run();

    expect(logger.error).not.toHaveBeenCalled();
    expect(sdk.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://embedding.example/v1",
        apiKey: "embedding-secret",
      }),
    );
    expect(sdk.embedMany).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ["Prefers green tea", "Is moving to Kyoto"],
        model: expect.objectContaining({ modelId: "embedding-model" }),
        providerOptions: { embedding: { dimensions: EMBEDDING_DIMENSIONS } },
      }),
    );
    expect(store.updateEmbeddingIfContentMatches.mock.calls).toEqual([
      [botId, 7, "Prefers green tea", [17]],
      [botId, 8, "Is moving to Kyoto", [18]],
    ]);
  });

  it("logs the batch once when neither the pool nor the stored config has an embedder", async () => {
    const { run, store, logger } = consolidate({ runningEmbedder: false });

    await run();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { botId, count: 2 },
      "No embedder for this Bot; memories kept without vectors",
    );
    expect(sdk.embedMany).not.toHaveBeenCalled();
    expect(store.updateEmbeddingIfContentMatches).not.toHaveBeenCalled();
  });
});
