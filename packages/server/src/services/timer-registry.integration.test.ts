import { randomUUID } from "node:crypto";
import { createDb, type Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerRegistry } from "./timer-registry.js";

const url = process.env.TIMER_REGISTRY_TEST_DATABASE_URL;

// Explicit local test database only; never fall back to the application's DATABASE_URL.
describe.skipIf(!url)("timer registry PostgreSQL lifecycle", () => {
  const namespace = `timer_registry_test_${randomUUID().replaceAll("-", "")}`;
  const botId = randomUUID();
  let client: ReturnType<typeof createDb>["client"];
  let db: Database;
  const registries: TimerRegistry[] = [];
  const releases: Array<() => void> = [];

  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    releases.push(resolve);
    return { promise, resolve };
  }
  function registry() {
    const value = new TimerRegistry(db, { info: vi.fn(), error: vi.fn() } as unknown as Logger);
    registries.push(value);
    return value;
  }
  async function state() {
    const [row] = await client`SELECT status, fired_at FROM timers WHERE id = 'test-reminder'`;
    return row;
  }

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Timer integration tests require a local *_test database");
    }
    parsed.searchParams.set("search_path", namespace);
    const connection = createDb(parsed.toString());
    client = connection.client;
    db = connection.db;
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    await client.unsafe(`CREATE TABLE timers (
      id text PRIMARY KEY, bot_id uuid, type text NOT NULL, name text NOT NULL,
      chat_id bigint, status text NOT NULL DEFAULT 'active', interval_ms integer,
      fires_at timestamp, created_at timestamp NOT NULL DEFAULT now(),
      fired_at timestamp, meta json
    )`);
  });
  beforeEach(async () => {
    await client`TRUNCATE timers`;
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await Promise.all(registries.splice(0).map((value) => value.close()));
  });
  afterAll(async () => {
    if (!client) return;
    try {
      await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await client.end();
    }
  });

  it.each([false, true])(
    "persists the delivery result before close resolves (failure: %s)",
    async (fails) => {
      const current = registry();
      const entered = gate();
      const delivery = gate();
      await current.registerAi({
        timerId: "test-reminder",
        botId,
        chatId: 42,
        name: "test",
        seconds: 0,
        onFire: async () => {
          entered.resolve();
          await delivery.promise;
          if (fails) throw new Error("synthetic delivery failure");
        },
      });
      await entered.promise;
      const closed = vi.fn();
      const closing = current.close();
      void closing.then(closed);
      expect((await state())?.status).toBe("processing");
      expect(closed).not.toHaveBeenCalled();
      delivery.resolve();
      await closing;
      const row = await state();
      expect(row?.status).toBe(fails ? "active" : "fired");
      expect(row?.fired_at === null).toBe(fails);
      const restarted = registry();
      const fired = gate();
      const onFire = vi.fn(async () => {
        fired.resolve();
      });
      const result = await restarted.resumeBot(botId, onFire);
      expect(result.immediate).toBe(fails ? 1 : 0);
      if (fails) await fired.promise;
      await restarted.close();
      expect(onFire).toHaveBeenCalledTimes(fails ? 1 : 0);
      expect((await state())?.status).toBe("fired");
    },
  );

  it("grants one overdue delivery across two concurrent registries", async () => {
    await client`INSERT INTO timers (id, bot_id, type, name, chat_id, fires_at)
      VALUES ('test-reminder', ${botId}, 'ai', 'test', 42, now() - interval '1 second')`;
    const first = registry();
    const second = registry();
    const entered = gate();
    const delivery = gate();
    const onFire = vi.fn(async () => {
      entered.resolve();
      await delivery.promise;
    });
    const results = await Promise.all([
      first.resumeBot(botId, onFire),
      second.resumeBot(botId, onFire),
    ]);
    expect(results.reduce((sum, result) => sum + result.immediate, 0)).toBe(1);
    await entered.promise;
    expect(onFire).toHaveBeenCalledOnce();
    const closing = Promise.all([first.close(), second.close()]);
    delivery.resolve();
    await closing;
    expect((await state())?.status).toBe("fired");
    expect(onFire).toHaveBeenCalledOnce();
  });
});
