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
    const now = new Date("2026-07-18T00:00:00.000Z");
    const keywordRow = {
      id: 1,
      botId: "00000000-0000-0000-0000-000000000001",
      telegramId: null,
      content: "cats",
      category: null,
      embedding: null,
      factValidAt: null,
      supersededById: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
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
