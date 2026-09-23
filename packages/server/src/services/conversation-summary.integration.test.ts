import { randomUUID } from "node:crypto";
import { createDb, type Database } from "@cos-tool-bot/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store.js";

const url = process.env.CONVERSATION_SUMMARY_TEST_DATABASE_URL;

// Explicit opt-in; never use the application's DATABASE_URL.
describe.skipIf(!url)("conversation summary PostgreSQL integration", () => {
  let client: ReturnType<typeof createDb>["client"];
  let store: ConversationStore;
  const namespace = `conversation_summary_test_${randomUUID().replaceAll("-", "")}`;
  const botId = randomUUID();
  const chatId = 42;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Conversation summary integration requires a local *_test database");
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
      CREATE TABLE conversation_compaction_state (
        bot_id uuid NOT NULL,
        chat_id bigint NOT NULL,
        active_summary_id integer NOT NULL REFERENCES conversation_summaries(id),
        raw_history_intact boolean NOT NULL DEFAULT true,
        updated_at timestamp DEFAULT now() NOT NULL,
        PRIMARY KEY (bot_id, chat_id)
      );
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      "TRUNCATE conversation_compaction_state, conversation_summaries, conversation_messages RESTART IDENTITY",
    );
  });

  async function addSummary(content: string, cursor = 10) {
    const [row] = await client`
      INSERT INTO conversation_summaries (bot_id, chat_id, content, summarized_up_to_id, message_count)
      VALUES (${botId}, ${chatId}, ${content}, ${cursor}, 10)
      RETURNING id
    `;
    return Number(row!.id);
  }

  async function activate(id: number) {
    await client`
      INSERT INTO conversation_compaction_state (bot_id, chat_id, active_summary_id)
      VALUES (${botId}, ${chatId}, ${id})
    `;
  }

  it("previews and prunes legacy snapshots in bounded batches while protecting an old active cursor", async () => {
    for (let index = 1; index <= 8; index++) await addSummary(`legacy ${index}`);
    await activate(2);
    await client`
      INSERT INTO conversation_messages (bot_id, chat_id, role, content)
      VALUES (${botId}, ${chatId}, 'user', 'raw history stays')
    `;

    const preview = await store.previewConversationSummaryCleanup(botId, chatId);
    expect(preview).toMatchObject({
      activeSummaryId: 2,
      totalCount: 8,
      retainedIds: [8, 7, 6, 2],
      eligibleCount: 4,
      batchMax: 100,
    });
    expect(
      await store.cleanupConversationSummaryBatch({
        botId,
        chatId,
        expectedActiveSummaryId: 99,
        limit: 2,
      }),
    ).toBeNull();
    expect(
      await store.cleanupConversationSummaryBatch({
        botId,
        chatId,
        expectedActiveSummaryId: 2,
        limit: 2,
      }),
    ).toEqual({ deletedCount: 2, remainingCount: 6 });
    expect(
      await store.cleanupConversationSummaryBatch({
        botId,
        chatId,
        expectedActiveSummaryId: 2,
        limit: 2,
      }),
    ).toEqual({ deletedCount: 2, remainingCount: 4 });
    const remaining = await client`
      SELECT id FROM conversation_summaries WHERE bot_id = ${botId} AND chat_id = ${chatId} ORDER BY id
    `;
    expect(remaining.map((row) => Number(row.id))).toEqual([2, 6, 7, 8]);
    const messages =
      await client`SELECT content FROM conversation_messages WHERE bot_id = ${botId}`;
    expect(messages.map((row) => row.content)).toEqual(["raw history stays"]);
  });

  it("versions manual edits with the same cursor and rejects stale edits", async () => {
    const first = await addSummary("old content", 25);
    await activate(first);
    const edited = await store.editActiveConversationSummary({
      botId,
      chatId,
      expectedActiveSummaryId: first,
      content: "corrected content",
    });
    expect(edited?.id).toBe(2);
    expect(
      await store.editActiveConversationSummary({
        botId,
        chatId,
        expectedActiveSummaryId: first,
        content: "stale edit",
      }),
    ).toBeNull();
    const summaries = await client`
      SELECT id, content, summarized_up_to_id FROM conversation_summaries ORDER BY id
    `;
    expect(
      summaries.map((row) => [Number(row.id), row.content, Number(row.summarized_up_to_id)]),
    ).toEqual([
      [1, "old content", 25],
      [2, "corrected content", 25],
    ]);
    const state = await client`SELECT active_summary_id FROM conversation_compaction_state`;
    expect(Number(state[0]!.active_summary_id)).toBe(2);
  });

  it("allows only one concurrent edit of the same active version", async () => {
    const first = await addSummary("initial", 25);
    await activate(first);
    const edits = await Promise.all(
      ["one", "two"].map((content) =>
        store.editActiveConversationSummary({
          botId,
          chatId,
          expectedActiveSummaryId: first,
          content,
        }),
      ),
    );
    expect(edits.filter((result) => result !== null)).toHaveLength(1);
    const summaries = await client`SELECT content FROM conversation_summaries ORDER BY id`;
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.content).toBe("initial");
  });

  it("prunes old versions after a successful compaction without changing raw messages", async () => {
    for (let index = 1; index <= 7; index++) await addSummary(`snapshot ${index}`, 0);
    await activate(7);
    for (let index = 1; index <= 3; index++) {
      await client`
        INSERT INTO conversation_messages (bot_id, chat_id, role, content)
        VALUES (${botId}, ${chatId}, 'user', ${`message ${index}`})
      `;
    }
    const committed = await store.commitCompaction({
      botId,
      chatId,
      expectedActiveSummaryId: 7,
      oldCursorId: 0,
      newCursorId: 3,
      summaryText: "new snapshot",
      messageCount: 3,
      sourceMessageIds: [1, 2, 3],
    });
    expect(committed).toBe(true);
    const summaries = await client`SELECT id FROM conversation_summaries ORDER BY id`;
    expect(summaries.map((row) => Number(row.id))).toEqual([5, 6, 7, 8]);
    const messages = await client`SELECT id FROM conversation_messages ORDER BY id`;
    expect(messages.map((row) => Number(row.id))).toEqual([1, 2, 3]);
  });

  it("invalidates the active cursor after a source deletion while preserving shared summary history", async () => {
    await client`
      INSERT INTO conversation_messages (bot_id, chat_id, role, content)
      VALUES (${botId}, ${chatId}, 'user', 'group source'),
             (${botId}, ${chatId}, 'assistant', 'later raw message')
    `;
    const id = await addSummary("shared group summary", 1);
    await activate(id);
    expect(await store.deleteMessage(botId, chatId, 1)).toBe(true);
    const summaries = await client`SELECT id FROM conversation_summaries`;
    const states = await client`SELECT active_summary_id FROM conversation_compaction_state`;
    const messages = await client`SELECT id FROM conversation_messages ORDER BY id`;
    expect(summaries.map((row) => Number(row.id))).toEqual([id]);
    expect(states).toHaveLength(0);
    expect(messages.map((row) => Number(row.id))).toEqual([2]);
  });

  it("leaves legacy shared summaries in place when no active cursor exists", async () => {
    await client`
      INSERT INTO conversation_messages (bot_id, chat_id, role, content)
      VALUES (${botId}, ${chatId}, 'user', 'group source')
    `;
    const id = await addSummary("legacy shared summary", 1);
    expect(await store.deleteMessage(botId, chatId, 1)).toBe(true);
    const summaries = await client`SELECT id FROM conversation_summaries`;
    expect(summaries.map((row) => Number(row.id))).toEqual([id]);
  });

  it("clears raw messages, active state, and every summary version for a chat", async () => {
    await client`
      INSERT INTO conversation_messages (bot_id, chat_id, role, content)
      VALUES (${botId}, ${chatId}, 'user', 'private history')
    `;
    await addSummary("old version", 1);
    const activeId = await addSummary("active version", 1);
    await activate(activeId);
    await store.clearHistory(botId, chatId);
    expect(await client`SELECT id FROM conversation_messages`).toHaveLength(0);
    expect(await client`SELECT active_summary_id FROM conversation_compaction_state`).toHaveLength(
      0,
    );
    expect(await client`SELECT id FROM conversation_summaries`).toHaveLength(0);
  });
});
