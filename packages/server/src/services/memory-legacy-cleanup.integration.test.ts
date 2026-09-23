import { randomUUID } from "node:crypto";
import { createDb, type Database } from "@cos-tool-bot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotMemoryStore } from "./bot-memory-store.js";
import { MemoryLegacyCleanup } from "./memory-legacy-cleanup.js";

const url = process.env.MEMORY_DUPLICATE_TEST_DATABASE_URL;

// Explicit opt-in; never use the application's DATABASE_URL.
describe.skipIf(!url)("legacy memory cleanup PostgreSQL integration", () => {
  const namespace = `memory_duplicate_test_${randomUUID().replaceAll("-", "")}`;
  const botId = randomUUID();
  let client: ReturnType<typeof createDb>["client"];
  let db: Database;
  let service: MemoryLegacyCleanup;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Memory duplicate integration requires a local *_test database");
    }
    parsed.searchParams.set("search_path", namespace);
    const connection = createDb(parsed.toString());
    client = connection.client;
    db = connection.db;
    service = new MemoryLegacyCleanup(connection.db);
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    await client.unsafe(`
      CREATE TABLE bot_memories (
        id serial PRIMARY KEY,
        bot_id uuid NOT NULL,
        telegram_id bigint,
        content text NOT NULL,
        category text,
        kind text,
        scope_chat_id bigint,
        origin text,
        source_chat_id bigint,
        source_message_id bigint,
        source_user_id bigint,
        expires_at timestamp,
        embedding text,
        fact_valid_at timestamp,
        superseded_by_id integer,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL,
        updated_at timestamp
      );
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.end();
  });

  it("keeps validity groups separate and preserves the only embedded copy", async () => {
    const oldTime = "2026-09-20T00:00:00.000Z";
    const newTime = "2026-09-21T00:00:00.000Z";
    const expires = "2026-10-01T00:00:00.000Z";
    const [embedded] = await client`
      INSERT INTO bot_memories (bot_id, telegram_id, content, kind, embedding, created_at, updated_at)
      VALUES (${botId}, 42, 'Tea preference', 'preference', '[0.1]', ${oldTime}, ${oldTime})
      RETURNING id
    `;
    const [plain] = await client`
      INSERT INTO bot_memories (bot_id, telegram_id, content, kind, created_at, updated_at)
      VALUES (${botId}, 42, 'Tea preference', 'preference', ${newTime}, ${newTime})
      RETURNING id
    `;
    await client`
      INSERT INTO bot_memories (bot_id, telegram_id, content, kind, expires_at, created_at, updated_at)
      VALUES (${botId}, 42, 'Tea preference', 'preference', ${expires}, ${newTime}, ${newTime})
    `;

    const preview = await service.preview(botId);
    expect(preview.data).toMatchObject([
      { candidateId: Number(plain!.id), survivorId: Number(embedded!.id) },
    ]);
    expect(preview.hasMore).toBe(false);
    expect(await service.retireBatch(botId, preview.data)).toEqual({ retiredCount: 1 });
    expect(await service.preview(botId)).toMatchObject({ data: [] });

    const rows = await client`
      SELECT id, is_active, superseded_by_id FROM bot_memories WHERE bot_id = ${botId} ORDER BY id
    `;
    expect(rows.map((row) => [Number(row.id), row.is_active, row.superseded_by_id])).toEqual([
      [Number(embedded!.id), true, null],
      [Number(plain!.id), false, Number(embedded!.id)],
      [Number(plain!.id) + 1, true, null],
    ]);
  });

  it("edits a microsecond timestamp with a millisecond API version and rejects stale writes", async () => {
    const memoryBotId = randomUUID();
    const [created] = await client`
      INSERT INTO bot_memories (bot_id, telegram_id, content, created_at, updated_at)
      VALUES (${memoryBotId}, 42, 'Original', '2026-09-20 00:00:00.123456', '2026-09-20 00:00:00.123456')
      RETURNING id
    `;
    const memoryId = Number(created!.id);
    const store = new BotMemoryStore(db);
    const before = await store.getMemory(memoryBotId, memoryId);
    expect(before?.updatedAt).toBe("2026-09-20T00:00:00.123Z");

    const edited = await store.updateMemory(memoryBotId, memoryId, {
      category: "corrected",
      expectedUpdatedAt: before!.updatedAt,
    });
    expect(edited?.category).toBe("corrected");
    expect(edited!.updatedAt).not.toBe(before!.updatedAt);
    expect(Math.abs(Date.parse(edited!.updatedAt) - Date.now())).toBeLessThan(60_000);
    expect(
      await store.updateMemory(memoryBotId, memoryId, {
        category: "stale",
        expectedUpdatedAt: before!.updatedAt,
      }),
    ).toBeNull();

    expect(
      await store.updateEmbeddingIfContentMatches(memoryBotId, memoryId, "Original", [0.2]),
    ).toBe(true);
    expect((await store.getMemory(memoryBotId, memoryId))?.updatedAt).toBe(edited!.updatedAt);

    const racing = await Promise.all(
      ["first", "second"].map((category) =>
        store.updateMemory(memoryBotId, memoryId, {
          category,
          expectedUpdatedAt: edited!.updatedAt,
        }),
      ),
    );
    expect(racing.filter((result) => result !== null)).toHaveLength(1);
  });
});
