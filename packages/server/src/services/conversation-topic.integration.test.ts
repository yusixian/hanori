import { createDb, type Database } from "@cos-tool-bot/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store.js";

const url = process.env.SCHEDULED_TASK_TEST_DATABASE_URL;
const botId = "11111111-1111-4111-8111-111111111111";
describe.runIf(Boolean(url))("forum history database isolation", () => {
  let connection: ReturnType<typeof createDb>;
  beforeAll(() => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    )
      throw new Error("Requires local test database");
    connection = createDb(url!);
  });
  afterAll(async () => {
    await connection?.client.end();
  });
  it.each([undefined, 12000])(
    "filters before selecting history with token budget %s",
    async (budget) => {
      await connection.db.transaction(async (db) => {
        await db.execute(
          sql`CREATE TEMP TABLE conversation_messages (id serial,bot_id uuid,chat_id bigint,role text,content text,user_name text,source_key text,meta json,created_at timestamp DEFAULT now()) ON COMMIT DROP`,
        );
        for (const [content, meta, chatId, role] of [
          ["main", { threadId: null }, -100, "user"],
          ["topic", { threadId: 20 }, -100, "context"],
          ["other topic", { threadId: 30 }, -100, "user"],
          ["unknown legacy", {}, -100, "user"],
          ["other chat", { threadId: null }, -200, "user"],
          ["tool output", { threadId: null }, -100, "tool"],
        ] as const) {
          await db.execute(
            sql`INSERT INTO conversation_messages (bot_id,chat_id,role,content,user_name,meta) VALUES (${botId},${chatId},${role},${content},'Fixture',${JSON.stringify(meta)}::json)`,
          );
        }
        const store = new ConversationStore(db as unknown as Database);
        for (const [threadId, expected] of [
          [null, "main"],
          [20, "topic"],
        ] as const) {
          const result = await store.getHistory(botId, -100, 1, budget, { threadId });
          expect(result.summary).toBeNull();
          expect(result.messages.map((row) => row.content)).toEqual([expected]);
        }
      });
    },
  );
});
