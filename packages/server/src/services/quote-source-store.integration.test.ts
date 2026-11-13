import { createDb, type Database } from "@cos-tool-bot/database";
import type { QuoteSource, UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QuoteSourceStore } from "./quote-source-store.js";
import { UserPrivacyService } from "./user-privacy-service.js";
import { captureQuoteSource } from "@cos-tool-bot/bot";
type Message = Parameters<typeof captureQuoteSource>[0];
const url = process.env.QUOTE_TEST_DATABASE_URL;
const botId = "11111111-1111-4111-8111-111111111111";
const otherBot = "22222222-2222-4222-8222-222222222222";
const source = (id: number, threadId: number | null = null, user = 5): QuoteSource => ({
  version: 1,
  messageId: id,
  threadId,
  capturedAt: 100000,
  text: `source ${id}`,
  entities: [],
  author: { key: `user:${user}`, name: "Fixture", userId: user },
  privacyUserIds: [user],
});
describe.runIf(Boolean(url))("quote sources PostgreSQL boundaries", () => {
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
  it("scopes rows, filters privacy before limit, persists reset and output receipts", async () => {
    await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE conversation_messages (id serial,bot_id uuid,chat_id bigint,role text,content text,meta json,created_at timestamp DEFAULT now()) ON COMMIT DROP`,
      );
      await tx.execute(
        sql`CREATE TEMP TABLE user_privacy_settings (bot_id uuid,user_id bigint,mode text,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),PRIMARY KEY(bot_id,user_id)) ON COMMIT DROP`,
      );
      await tx.execute(
        sql`CREATE TEMP TABLE settings (key text PRIMARY KEY,value text NOT NULL,updated_at timestamp DEFAULT now()) ON COMMIT DROP`,
      );
      const insert = async (id: number, meta: object, bot = botId, chat = -100) =>
        tx.execute(
          sql`INSERT INTO conversation_messages (bot_id,chat_id,role,content,meta) VALUES (${bot},${chat},'user','public text',${JSON.stringify({ tgMessageId: id, ...meta })}::json)`,
        );
      await insert(10, { threadId: null, quoteSource: source(10) });
      await insert(11, { threadId: null, quoteSource: source(11, null, 6) });
      await insert(12, { threadId: null, quoteSource: source(12) });
      await insert(13, { quoteSource: source(13) });
      await insert(14, { threadId: 20, quoteSource: source(14, 20) });
      await insert(15, { threadId: null, quoteSource: source(15) }, otherBot);
      await insert(16, { threadId: null, quoteSource: source(16) }, botId, -200);
      await insert(17, { threadId: null, quoteSource: source(18) });
      await insert(19, { threadId: null, quoteSource: source(19, 20) });
      await tx.execute(
        sql`INSERT INTO user_privacy_settings (bot_id,user_id,mode) VALUES (${botId},6,'off')`,
      );
      const db = tx as unknown as Database;
      const store = new QuoteSourceStore(db).forBot(botId);
      expect(
        (
          await store.getQuoteSources(-100, null, { anchorId: 10, direction: "forward", limit: 2 })
        ).map((s) => s.messageId),
      ).toEqual([10, 12]);
      expect(
        (await store.getQuoteSources(-100, 20, { ids: [14] })).map((s) => s.messageId),
      ).toEqual([14]);
      expect(
        await store.getQuoteSources(-100, null, { ids: [13, 14, 15, 16, 17, 18, 19] }),
      ).toEqual([]);
      await store.setQuoteColor(-100, "blue");
      expect(await store.getQuoteColor(-100)).toBe("#172B4D");
      expect(await new QuoteSourceStore(db).forBot(otherBot).getQuoteColor(-100)).toBeUndefined();
      for (let id = 1; id <= 260; id++) await store.markQuoteOutput(-100, id);
      expect(await new QuoteSourceStore(db).forBot(botId).isQuoteOutput(-100, 1)).toBe(true);
      expect(await store.isQuoteOutput(-200, 1)).toBe(false);
      const privacy = new UserPrivacyService(db, () => 101000);
      await privacy.setMode(botId, 5, "off");
      await privacy.setMode(botId, 5, "normal");
      const rebuilt = new UserPrivacyService(db);
      expect(await rebuilt.getQuoteResetAt(botId, 5)).toBe(101000);
      expect(rebuilt.getContextResetAt(botId, 5)).toBeUndefined();
      expect(await store.getQuoteSources(-100, null, { ids: [10, 12] })).toEqual([]);
      const rows = await tx.execute(
        sql`SELECT content,meta FROM conversation_messages WHERE bot_id=${botId} AND meta->>'tgMessageId'='10'`,
      );
      expect(rows[0]).toMatchObject({
        content: "public text",
        meta: { tgMessageId: 10, threadId: null },
      });
      expect(rows[0]?.meta).not.toHaveProperty("quoteSource");
      expect(
        await new QuoteSourceStore(db).forBot(otherBot).getQuoteSources(-100, null, { ids: [15] }),
      ).toHaveLength(1);
      const callbacks = {
        getMode: (id: number) => rebuilt.getMode(botId, id),
        getQuoteResetAt: (id: number) => rebuilt.getQuoteResetAt(botId, id),
      } as UserPrivacyCallbacks;
      const oldReply = {
        message_id: 10,
        date: 100,
        chat: { id: -100, type: "supergroup" },
        from: { id: 5, is_bot: false, first_name: "Fixture" },
        text: "old reply",
      } as Message;
      expect(
        await captureQuoteSource(oldReply, { chatId: -100, threadId: null }, callbacks),
      ).toEqual({ reason: "privacy" });
    });
  });
});
