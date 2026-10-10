import { randomUUID } from "node:crypto";
import { createDb, type Database } from "@cos-tool-bot/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BotRunService } from "./bot-run-service.js";

const url = process.env.BOT_RUN_TEST_DATABASE_URL;

describe.skipIf(!url)("Bot Run cancellation PostgreSQL integration", () => {
  let client: ReturnType<typeof createDb>["client"];
  let db: Database;
  let service: BotRunService;
  const namespace = `bot_run_test_${randomUUID().replaceAll("-", "")}`;
  const botId = randomUUID();
  const runId = randomUUID();

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Bot Run integration requires a local *_test database");
    }
    parsed.searchParams.set("search_path", namespace);
    ({ client, db } = createDb(parsed.toString()));
    await client.unsafe(`CREATE SCHEMA "${namespace}"`);
    await client.unsafe(`
      CREATE TABLE bot_runs (
        id uuid PRIMARY KEY, bot_id uuid NOT NULL, source text NOT NULL,
        channel text NOT NULL, mode text NOT NULL DEFAULT 'dry-run',
        status text NOT NULL DEFAULT 'running', failure_reason text,
        input json NOT NULL, config_snapshot json, duration_ms integer,
        pinned boolean NOT NULL DEFAULT false, created_at timestamp NOT NULL DEFAULT now(),
        completed_at timestamp
      );
      CREATE TABLE bot_run_events (
        id serial PRIMARY KEY, run_id uuid NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
        sequence integer NOT NULL, kind text NOT NULL, level text NOT NULL DEFAULT 'info',
        data json NOT NULL, created_at timestamp NOT NULL DEFAULT now()
      );
    `);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await client.end();
    }
  });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await client.unsafe("TRUNCATE bot_runs CASCADE");
    service = new BotRunService(db, "synthetic-key");
    await service.list(botId);
    await client`INSERT INTO bot_runs (id, bot_id, source, channel, input)
      VALUES (${runId}, ${botId}, 'debugger', 'telegram', '{}')`;
  });

  it.each(["succeeded", "failed"])(
    "preserves a %s result completed after the cancellation read",
    async (status) => {
      const getStatus = service.getStatus.bind(service);
      vi.spyOn(service, "getStatus").mockImplementationOnce(async (...args) => {
        const snapshot = await getStatus(...args);
        await client`UPDATE bot_runs SET status = ${status}, failure_reason = ${status === "failed" ? "timed_out" : null},
        completed_at = '2026-10-10 00:00:00', duration_ms = 42 WHERE id = ${runId}`;
        return snapshot;
      });
      const cancelled = await service.cancel(botId, runId);
      const [row] =
        await client`SELECT status, failure_reason, duration_ms, completed_at::text AS completed_at FROM bot_runs WHERE id = ${runId}`;
      expect(row).toEqual({
        status,
        failure_reason: status === "failed" ? "timed_out" : null,
        duration_ms: 42,
        completed_at: "2026-10-10 00:00:00",
      });
      expect(cancelled).toBe(false);
    },
  );

  it("reports a row deleted after the cancellation read as no longer running", async () => {
    const getStatus = service.getStatus.bind(service);
    vi.spyOn(service, "getStatus").mockImplementationOnce(async (...args) => {
      const snapshot = await getStatus(...args);
      await client`DELETE FROM bot_runs WHERE id = ${runId}`;
      return snapshot;
    });
    await expect(service.cancel(botId, runId)).resolves.toBe(false);
  });

  it("cancels an unowned running row but rejects a different bot", async () => {
    await expect(service.cancel(randomUUID(), runId)).resolves.toBe(false);
    await expect(service.getStatus(botId, runId)).resolves.toBe("running");
    await expect(service.cancel(botId, runId)).resolves.toBe(true);
    expect(await service.get(botId, runId)).toMatchObject({
      status: "failed",
      failureReason: "cancelled",
      completedAt: expect.any(Date),
    });
    await expect(service.cancel(botId, runId)).resolves.toBe(false);
  });
});
