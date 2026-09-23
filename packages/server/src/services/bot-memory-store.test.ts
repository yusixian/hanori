import type { Database } from "@cos-tool-bot/database";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BotMemoryStore } from "./bot-memory-store.js";

function createDb(resultSets: Array<Array<Record<string, unknown>>> = []) {
  const whereClauses: SQL[] = [];
  let selectIndex = 0;
  const db = {
    select: () => {
      const rows = resultSets[selectIndex++] ?? [];
      const query = {
        from: () => query,
        where: (where: SQL) => {
          whereClauses.push(where);
          return query;
        },
        orderBy: () => query,
        limit: async () => rows,
      };
      return query;
    },
  };
  return { db: db as unknown as Database, whereClauses };
}

function renderWhere(where: SQL) {
  return new PgDialect().sqlToQuery(where);
}

function memoryRow() {
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    id: 1,
    botId: "00000000-0000-0000-0000-000000000001",
    telegramId: null,
    content: "cats",
    category: null,
    kind: null,
    scopeChatId: null,
    origin: null,
    sourceChatId: null,
    sourceMessageId: null,
    sourceUserId: null,
    expiresAt: null,
    embedding: null,
    factValidAt: null,
    supersededById: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

function createUpdateDb(rows: Array<Record<string, unknown>>) {
  const updates: Array<Record<string, unknown>> = [];
  const whereClauses: SQL[] = [];
  const query = {
    set: (update: Record<string, unknown>) => {
      updates.push(update);
      return query;
    },
    where: (where: SQL) => {
      whereClauses.push(where);
      return query;
    },
    returning: async () => rows,
  };
  return {
    db: { update: () => query } as unknown as Database,
    updates,
    whereClauses,
  };
}

describe("BotMemoryStore scopes", () => {
  it("treats all scope without a user as general-only", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);

    await store.recallMemories("00000000-0000-0000-0000-000000000001", {
      query: "rules",
      scope: "all",
    });

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" is null');
    expect(rendered.sql).not.toContain('"bot_memories"."telegram_id" =');
  });

  it("keeps general and current-user memories when all scope has a user", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);

    await store.recallMemories("00000000-0000-0000-0000-000000000001", {
      query: "cats",
      telegramId: 42,
      scope: "all",
    });

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" is null');
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" =');
    expect(rendered.params).toContain(42);
  });

  it("uses the same safe general-only fallback for recent prompt memories", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);

    await store.getMemoriesForPrompt("00000000-0000-0000-0000-000000000001", { limit: 4 });

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" is null');
  });

  it("keeps legacy rows visible without inventing provenance", async () => {
    const { db } = createDb([[memoryRow()]]);
    const store = new BotMemoryStore(db);

    await expect(store.getMemoriesForPrompt(memoryRow().botId, { limit: 4 })).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        kind: null,
        scopeChatId: null,
        origin: null,
        sourceChatId: null,
        sourceUserId: null,
        expiresAt: null,
      }),
    ]);
  });

  it("only includes matching chat memories and unexpired memories", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);
    await store.recallMemories(memoryRow().botId, { query: "cats", scopeChatId: -100 });

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."scope_chat_id" is null');
    expect(rendered.sql).toContain('"bot_memories"."scope_chat_id" =');
    expect(rendered.params).toContain(-100);
    expect(rendered.sql).toContain('"bot_memories"."expires_at" is null');
    expect(rendered.sql).toContain('"bot_memories"."expires_at" >');
  });

  it("excludes unscoped personal memories in isolated mode", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);
    await store.recallMemories(memoryRow().botId, {
      telegramId: 42,
      scopeChatId: -100,
      includeUnscopedPersonal: false,
    });

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" is null');
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" =');
    expect(rendered.sql).toContain('"bot_memories"."scope_chat_id" =');
    expect(rendered.params).toContain(42);
    expect(rendered.params).toContain(-100);
  });
});

describe("BotMemoryStore semantic threshold", () => {
  it("adds a cosine distance threshold only when requested", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);

    await store.recallMemories("00000000-0000-0000-0000-000000000001", {
      query: "cats",
      queryEmbedding: [0.1, 0.2],
      maxDistance: 0.35,
    });

    const keywordWhere = renderWhere(whereClauses[0]!);
    const vectorWhere = renderWhere(whereClauses[1]!);
    expect(keywordWhere.params).not.toContain(0.35);
    expect(vectorWhere.sql).toContain("<");
    expect(vectorWhere.params).toContain(0.35);
  });

  it("does not force a threshold on explicit recall", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);

    await store.recallMemories("00000000-0000-0000-0000-000000000001", {
      query: "cats",
      queryEmbedding: [0.1, 0.2],
    });

    const vectorWhere = renderWhere(whereClauses[1]!);
    expect(vectorWhere.sql).not.toContain("<");
    expect(vectorWhere.params).not.toContain(0.35);
  });

  it("keeps keyword hits when every vector candidate is over the threshold", async () => {
    const keywordRow = memoryRow();
    const { db } = createDb([[keywordRow], []]);
    const store = new BotMemoryStore(db);

    await expect(
      store.recallMemories("00000000-0000-0000-0000-000000000001", {
        query: "cats",
        queryEmbedding: [0.1, 0.2],
        maxDistance: 0.35,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 1, content: "cats" })]);
  });
});

describe("BotMemoryStore lifecycle", () => {
  it("deduplicates only within the exact user and chat scope", async () => {
    const { db, whereClauses } = createDb();
    const store = new BotMemoryStore(db);
    await store.findSimilar(memoryRow().botId, [0.1, 0.2], 0.15, {
      telegramId: 42,
      scopeChatId: -100,
    });

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" =');
    expect(rendered.sql).not.toContain('"bot_memories"."telegram_id" is null');
    expect(rendered.sql).toContain('"bot_memories"."scope_chat_id" =');
    expect(rendered.sql).not.toContain('"bot_memories"."scope_chat_id" is null');
    expect(rendered.params).toContain(42);
    expect(rendered.params).toContain(-100);
  });

  it("clears embeddings only when submitted content differs from stored content", async () => {
    const { db, updates, whereClauses } = createUpdateDb([memoryRow()]);
    const store = new BotMemoryStore(db);
    await expect(store.updateMemory(memoryRow().botId, 1, { content: "dogs" })).resolves.toEqual(
      expect.objectContaining({ id: 1 }),
    );

    expect(updates[0]?.["content"]).toBe("dogs");
    const embeddingUpdate = new PgDialect().sqlToQuery(updates[0]?.["embedding"] as SQL);
    expect(embeddingUpdate.sql).toContain('"bot_memories"."content" is distinct from');
    expect(embeddingUpdate.sql).toContain('else "bot_memories"."embedding" end');
    expect(embeddingUpdate.params).toContain("dogs");
    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."bot_id" =');
    expect(rendered.sql).toContain('"bot_memories"."id" =');
    expect(rendered.sql).toContain('"bot_memories"."is_active" =');
  });

  it("preserves the embedding for an unchanged content payload or category-only edit", async () => {
    const { db, updates } = createUpdateDb([memoryRow()]);
    const store = new BotMemoryStore(db);
    await store.updateMemory(memoryRow().botId, 1, { content: "cats", category: "preference" });
    await store.updateMemory(memoryRow().botId, 1, { category: "preference" });

    const unchangedContent = new PgDialect().sqlToQuery(updates[0]?.["embedding"] as SQL);
    expect(unchangedContent.sql).toContain('else "bot_memories"."embedding" end');
    expect(unchangedContent.params).toContain("cats");
    expect(updates[1]?.["category"]).toBe("preference");
    const versionUpdate = new PgDialect().sqlToQuery(updates[1]?.["updatedAt"] as SQL);
    expect(versionUpdate.sql).toContain("date_trunc('milliseconds'");
    expect(versionUpdate.sql).toContain("interval '1 millisecond'");
  });

  it("guards retirement and successor links by Bot and exact scope", async () => {
    const { db, updates, whereClauses } = createUpdateDb([{ id: 1 }]);
    const store = new BotMemoryStore(db);
    await expect(store.retireMemory(memoryRow().botId, 1, 1)).resolves.toBe(false);
    expect(updates).toHaveLength(0);

    await expect(store.retireMemory(memoryRow().botId, 1, 2)).resolves.toBe(true);
    expect(updates[0]).toEqual({ isActive: false, supersededById: 2 });
    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain("successor.bot_id =");
    expect(rendered.sql).toContain("successor.telegram_id is not distinct from");
    expect(rendered.sql).toContain("successor.scope_chat_id is not distinct from");
    expect(rendered.params).toContain(2);
  });

  it("guards agent edits by the current user or current chat", async () => {
    const { db, whereClauses } = createUpdateDb([memoryRow()]);
    const store = new BotMemoryStore(db);
    await store.updateMemory(
      memoryRow().botId,
      1,
      { content: "dogs", expectedContent: "cats" },
      {
        userId: 42,
        chatId: -100,
        includeUnscopedPersonal: false,
      },
    );

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."scope_chat_id" =');
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" =');
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" is null');
    expect(rendered.params).toContain(42);
    expect(rendered.params).toContain(-100);
    expect(rendered.params).toContain("cats");
  });

  it("requires current-chat scope when an agent changes a memory into a shared experience", async () => {
    const { db, whereClauses } = createUpdateDb([memoryRow()]);
    const store = new BotMemoryStore(db);
    await store.updateMemory(
      memoryRow().botId,
      1,
      { kind: "event", expectedContent: "cats" },
      { userId: 42, chatId: -100 },
    );

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."scope_chat_id" =');
    expect(rendered.params.filter((value) => value === -100)).toHaveLength(3);
  });

  it("guards admin edits against a newer memory version", async () => {
    const { db, whereClauses } = createUpdateDb([memoryRow()]);
    const store = new BotMemoryStore(db);
    const expectedUpdatedAt = "2026-09-01T12:00:00.000Z";
    await store.updateMemory(memoryRow().botId, 1, {
      category: "updated",
      expectedUpdatedAt,
    });

    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain("date_trunc('milliseconds', coalesce(");
    expect(rendered.params).toContain(expectedUpdatedAt);
  });

  it("limits an Agent's permanent deletion to the current user's own memory", async () => {
    const whereClauses: SQL[] = [];
    const query = {
      where: (where: SQL) => {
        whereClauses.push(where);
        return query;
      },
      returning: async () => [{ id: 1 }],
    };
    const store = new BotMemoryStore({ delete: () => query } as unknown as Database);
    await expect(store.deleteMemory(memoryRow().botId, 1, { chatId: -100 })).resolves.toBe(false);
    await expect(
      store.deleteMemory(memoryRow().botId, 1, { userId: 42, chatId: -100 }),
    ).resolves.toBe(true);

    expect(whereClauses).toHaveLength(1);
    const rendered = renderWhere(whereClauses[0]!);
    expect(rendered.sql).toContain('"bot_memories"."telegram_id" =');
    expect(rendered.sql).not.toContain('"bot_memories"."telegram_id" is null');
    expect(rendered.params).toContain(42);
    expect(rendered.params).toContain(-100);
  });
});
