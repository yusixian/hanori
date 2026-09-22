import { randomUUID } from "node:crypto";
import { createDb, type Database } from "@cos-tool-bot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store.js";

const url = process.env.CONVERSATION_SEARCH_TEST_DATABASE_URL;

// Explicit opt-in only; never reuse DATABASE_URL or a production schema.
describe.skipIf(!url)("conversation list search PostgreSQL integration", () => {
  let client: ReturnType<typeof createDb>["client"];
  let store: ConversationStore;
  const namespace = `conversation_search_test_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Conversation search integration tests require a local *_test database");
    }
    parsed.searchParams.set("search_path", namespace);
    const connection = createDb(parsed.toString());
    client = connection.client;
    store = new ConversationStore(connection.db as Database);
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    await client.unsafe(`
      CREATE TABLE conversation_messages (
        id serial PRIMARY KEY,
        bot_id uuid NOT NULL,
        chat_id bigint NOT NULL,
        role text NOT NULL,
        content text NOT NULL,
        user_authored_content text,
        user_id bigint,
        user_name text,
        source_key text,
        meta json,
        created_at timestamp DEFAULT now() NOT NULL
      );
      CREATE TABLE conversation_summaries (
        id serial PRIMARY KEY,
        bot_id uuid NOT NULL,
        chat_id bigint NOT NULL,
        content text NOT NULL,
        previous_summarized_up_to_id integer,
        summarized_up_to_id integer NOT NULL,
        message_count integer NOT NULL,
        created_at timestamp DEFAULT now() NOT NULL
      );
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe("TRUNCATE conversation_summaries, conversation_messages RESTART IDENTITY");
  });

  async function addMessage(params: {
    botId: string;
    chatId: number;
    role?: string;
    content?: string;
    userId?: number;
    userName?: string;
    createdAt?: Date;
  }) {
    await client`
      INSERT INTO conversation_messages (
        bot_id, chat_id, role, content, user_id, user_name, created_at
      ) VALUES (
        ${params.botId}, ${params.chatId}, ${params.role ?? "user"},
        ${params.content ?? "message"}, ${params.userId ?? null},
        ${params.userName ?? null}, ${(params.createdAt ?? new Date()).toISOString()}
      )
    `;
  }

  it("matches participant names literally within one bot and aggregates the full conversation", async () => {
    const botId = randomUUID();
    const otherBotId = randomUUID();
    const old = new Date("2026-09-20T00:00:00Z");
    const recent = new Date("2026-09-21T00:00:00Z");
    await addMessage({ botId, chatId: 101, userId: 1, userName: "Alice_100%", createdAt: old });
    await addMessage({
      botId,
      chatId: 101,
      userId: 2,
      userName: "Bob who does not match",
      createdAt: new Date("2026-09-20T12:00:00Z"),
    });
    await addMessage({
      botId,
      chatId: 101,
      role: "assistant",
      content: "complete latest reply",
      createdAt: recent,
    });
    await addMessage({ botId, chatId: 102, userId: 2, userName: "AliceX100Z" });
    await addMessage({ botId, chatId: 103, userId: 3, userName: "Back\\Slash" });
    await addMessage({ botId: otherBotId, chatId: 101, userId: 4, userName: "ALICE_100% other" });
    await client`
      INSERT INTO conversation_summaries (
        bot_id, chat_id, content, summarized_up_to_id, message_count
      ) VALUES
        (${botId}, 101, 'summary', 1, 1),
        (${otherBotId}, 101, 'other bot summary', 1, 1)
    `;

    const result = await store.getConversationList(botId, 1, 20, "  alice_100%  ");

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      chatId: 101,
      messageCount: 3,
      summaryCount: 1,
      lastMessage: { content: "complete latest reply", role: "assistant" },
      roleCounts: { user: 2, assistant: 1 },
    });
    expect(result.data[0]?.distinctUserCount).toBe(2);
    expect(result.data[0]?.userNames).toEqual(
      expect.arrayContaining(["Alice_100%", "Bob who does not match"]),
    );
    expect(String(result.data[0]!.firstActive)).toContain("2026-09-20");
    expect(String(result.data[0]!.lastActive)).toContain("2026-09-21");

    const backslash = await store.getConversationList(botId, 1, 20, "back\\sl");
    expect(backslash).toMatchObject({ total: 1, data: [{ chatId: 103 }] });
  });

  it("ORs safe exact chat IDs with names without rounding unsafe numeric searches", async () => {
    const botId = randomUUID();
    await addMessage({ botId, chatId: Number.MAX_SAFE_INTEGER, userName: "Safe chat" });
    await client`
      INSERT INTO conversation_messages (bot_id, chat_id, role, content, user_name)
      VALUES (${botId}, ${"9007199254740992"}, 'user', 'unsafe numeric row', 'Does not match')
    `;
    await addMessage({ botId, chatId: 77, userName: "9007199254740993 participant" });
    await addMessage({ botId, chatId: -42, userName: "Group chat" });

    const safe = await store.getConversationList(botId, 1, 20, String(Number.MAX_SAFE_INTEGER));
    expect(safe).toMatchObject({ total: 1, data: [{ chatId: Number.MAX_SAFE_INTEGER }] });

    const unsafe = await store.getConversationList(botId, 1, 20, "9007199254740993");
    expect(unsafe).toMatchObject({ total: 1, data: [{ chatId: 77 }] });

    const negative = await store.getConversationList(botId, 1, 20, "-42");
    expect(negative).toMatchObject({ total: 1, data: [{ chatId: -42 }] });
  });

  it("returns the full total and a stable second page for 25 matching conversations", async () => {
    const botId = randomUUID();
    const otherBotId = randomUUID();
    const sameActivity = new Date("2026-09-22T00:00:00Z");
    for (let index = 1; index <= 25; index++) {
      await addMessage({
        botId,
        chatId: 1_000 + index,
        userId: index,
        userName: `Needle participant ${index}`,
        createdAt: sameActivity,
      });
    }
    await addMessage({
      botId: otherBotId,
      chatId: 999,
      userName: "Needle outside bot",
      createdAt: sameActivity,
    });

    const result = await store.getConversationList(botId, 2, 20, "needle");

    expect(result.total).toBe(25);
    expect(result.data.map((conversation) => conversation.chatId)).toEqual([
      1021, 1022, 1023, 1024, 1025,
    ]);

    const blank = await store.getConversationList(botId, 1, 100, "   ");
    const omitted = await store.getConversationList(botId, 1, 100);
    expect(blank).toEqual(omitted);
  });
});
