import { randomUUID } from "node:crypto";
import { bots, conversationMessages, createDb, userPrivacySettings } from "@cos-tool-bot/database";
import { DEFAULT_BOT_MEMORY_CONFIG, type UsageGovernancePort } from "@cos-tool-bot/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { MemoryConsolidator } from "./memory-consolidator.js";

// This suite also exercises the deployed privacy trigger and requires a migrated local test database.
const databaseUrl = process.env.MEMORY_REVIEW_MIGRATED_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)(
  "reviews only eligible original group statements, accounts once, and respects a later privacy change",
  async () => {
    const url = new URL(databaseUrl!);
    expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
    expect(url.pathname.endsWith("_test")).toBe(true);
    const { db, client } = createDb(databaseUrl!);
    const botId = randomUUID();
    const chatId = -1001;
    const statement = "I climb on Saturdays";
    const createdAt = new Date(Date.now() - 86400000);
    const start = new Date(createdAt.getTime() - 1);
    const end = new Date(createdAt.getTime() + 1);
    const callModel = vi.fn(async (_config: unknown, prompt: string) => {
      const { messages } = JSON.parse(prompt);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ text: statement, userId: 42, personalCandidate: true });
      return {
        text: JSON.stringify([
          {
            action: "add",
            kind: "preference",
            content: statement,
            selfQuote: statement,
            participantIds: [42],
            sourceMessageIds: [messages[0].id],
          },
        ]),
        model: "test-model",
        providerId: "test-provider",
        inputTokens: 50,
        outputTokens: 10,
      };
    });
    const service = new MemoryConsolidator(
      db,
      pino({ enabled: false }),
      "",
      {
        reserve: async () => ({ allowed: true, reservationId: "test" }),
        settle: vi.fn(),
        refund: vi.fn(),
      } as unknown as UsageGovernancePort,
      { refreshEmbeddings: vi.fn() },
      callModel,
    );
    try {
      await client`INSERT INTO bots (id,name,encrypted_token,ai_config) VALUES
      (${botId},'memory review test','unused',${JSON.stringify({ enabled: true, botMemoryConfig: { ...DEFAULT_BOT_MEMORY_CONFIG, enabled: true } })})`;
      await db.insert(userPrivacySettings).values([
        { botId, userId: 43, mode: "off" },
        { botId, userId: 44, mode: "isolated" },
      ]);
      for (const [i, userId] of [42, 43, 44, 45].entries()) {
        const text = userId === 42 ? statement : "Excluded message";
        await db.insert(conversationMessages).values({
          botId,
          chatId,
          userId,
          role: "user",
          content: text,
          userAuthoredContent: text,
          sourceKey: `telegram:${i + 1}:user`,
          createdAt,
          meta: { turnState: "complete", ...(userId === 45 && { forwardOrigin: "forward" }) },
        });
      }
      expect(await service.review(botId, chatId, start, end)).toMatchObject({
        calls: 1,
        changes: 1,
        inputTokens: 50,
        outputTokens: 10,
      });
      expect(await service.review(botId, chatId, start, end)).toMatchObject({
        calls: 0,
        changes: 0,
        nextAfterMessageId: null,
      });
      expect(callModel).toHaveBeenCalledOnce();
      expect(
        await client`select model,total_tokens from token_usage where bot_id=${botId} and trigger='memory_consolidation'`,
      ).toEqual([{ model: "test-model", total_tokens: 60 }]);
      expect(
        await client`select cursor_message_id from memory_consolidation_state where bot_id=${botId}`,
      ).toEqual([{ cursor_message_id: 0 }]);
      expect(
        await client`select content from bot_memories where bot_id=${botId} and telegram_id=42 and scope_chat_id is null and is_active`,
      ).toEqual([{ content: statement }]);
      await db.insert(userPrivacySettings).values({ botId, userId: 42, mode: "isolated" });
      expect(
        await client`select id from bot_memories where bot_id=${botId} and is_active`,
      ).toHaveLength(0);
    } finally {
      await service.close();
      try {
        await db.delete(bots).where(eq(bots.id, botId));
      } finally {
        await client.end();
      }
    }
  },
);
