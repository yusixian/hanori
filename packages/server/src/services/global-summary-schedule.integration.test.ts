import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDb, type Database } from "@cos-tool-bot/database";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSummaryService, type BotSummaryCfg } from "./chat-summary-service.js";
import type { SummaryRunner } from "./summary-runner.js";

const url = process.env.GLOBAL_SUMMARY_TEST_DATABASE_URL;

describe.skipIf(!url)("global summary scheduling PostgreSQL integration", () => {
  let client: ReturnType<typeof createDb>["client"];
  let db: Database;
  const namespace = `global_summary_test_${randomUUID().replaceAll("-", "")}`;
  const botId = randomUUID();
  const otherBot = randomUUID();
  const now = new Date("2026-10-10T14:00:00Z");
  let scheduled: (() => Promise<void>)[];
  let services: ChatSummaryService[];

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Global summary tests require an explicit local *_test database");
    }
    parsed.searchParams.set("search_path", namespace);
    ({ client, db } = createDb(parsed.toString()));
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    await client.unsafe(`
      CREATE TABLE bots (id uuid PRIMARY KEY, platform text DEFAULT 'telegram', is_active boolean DEFAULT true);
      CREATE TABLE telegram_chats (bot_id uuid, chat_id bigint, type text, left_at timestamp, migrated_to_chat_id bigint);
      CREATE TABLE conversation_messages (id serial PRIMARY KEY, bot_id uuid, chat_id bigint, role text, created_at timestamp);
      CREATE TABLE chat_summaries (bot_id uuid, chat_id bigint, trigger text, created_at timestamp);
      CREATE TABLE summary_configs (
        id serial PRIMARY KEY, bot_id uuid, chat_id bigint, is_active boolean DEFAULT true,
        schedule_hour integer, schedule_minute integer, timezone text, window_hours integer DEFAULT 24,
        custom_prompt text, provider_id text, model_id text, max_messages integer, cooldown_seconds integer,
        access_mode text DEFAULT 'all', last_scheduled_at timestamp, last_manual_at timestamp,
        created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), UNIQUE(bot_id, chat_id)
      );
    `);
    // Apply the generated migration, changing only the FK schema to this isolated namespace.
    const migration = await readFile(
      new URL("../../../database/drizzle/0069_hard_harpoon.sql", import.meta.url),
      "utf8",
    );
    await client.unsafe(migration.replaceAll('"public".', `"${namespace}".`));
  });

  afterAll(async () => {
    if (!client) return;
    await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await client.unsafe(
      "TRUNCATE bots, telegram_chats, conversation_messages, chat_summaries, summary_configs, global_summary_schedule_claims CASCADE",
    );
    await client`INSERT INTO bots (id) VALUES (${botId}), (${otherBot})`;
    scheduled = [];
    services = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => Promise<void>) => {
      scheduled.push(callback);
      return { unref() {} } as NodeJS.Timeout;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  });
  afterEach(async () => {
    await Promise.all(services.map((service) => service.close()));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function addChat(
    chatId: number,
    options: { bot?: string; type?: string; count?: number; role?: string; at?: Date } = {},
  ) {
    const owner = options.bot ?? botId;
    await client`INSERT INTO telegram_chats (bot_id, chat_id, type) VALUES (${owner}, ${chatId}, ${options.type ?? "supergroup"})`;
    await client`INSERT INTO conversation_messages (bot_id, chat_id, role, created_at)
      SELECT ${owner}, ${chatId}, ${options.role ?? "user"}, ${(options.at ?? now).toISOString()}::timestamp
      FROM generate_series(1, ${options.count ?? 5})`;
  }

  function fixture(
    config: BotSummaryCfg = { enabled: true, globalScheduleHour: 22, globalScheduleMinute: 0 },
  ) {
    const run = vi.fn().mockResolvedValue({ ok: true, contentHtml: "summary" });
    const send = vi.fn().mockResolvedValue(undefined);
    const getConfig = vi.fn().mockResolvedValue(config);
    const running = vi.fn().mockReturnValue(true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ChatSummaryService(
      db,
      logger as unknown as Logger,
      { run } as unknown as SummaryRunner,
      send,
      running,
      getConfig,
    );
    services.push(service);
    service.start();
    const tick = scheduled.at(-1)!;
    return { service, tick, run, send, getConfig, running, logger };
  }

  it("selects active known groups with five eligible recent messages and preserves explicit overrides", async () => {
    await addChat(-1001);
    await addChat(-1002, { type: "group" });
    await addChat(42, { type: "private" });
    await addChat(-1003, { type: "channel" });
    await addChat(-1004, { count: 4 });
    await addChat(-1005, { role: "tool_result" });
    await addChat(-1006, { at: new Date("2026-10-09T13:59:59Z") });
    await addChat(-1007);
    await addChat(-1008);
    await addChat(-1009);
    await addChat(-1010);
    await addChat(-1011);
    await client`INSERT INTO summary_configs (bot_id, chat_id, is_active) VALUES (${botId}, -1007, false), (${botId}, -1008, true)`;
    await client`UPDATE telegram_chats SET left_at = ${now.toISOString()} WHERE chat_id = -1009`;
    await client`UPDATE telegram_chats SET migrated_to_chat_id = -2000 WHERE chat_id = -1010`;
    await client`DELETE FROM telegram_chats WHERE chat_id = -1011`;
    const f = fixture();
    await f.tick();
    expect(f.logger.error).not.toHaveBeenCalled();
    expect(f.run.mock.calls.map(([args]) => args.chatId).sort()).toEqual([-1001, -1002].sort());
    expect(f.run).toHaveBeenCalledWith({
      botId,
      chatId: -1001,
      mode: { kind: "default" },
      trigger: "scheduled",
    });
    expect(f.send).toHaveBeenCalledTimes(2);
    const overrides = await client`SELECT chat_id FROM summary_configs`;
    expect(overrides).toHaveLength(2);
  });

  it.each([
    { enabled: false, globalScheduleHour: 22, globalScheduleMinute: 0 },
    { enabled: true, globalScheduleHour: 22 },
    { enabled: true, globalScheduleMinute: 0 },
    { enabled: true, globalScheduleHour: 21, globalScheduleMinute: 0 },
    { enabled: true, globalScheduleHour: 22, globalScheduleMinute: 0, roleFilter: [] },
  ])(
    "does not claim for disabled, incomplete, off-time or empty-role configuration %j",
    async (cfg) => {
      await addChat(-1001);
      const f = fixture(cfg);
      await f.tick();
      expect(f.run).not.toHaveBeenCalled();
      expect(await client`SELECT * FROM global_summary_schedule_claims`).toHaveLength(0);
    },
  );

  it("uses the configured timezone and role filter, independently for each bot", async () => {
    await addChat(-1001, { role: "assistant" });
    await addChat(-1002, { role: "user" });
    await addChat(-1002, { bot: otherBot, role: "assistant" });
    const f = fixture({
      enabled: true,
      timezone: "UTC",
      globalScheduleHour: 14,
      globalScheduleMinute: 0,
      roleFilter: ["assistant"],
    });
    await f.tick();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledWith(botId, -1001, "summary");
    expect(f.send).toHaveBeenCalledWith(otherBot, -1002, "summary");
  });

  it("atomically claims once across concurrent services and retains claims after restart", async () => {
    await addChat(-1001);
    const a = fixture();
    const b = fixture();
    await Promise.all([a.tick(), b.tick()]);
    expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(1);
    await Promise.all([a.service.close(), b.service.close()]);
    const restarted = fixture();
    await restarted.tick();
    expect(restarted.run).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(now.getTime() + 24 * 3600_000));
    await restarted.tick();
    expect(restarted.run).toHaveBeenCalledOnce();
  });

  it.each(["override", "history"])(
    "rechecks %s before renewing an expired global claim",
    async (kind) => {
      await addChat(-1001);
      const f = fixture();
      await f.tick();
      expect(f.run).toHaveBeenCalledOnce();
      const tomorrow = new Date(now.getTime() + 24 * 3600_000);
      vi.setSystemTime(tomorrow);
      if (kind === "override") {
        await client`INSERT INTO summary_configs (bot_id, chat_id, is_active) VALUES (${botId}, -1001, false)`;
      } else {
        await client`INSERT INTO chat_summaries (bot_id, chat_id, trigger, created_at) VALUES (${botId}, -1001, 'scheduled', ${tomorrow.toISOString()})`;
      }
      await f.tick();
      expect(f.run).toHaveBeenCalledOnce();
      const [claim] =
        await client`SELECT last_scheduled_at = ${now.toISOString()}::timestamp AS unchanged FROM global_summary_schedule_claims`;
      expect(claim!.unchanged).toBe(true);
    },
  );

  it.each([false, true])(
    "rechecks a newly committed override at the claim boundary (renewal: %s)",
    async (renewal) => {
      await addChat(-1001);
      const f = fixture();
      if (renewal) {
        await f.tick();
        vi.setSystemTime(new Date(now.getTime() + 24 * 3600_000));
        f.run.mockClear();
      }
      f.running.mockImplementation((id: string) => id === botId);
      const execute = db.execute.bind(db);
      // Keep real SQL and insert the concurrent edit only after candidates were fetched.
      const intercepted = async (query: Parameters<Database["execute"]>[0]) => {
        const rows = await execute(query);
        const text =
          typeof query === "string" ? query : new PgDialect().sqlToQuery(query.getSQL()).sql;
        if (text.includes('AS "chatId"')) {
          expect(rows).toHaveLength(1);
          await client`INSERT INTO summary_configs (bot_id, chat_id, is_active) VALUES (${botId}, -1001, false)`;
        }
        return rows;
      };
      // This seam is awaited directly by the service; the fake needs only Promise behavior.
      vi.spyOn(db, "execute").mockImplementation(intercepted as unknown as Database["execute"]);
      await f.tick();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.logger.error).not.toHaveBeenCalled();
      const claims =
        await client`SELECT last_scheduled_at = ${now.toISOString()}::timestamp AS unchanged FROM global_summary_schedule_claims`;
      expect(claims).toHaveLength(renewal ? 1 : 0);
      if (renewal) expect(claims[0]!.unchanged).toBe(true);
    },
  );

  it("does not claim after close while reading global configuration", async () => {
    await addChat(-1001);
    const f = fixture();
    let release!: (cfg: BotSummaryCfg) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.getConfig.mockImplementationOnce(() => {
      started();
      return new Promise<BotSummaryCfg>((resolve) => {
        release = resolve;
      });
    });
    const tick = f.tick();
    await began;
    const close = f.service.close();
    release({ enabled: true, globalScheduleHour: 22, globalScheduleMinute: 0 });
    await Promise.all([tick, close]);
    expect(f.run).not.toHaveBeenCalled();
    expect(await client`SELECT * FROM global_summary_schedule_claims`).toHaveLength(0);
  });

  it("honors recent scheduled history even when its explicit configuration was removed", async () => {
    await addChat(-1001);
    await addChat(-1002);
    await client`INSERT INTO chat_summaries (bot_id, chat_id, trigger, created_at)
      VALUES (${botId}, -1001, 'scheduled', ${now.toISOString()}), (${botId}, -1002, 'manual', ${now.toISOString()})`;
    const f = fixture();
    await f.tick();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(botId, -1002, "summary");
  });

  it("isolates failed chats and keeps their claims without automatically retrying", async () => {
    await addChat(-1001);
    await addChat(-1002);
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error("model failed"));
    await f.tick();
    await f.tick();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.logger.error).toHaveBeenCalledOnce();
    expect(await client`SELECT * FROM global_summary_schedule_claims`).toHaveLength(2);
  });

  it("retains the tick time when an explicit summary runs past the scheduled minute", async () => {
    await addChat(-1001);
    await client`INSERT INTO summary_configs (bot_id, chat_id, schedule_hour, schedule_minute) VALUES (${botId}, -9999, 22, 0)`;
    const f = fixture();
    f.run.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 120_000));
      return { ok: true, contentHtml: "explicit" };
    });
    await f.tick();
    expect(f.send).toHaveBeenCalledWith(botId, -1001, "summary");
    expect(f.send).toHaveBeenCalledWith(botId, -9999, "explicit");
  });

  it("stops accepting chats when the bot stops while completing an admitted send", async () => {
    await addChat(-1001);
    await addChat(-1002);
    const f = fixture();
    f.run.mockImplementationOnce(async () => {
      f.running.mockReturnValue(false);
      return { ok: true, contentHtml: "already admitted" };
    });
    await f.tick();
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("drains an admitted global summary on close without claiming later chats", async () => {
    await addChat(-1001);
    await addChat(-1002);
    const f = fixture();
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.run.mockImplementationOnce(async () => {
      started();
      await gate;
      return { ok: true, contentHtml: "summary" };
    });
    const tick = f.tick();
    await began;
    let closed = false;
    const close = f.service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([tick, close]);
    expect(f.send).toHaveBeenCalledOnce();
    expect(await client`SELECT * FROM global_summary_schedule_claims`).toHaveLength(1);
  });
});
