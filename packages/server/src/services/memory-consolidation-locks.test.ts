import { createDb, type Database } from "@cos-tool-bot/database";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { lockConsolidationInputs } from "./memory-consolidator.js";

const databaseUrl = process.env.MEMORY_CONSOLIDATION_TEST_DATABASE_URL;
const botId = "00000000-0000-0000-0000-000000000001";

it.skipIf(!databaseUrl)(
  "lets privacy forget delete a source while consolidation waits for its privacy row",
  async () => {
    const url = new URL(databaseUrl!);
    expect(["localhost", "127.0.0.1", "::1"]).toContain(url.hostname);
    expect(url.pathname).toBe("/memory_consolidation_test");

    const { client, db } = createDb(databaseUrl!);
    const [existing] = await client.unsafe(
      "SELECT to_regnamespace('consolidation_lock_test') IS NOT NULL AS exists",
    );
    expect(existing?.exists).toBe(false);
    let schemaCreated = false;
    let releaseForget!: () => void;
    let signalPrivacyLocked!: () => void;
    let signalConsolidatorPid!: (pid: number) => void;
    const forgetMayDelete = new Promise<void>((resolve) => (releaseForget = resolve));
    const privacyLocked = new Promise<void>((resolve) => (signalPrivacyLocked = resolve));
    const consolidatorPid = new Promise<number>((resolve) => (signalConsolidatorPid = resolve));
    let forget: Promise<unknown> | undefined;
    let consolidate: Promise<Awaited<ReturnType<typeof lockConsolidationInputs>>> | undefined;
    let consolidationError: unknown;

    try {
      await client.unsafe("CREATE SCHEMA consolidation_lock_test");
      schemaCreated = true;
      await client.unsafe(`
        CREATE TABLE consolidation_lock_test.user_privacy_settings (
          bot_id uuid NOT NULL, user_id bigint NOT NULL, mode text NOT NULL,
          created_at timestamp NOT NULL DEFAULT now(),
          updated_at timestamp NOT NULL DEFAULT now(),
          PRIMARY KEY (bot_id, user_id)
        )
      `);
      await client.unsafe(`
        CREATE TABLE consolidation_lock_test.conversation_messages (
          id integer PRIMARY KEY, bot_id uuid NOT NULL, chat_id bigint NOT NULL,
          role text NOT NULL, user_id bigint, user_authored_content text,
          source_key text, meta json, created_at timestamp NOT NULL
        )
      `);
      await client.unsafe(`
        INSERT INTO consolidation_lock_test.user_privacy_settings
          (bot_id, user_id, mode) VALUES ('${botId}', 41, 'normal')
      `);
      await client.unsafe(`
        INSERT INTO consolidation_lock_test.conversation_messages
          (id, bot_id, chat_id, role, user_id, user_authored_content, created_at)
          VALUES (101, '${botId}', 41, 'user', 41, 'hello', now())
      `);

      forget = client.begin(async (tx) => {
        await tx.unsafe("SET LOCAL search_path TO consolidation_lock_test, public");
        await tx.unsafe("SET LOCAL statement_timeout = '3000ms'");
        await tx.unsafe("UPDATE user_privacy_settings SET mode = 'off' WHERE user_id = 41");
        signalPrivacyLocked();
        await forgetMayDelete;
        await tx.unsafe("DELETE FROM conversation_messages WHERE id = 101");
      });
      await privacyLocked;

      consolidate = db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL search_path TO consolidation_lock_test, public"));
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '3000ms'"));
        const [backend] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        signalConsolidatorPid(Number(backend?.pid));
        return lockConsolidationInputs(tx as unknown as Database, botId, [41], [101]);
      });
      void consolidate.catch((error: unknown) => {
        consolidationError = error;
      });
      const pid = await consolidatorPid;
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [activity] = await client.unsafe(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        if (activity?.wait_event_type === "Lock") {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting, `backend ${pid}: ${String(consolidationError)}`).toBe(true);

      // With the old source-first order, this delete waited on consolidation's
      // source lock while consolidation waited on forget's privacy row.
      releaseForget();
      const [, locked] = await Promise.all([forget, consolidate]);
      expect(locked.current).toHaveLength(0);
      expect(locked.privacy[0]?.mode).toBe("off");
    } finally {
      releaseForget();
      await Promise.allSettled([forget, consolidate]);
      if (schemaCreated) {
        await client.unsafe("DROP TABLE IF EXISTS consolidation_lock_test.conversation_messages");
        await client.unsafe("DROP TABLE IF EXISTS consolidation_lock_test.user_privacy_settings");
        await client.unsafe("DROP SCHEMA consolidation_lock_test");
      }
      await client.end();
    }
  },
  10_000,
);
