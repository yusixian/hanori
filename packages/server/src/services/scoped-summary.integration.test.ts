import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Database } from "@cos-tool-bot/database";
import type { AiConfigStored, UsageGovernancePort } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { sql } from "drizzle-orm";
import { encrypt } from "../utils/crypto.js";
const model = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: model.generate,
}));
import { SummaryRunner } from "./summary-runner.js";
const url = process.env.SCHEDULED_TASK_TEST_DATABASE_URL;
const botId = "11111111-1111-4111-8111-111111111111";
const key = "fixture-encryption-key";
const config = {
  model: "chat-default",
  activeProviderId: "provider",
  providers: [
    {
      id: "provider",
      label: "Fixture",
      providerFormat: "openai",
      baseURL: "https://example.invalid/v1",
      defaultModel: "provider-default",
      encryptedApiKey: encrypt("fixture-key", key),
    },
  ],
  summaryConfig: {
    enabled: true,
    modelId: "summary-model",
    defaultMaxMessages: 1000,
    systemPrompt: "Configured summary prompt",
    roleFilter: ["user", "context", "assistant"],
  },
} as unknown as AiConfigStored;
describe.runIf(Boolean(url))("scoped summary real database and model boundary", () => {
  let connection: ReturnType<typeof createDb>;
  beforeAll(() => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    )
      throw Error("Requires local test database");
    connection = createDb(url!);
  });
  afterAll(async () => {
    await connection?.client.end();
  });
  async function fixture(run: (db: Database) => Promise<void>) {
    await connection.db.transaction(async (db) => {
      await db.execute(
        sql`CREATE TEMP TABLE conversation_messages(id serial,bot_id uuid,chat_id bigint,role text,content text,user_authored_content text,user_id bigint,user_name text,meta json,created_at timestamp) ON COMMIT DROP`,
      );
      await db.execute(
        sql`CREATE TEMP TABLE user_privacy_settings(bot_id uuid,user_id bigint,mode text) ON COMMIT DROP`,
      );
      await db.execute(
        sql`CREATE TEMP TABLE chat_summaries(id serial,bot_id uuid,chat_id bigint,trigger text,triggered_by bigint,window_start timestamp,window_end timestamp,message_count int,model_id text,content text,prompt_tokens int,completion_tokens int,duration_ms int,error_message text,created_at timestamp default now()) ON COMMIT DROP`,
      );
      await db.execute(
        sql`CREATE TEMP TABLE token_usage(id serial,bot_id uuid,chat_id bigint,user_id bigint,model text,prompt_tokens int,completion_tokens int,total_tokens int,cache_read_tokens int,cache_write_tokens int,provider_id text,static_prefix_hash text,tool_schema_hash text,cache_fingerprint text,duration_ms int,trigger text,created_at timestamp default now()) ON COMMIT DROP`,
      );
      for (let i = 0; i < 6; i++)
        await db.execute(
          sql`INSERT INTO conversation_messages(bot_id,chat_id,role,content,user_authored_content,user_id,user_name,meta,created_at) VALUES (${botId},-1,'user','wrapped',${i === 5 ? "long ".repeat(26000) + "FINAL_TAIL" : "message " + i},1,'Fixture','{"threadId":7}','2026-01-01 12:00:00')`,
        );
      await run(db as unknown as Database);
    });
  }
  const options = {
    botId,
    chatId: -1,
    threadId: 7,
    mode: { kind: "default" as const },
    trigger: "manual" as const,
    window: {
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
      limit: 6,
    },
    instructions: "List decisions",
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  it("uses the configured summary model and every long-message fragment, then persists coverage-bearing results and usage", async () => {
    model.generate.mockReset().mockImplementation(async (request) => ({
      text: request.messages[1].content.includes("FINAL_TAIL") ? "tail summary" : "summary",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    }));
    await fixture(async (db) => {
      const runner = new SummaryRunner(db, logger, key, async () => config);
      const result = await runner.run(options);
      expect(result).toMatchObject({
        ok: true,
        messageCount: 6,
        coverage: { complete: true, returnedCount: 6, truncated: false },
      });
      expect(model.generate.mock.calls.length).toBeGreaterThan(1);
      expect(
        model.generate.mock.calls.some(([request]) =>
          request.messages[1].content.includes("FINAL_TAIL"),
        ),
      ).toBe(true);
      expect(model.generate.mock.calls.at(-1)![0].messages[1].content).toContain("tail summary");
      expect(model.generate.mock.calls[0]![0].model.modelId).toBe("summary-model");
      expect(model.generate.mock.calls[0]![0].messages[0].content).toContain(
        "Configured summary prompt",
      );
      expect(model.generate.mock.calls[0]![0].messages[0].content).toContain("List decisions");
      expect(model.generate.mock.calls[0]![0].messages[0].content).toContain(
        "不要声称达到数量上限",
      );
      const history = await db.execute(
        sql`SELECT message_count,model_id,error_message FROM chat_summaries`,
      );
      expect(history[0]).toMatchObject({
        message_count: 6,
        model_id: "summary-model",
        error_message: null,
      });
      const usage = await db.execute(sql`SELECT total_tokens FROM token_usage`);
      expect(usage[0]?.total_tokens).toBe(model.generate.mock.calls.length * 5);
      const limited = await runner.run({ ...options, window: { ...options.window, limit: 5 } });
      expect(limited.coverage).toMatchObject({
        returnedCount: 5,
        complete: false,
        truncated: true,
        reason: "message_limit",
      });
      expect(model.generate.mock.calls.at(-1)![0].messages[0].content).toContain(
        "数据库查询已确认达到数量上限",
      );
      const callsBefore = model.generate.mock.calls.length;
      const empty = await runner.run({ ...options, threadId: 99 });
      expect(empty).toMatchObject({
        ok: false,
        error: "too_few_messages",
        coverage: { returnedCount: 0, complete: true, truncated: false },
      });
      expect(model.generate).toHaveBeenCalledTimes(callsBefore);
    });
  });
  it.each(["reserve", "model"])(
    "propagates cancellation at %s and refunds without a successful summary",
    async (stage) => {
      const controller = new AbortController();
      model.generate.mockReset().mockImplementation(async (request) => {
        expect(request.abortSignal).toBe(controller.signal);
        controller.abort(new Error("task cancelled"));
        throw controller.signal.reason;
      });
      await fixture(async (db) => {
        const refund = vi.fn(async () => undefined);
        const governor = {
          reserve: async () => {
            if (stage === "reserve") controller.abort(new Error("task cancelled"));
            return { allowed: true, reservationId: "fixture" };
          },
          refund,
          settle: vi.fn(async () => undefined),
        } as unknown as UsageGovernancePort;
        const result = await new SummaryRunner(db, logger, key, async () => config, governor).run({
          ...options,
          signal: controller.signal,
        });
        expect(result).toMatchObject({
          ok: false,
          error: "llm_failed",
          errorDetail: "task cancelled",
        });
        expect(model.generate).toHaveBeenCalledTimes(stage === "reserve" ? 0 : 1);
        expect(refund).toHaveBeenCalledOnce();
        const history = await db.execute(sql`SELECT content,error_message FROM chat_summaries`);
        expect(history[0]).toMatchObject({ content: "", error_message: "task cancelled" });
      });
    },
  );
});
