import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "@cos-tool-bot/database";
import { sql } from "drizzle-orm";
import { readScopedHistory } from "./scoped-history.js";
import { readScheduledTaskHistory } from "./scheduled-task-history.js";

// Explicit isolated PostgreSQL only; no production schema or pgvector is required.
const databaseUrl = process.env.SCHEDULED_TASK_TEST_DATABASE_URL;
const botId = "11111111-1111-4111-8111-111111111111";
const otherBotId = "22222222-2222-4222-8222-222222222222";
const window = {
  since: new Date("2026-11-11T00:00:00Z"),
  until: new Date("2026-11-12T00:00:00Z"),
  limit: 100,
};

describe.runIf(Boolean(databaseUrl))("task history PostgreSQL isolation", () => {
  let connection: ReturnType<typeof createDb>;
  beforeAll(() => {
    const url = new URL(databaseUrl!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.pathname.endsWith("_test")
    )
      throw new Error("History integration tests require a local _test database");
    connection = createDb(databaseUrl!);
  });
  afterAll(async () => {
    await connection?.client.end();
  });

  async function fixture<T>(run: (db: Pick<Database, "select" | "execute">) => Promise<T>) {
    return connection.db.transaction(async (db) => {
      // Temp tables shadow public tables only on this transaction's connection.
      await db.execute(
        sql`CREATE TEMP TABLE conversation_messages (id serial, bot_id uuid, chat_id bigint, role text, content text, user_authored_content text, user_id bigint, user_name text, meta json, created_at timestamp) ON COMMIT DROP`,
      );
      await db.execute(
        sql`CREATE TEMP TABLE user_privacy_settings (bot_id uuid, user_id bigint, mode text) ON COMMIT DROP`,
      );
      await db.execute(
        sql`INSERT INTO user_privacy_settings VALUES (${botId},1,'normal'),(${botId},2,'isolated'),(${botId},3,'off'),(${otherBotId},2,'normal'),(${otherBotId},4,'off')`,
      );
      for (const userId of [1, 2, 3, 4]) {
        for (const [name, meta] of [
          ["unknown", {}],
          ["main", { threadId: null }],
          ["topic7", { threadId: 7 }],
          ["topic8", { threadId: 8 }],
        ] as const) {
          const text = `${userId}:${name}`;
          await db.execute(
            sql`INSERT INTO conversation_messages(bot_id,chat_id,role,content,user_authored_content,user_id,user_name,meta,created_at) VALUES (${botId},-1,'user','wrapped content',${text},${userId},'User',${JSON.stringify(meta)}::json,'2026-11-11 12:00:00')`,
          );
        }
      }
      await db.execute(sql`INSERT INTO conversation_messages(bot_id,chat_id,role,content,user_id,meta,created_at) VALUES
        (${otherBotId},-1,'user','wrong bot',1,'{"threadId":7}','2026-11-11 12:00:00'),
        (${botId},-2,'user','wrong chat',1,'{"threadId":7}','2026-11-11 12:00:00'),
        (${botId},-1,'user','before window',1,'{"threadId":7}','2026-11-10 12:00:00'),
        (${botId},-1,'user','after window',1,'{"threadId":7}','2026-11-13 12:00:00'),
        (${botId},-1,'assistant','derived content',1,'{"threadId":7}','2026-11-11 12:00:00'),
        (${botId},-1,'user','unknown author',null,'{"threadId":7}','2026-11-11 12:00:00'),
        (${botId},-1,'context','legacy unknown topic',1,null,'2026-11-11 12:00:00')`);
      return run(db);
    });
  }

  it.each([
    { threadId: null, label: "main" },
    { threadId: 7, label: "topic7" },
    { threadId: 8, label: "topic8" },
  ])("returns normal/default-normal only in known $label scope", async ({ threadId, label }) => {
    await fixture(async (db) => {
      const result = await readScheduledTaskHistory(db, { botId, chatId: -1, threadId }, window);
      expect(result.messages.map((message) => message.content)).toEqual([
        `1:${label}`,
        `4:${label}`,
      ]);
      expect(result.complete).toBe(true);
    });
  });
  it.each([2, 10])("reports available history complete at limit %s", async (limit) => {
    await fixture(async (db) => {
      const result = await readScheduledTaskHistory(
        db,
        { botId, chatId: -1, threadId: 7 },
        { ...window, limit },
      );
      expect(result.messages).toHaveLength(2);
      expect(result.complete).toBe(true);
    });
  });
  it("reports an empty authorized window complete", async () => {
    await fixture(async (db) => {
      const result = await readScheduledTaskHistory(
        db,
        { botId, chatId: -1, threadId: 7 },
        { ...window, until: new Date("2026-11-11T01:00:00Z") },
      );
      expect(result.messages).toEqual([]);
      expect(result.complete).toBe(true);
    });
  });
  it("applies limits after privacy filtering and returns chronological results", async () => {
    await fixture(async (db) => {
      const result = await readScheduledTaskHistory(
        db,
        { botId, chatId: -1, threadId: 7 },
        { ...window, limit: 1 },
      );
      expect(result.messages.map((message) => message.content)).toEqual(["4:topic7"]);
      expect(result.complete).toBe(false);
    });
  });
  it("retains only assistant rows with a same-scope, currently visible source", async () => {
    await fixture(async (db) => {
      await db.execute(sql`INSERT INTO conversation_messages(bot_id,chat_id,role,content,meta,created_at)
        SELECT ${botId},-1,'assistant','reply:' || id,json_build_object('threadId',7,'turnOrderId',id),'2026-11-11 13:00:00'
        FROM conversation_messages WHERE role = 'user'`);
      const result = await readScopedHistory(db, { botId, chatId: -1, threadId: 7 }, window, [
        "assistant",
      ]);
      // Source ids 3/15 are the normal/default-normal messages in topic 7.
      expect(result.messages.map((m) => m.content)).toEqual([
        "reply:3",
        "reply:15",
        "reply:19",
        "reply:20",
      ]);
      // Sources outside the requested time window may validate a reply's privacy without entering its summary.
      expect(result.coverage.complete).toBe(true);
      await db.execute(
        sql`UPDATE user_privacy_settings SET mode='off' WHERE bot_id=${botId} AND user_id=1`,
      );
      const after = await readScopedHistory(db, { botId, chatId: -1, threadId: 7 }, window, [
        "assistant",
      ]);
      expect(after.messages.map((m) => m.content)).toEqual(["reply:15"]);
    });
  });
  it("returns structured coverage without calling unknown retention a gap", async () => {
    await fixture(async (db) => {
      const result = await readScheduledTaskHistory(
        db,
        { botId, chatId: -1, threadId: 7 },
        { ...window, limit: 1 },
      );
      expect(result.coverage).toMatchObject({
        returnedCount: 1,
        complete: false,
        truncated: true,
        reason: "message_limit",
        collectionCoverage: "unknown",
        scope: { limit: 1, threadId: 7 },
      });
    });
  });
  it("keeps a delayed assistant reply beside its source turn, with actual timestamp bounds", async () => {
    await fixture(async (db) => {
      await db.execute(
        sql`INSERT INTO conversation_messages(bot_id,chat_id,role,content,meta,created_at) VALUES (${botId},-1,'assistant','delayed reply','{"threadId":7,"turnOrderId":3}','2026-11-11 13:00:00')`,
      );
      const result = await readScopedHistory(db, { botId, chatId: -1, threadId: 7 }, window, [
        "user",
        "assistant",
      ]);
      expect(result.messages.map((m) => m.content)).toEqual([
        "1:topic7",
        "delayed reply",
        "4:topic7",
      ]);
      expect(result.coverage).toMatchObject({
        firstMessageAt: "2026-11-11T12:00:00.000Z",
        lastMessageAt: "2026-11-11T13:00:00.000Z",
      });
    });
  });
});
