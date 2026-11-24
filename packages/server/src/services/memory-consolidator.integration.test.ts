import { randomUUID } from "node:crypto";
import { createDb } from "@cos-tool-bot/database";
import type { UsageGovernancePort } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryConsolidator } from "./memory-consolidator.js";

const url = process.env.MEMORY_REVIEW_TEST_DATABASE_URL;
const day = 86400000;

describe.skipIf(!url)("memory review with PostgreSQL", () => {
  const namespace = "memory_review_" + randomUUID().replaceAll("-", "");
  let connection: ReturnType<typeof createDb>;
  let client: ReturnType<typeof createDb>["client"];
  let bot: string;
  const start = new Date(Date.now() - 10 * day);
  const end = new Date();
  const logger = { error: vi.fn(), info: vi.fn() } as unknown as Logger;
  const usage = {
    reserve: vi.fn(async () => ({ allowed: true, reservationId: "r" })),
    settle: vi.fn(),
    refund: vi.fn(),
  };
  type Prompt = {
    messages: { id: number; userId: number; text: string; personalCandidate: boolean }[];
    existing: { id: number }[];
  };
  const model = vi.fn(async (_config: unknown, prompt: string) => {
    const { messages } = JSON.parse(prompt) as Prompt;
    const [source] = messages;
    const proposals = source?.personalCandidate
      ? [
          {
            action: "add",
            kind: "preference",
            content: source.text,
            selfQuote: source.text,
            sourceMessageIds: [source.id],
            participantIds: [source.userId],
          },
        ]
      : [];
    return {
      text: JSON.stringify(proposals),
      providerId: "test-provider",
      model: "test-model",
      inputTokens: 5,
      outputTokens: 2,
    };
  });
  let service: MemoryConsolidator;

  beforeAll(async () => {
    const databaseUrl = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
      !databaseUrl.pathname.endsWith("_test")
    )
      throw new Error("Memory review tests require a local *_test database");
    databaseUrl.searchParams.set("search_path", namespace);
    connection = createDb(databaseUrl.toString());
    client = connection.client;
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    // This fixture exercises PostgreSQL locks, JSON settings and array overlap without requiring pgvector.
    await client.unsafe(`
      CREATE TABLE bots(id uuid PRIMARY KEY,platform text DEFAULT 'telegram',is_active boolean DEFAULT true,ai_config json);
      CREATE TABLE conversation_messages(id serial PRIMARY KEY,bot_id uuid,chat_id bigint,user_id bigint,
        role text DEFAULT 'user',user_authored_content text,source_key text,created_at timestamp,meta json DEFAULT '{"turnState":"complete"}');
      CREATE TABLE user_privacy_settings(bot_id uuid,user_id bigint,mode text,created_at timestamp,updated_at timestamp);
      CREATE TABLE memory_consolidation_state(bot_id uuid PRIMARY KEY,cursor_message_id int DEFAULT 0,
        lease_owner uuid,lease_until timestamp,updated_at timestamp DEFAULT now(),last_scheduled_at timestamp,
        group_impressions_since timestamp DEFAULT now(),last_run jsonb);
      CREATE TABLE memory_consolidation_evidence(id serial PRIMARY KEY,bot_id uuid,chat_id bigint,action text,memory_id int,
        review_version int DEFAULT 1,source_message_ids int[],participant_ids bigint[],created_at timestamp DEFAULT now());
      CREATE TABLE bot_memories(id serial PRIMARY KEY,bot_id uuid,telegram_id bigint,scope_chat_id bigint,content text,
        category text,kind text,origin text,source_chat_id bigint,source_message_id bigint,source_user_id bigint,
        expires_at timestamp,fact_valid_at timestamp,superseded_by_id int,embedding text,is_active boolean DEFAULT true,
        created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
      CREATE TABLE token_usage(id serial PRIMARY KEY,bot_id uuid,chat_id bigint,user_id bigint,model text,prompt_tokens int,
        completion_tokens int,total_tokens int,cache_read_tokens int,cache_write_tokens int,provider_id text,static_prefix_hash text,
        tool_schema_hash text,cache_fingerprint text,duration_ms int,trigger text,created_at timestamp DEFAULT now());
    `);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await client.unsafe(
      "TRUNCATE bots, conversation_messages, user_privacy_settings, memory_consolidation_state, memory_consolidation_evidence, bot_memories, token_usage",
    );
    bot = randomUUID();
    await client`INSERT INTO bots (id,ai_config) VALUES (${bot},'{"enabled":true,"botMemoryConfig":{"enabled":true,"consolidation":{"maxCallsPerRun":1}}}')`;
    service = new MemoryConsolidator(
      connection.db,
      logger,
      "test",
      usage as unknown as UsageGovernancePort,
      { refreshEmbeddings: vi.fn() },
      model,
    );
  });
  afterAll(async () => {
    if (!client) return;
    await client.unsafe(`DROP SCHEMA "${namespace}" CASCADE`);
    await client.end();
  });
  async function source(user: number, text: string, chat = -10, daysAgo = 2) {
    const when = new Date(Date.now() - daysAgo * day).toISOString();
    const [row] =
      await client`INSERT INTO conversation_messages(bot_id,chat_id,user_id,user_authored_content,source_key,created_at)
      VALUES(${bot},${chat},${user},${text},'telegram:42:user',${when}) RETURNING id`;
    return Number(row!.id);
  }

  it("revisits legacy group evidence, filters authors, records usage and keeps the scheduled cursor independent", async () => {
    const id = await source(41, "I climb every weekend");
    await source(42, "private text");
    await source(43, "isolated text");
    await source(44, "other group", -11);
    await client`INSERT INTO user_privacy_settings(bot_id,user_id,mode) VALUES(${bot},42,'off'),(${bot},43,'isolated')`;
    await client`INSERT INTO memory_consolidation_state(bot_id,cursor_message_id) VALUES(${bot},500)`;
    await client`INSERT INTO memory_consolidation_evidence(bot_id,chat_id,action,source_message_ids,participant_ids)
      VALUES (${bot},-10,'ignore',ARRAY[${id}::integer],ARRAY[41])`;
    const result = await service.review(bot, -10, start, end);
    expect(result).toEqual({
      calls: 1,
      changes: 1,
      inputTokens: 5,
      outputTokens: 2,
      nextAfterMessageId: null,
    });
    expect(JSON.parse(model.mock.calls[0]![1]).messages).toEqual([
      expect.objectContaining({ id, userId: 41, personalOnly: true }),
    ]);
    const [memory] = await client`SELECT * FROM bot_memories`;
    expect(memory).toMatchObject({
      content: "I climb every weekend",
      scope_chat_id: null,
      origin: "consolidation",
      expires_at: null,
    });
    expect(Number(memory!.telegram_id)).toBe(41);
    const [record] = await client`SELECT * FROM token_usage`;
    expect(record).toMatchObject({
      trigger: "memory_consolidation",
      provider_id: "test-provider",
      total_tokens: 7,
    });
    expect(await service.review(bot, -10, start, end)).toMatchObject({ calls: 0, changes: 0 });
    expect(model).toHaveBeenCalledTimes(1);
    const [state] = await client`SELECT * FROM memory_consolidation_state`;
    expect(state!.cursor_message_id).toBe(500);
    expect(state!.last_scheduled_at).toBeNull();
  });

  it("uses a durable 12-hour schedule, skips historical group impressions until manual review, and honors the call budget", async () => {
    for (let i = 0; i < 13; i++) await source(41, "I like climbing");
    await service.tick();
    expect(logger.error).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledTimes(1);
    expect(JSON.parse(model.mock.calls[0]![1]).messages).toHaveLength(12);
    expect(JSON.parse(model.mock.calls[0]![1]).messages[0].personalCandidate).toBe(false);
    await service.tick();
    expect(model).toHaveBeenCalledTimes(1);
    const result = await service.review(bot, -10, start, end);
    expect(result).toMatchObject({ calls: 1, changes: 1 });
    expect(result.nextAfterMessageId).not.toBeNull();
    const next = await service.review(bot, -10, start, end, result.nextAfterMessageId!);
    expect(next).toMatchObject({ calls: 1, changes: 0, nextAfterMessageId: null });
    expect(await client`SELECT id FROM bot_memories`).toHaveLength(1);
  });

  it("resists stale backfill and retires the same impression when its owner corrects it", async () => {
    await source(41, "I climb on Sundays", -10, 6);
    await service.review(bot, -10, start, end);
    // A later confirmation supersedes contradictions between the two statements.
    await source(41, "I climb on Sundays", -10, 2);
    await service.review(bot, -10, start, end);
    const [memory] = await client`SELECT id FROM bot_memories`;
    const forget = (prompt: string) => {
      const {
        messages: [message],
      } = JSON.parse(prompt) as Prompt;
      return {
        text: JSON.stringify([
          {
            action: "retire",
            kind: "preference",
            targetId: memory!.id,
            selfQuote: message!.text,
            sourceMessageIds: [message!.id],
            participantIds: [41],
          },
        ]),
        providerId: "budget",
        model: "budget",
        inputTokens: 5,
        outputTokens: 2,
      };
    };
    await source(41, "I stopped climbing", -10, 4);
    model.mockImplementationOnce(async (_, prompt) => forget(prompt));
    expect(await service.review(bot, -10, start, end)).toMatchObject({ changes: 0, calls: 1 });
    expect((await client`SELECT is_active FROM bot_memories`)[0]!.is_active).toBe(true);
    await source(41, "I stopped climbing yesterday", -10, 1);
    model.mockImplementationOnce(async (_, prompt) => forget(prompt));
    expect(await service.review(bot, -10, start, end)).toMatchObject({ changes: 1, calls: 1 });
    expect((await client`SELECT is_active FROM bot_memories`)[0]!.is_active).toBe(false);
  });

  it("bounds manual-review expiry by the date of the original statement", async () => {
    await client`UPDATE bots SET ai_config='{"enabled":true,"botMemoryConfig":{"enabled":true,"consolidation":{"retentionDays":3}}}' WHERE id=${bot}`;
    await source(41, "I like climbing", -10, 4);
    expect(await service.review(bot, -10, start, end)).toMatchObject({ changes: 0, calls: 1 });
    await source(41, "I like swimming", -10, 1);
    expect(await service.review(bot, -10, start, end)).toMatchObject({ changes: 1, calls: 1 });
    const [row] =
      await client`SELECT expires_at-fact_valid_at=interval '3 days' AS bounded FROM bot_memories`;
    expect(row!.bounded).toBe(true);
  });

  it("rechecks privacy after inference and charges the completed model response", async () => {
    await source(41, "I climb every weekend");
    model.mockImplementationOnce(async (_, prompt) => {
      await client`INSERT INTO user_privacy_settings(bot_id,user_id,mode) VALUES(${bot},41,'off')`;
      const {
        messages: [message],
      } = JSON.parse(prompt) as Prompt;
      return {
        text: JSON.stringify([
          {
            action: "add",
            kind: "fact",
            content: message!.text,
            selfQuote: message!.text,
            sourceMessageIds: [message!.id],
            participantIds: [41],
          },
        ]),
        providerId: "test",
        model: "test",
        inputTokens: 5,
        outputTokens: 2,
      };
    });
    await expect(service.review(bot, -10, start, end)).rejects.toThrow("privacy changed");
    expect(await client`SELECT * FROM bot_memories`).toHaveLength(0);
    expect(await client`SELECT * FROM token_usage`).toHaveLength(1);
  });
});
