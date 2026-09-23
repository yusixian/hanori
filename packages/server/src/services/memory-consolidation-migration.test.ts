import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb } from "@cos-tool-bot/database";
import { expect, it } from "vitest";

const databaseUrl = process.env.MEMORY_CONSOLIDATION_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)(
  "preserves memories across raw retention and cleans evidence on privacy forget",
  async () => {
    // This test creates only temporary tables in a transaction and rolls them back.
    const url = new URL(databaseUrl!);
    expect(["localhost", "127.0.0.1", "::1"]).toContain(url.hostname);
    expect(url.pathname).toBe("/memory_consolidation_test");

    const migration = await readFile(
      resolve(import.meta.dirname, "../../../database/drizzle/0053_classy_mattie_franklin.sql"),
      "utf8",
    );
    const { client } = createDb(databaseUrl!);
    const rollback = new Error("rollback migration test");
    const botId = "00000000-0000-0000-0000-000000000001";

    try {
      await expect(
        client.begin(async (tx) => {
          await tx.unsafe("CREATE TABLE bots (id uuid PRIMARY KEY)");
          await tx.unsafe(
            "CREATE TABLE bot_memories (id integer PRIMARY KEY, bot_id uuid NOT NULL, telegram_id bigint, is_active boolean NOT NULL DEFAULT true, updated_at timestamp NOT NULL DEFAULT now())",
          );
          await tx.unsafe(
            "CREATE TABLE conversation_messages (id integer PRIMARY KEY, bot_id uuid NOT NULL, chat_id bigint NOT NULL, user_id bigint NOT NULL)",
          );
          await tx.unsafe(
            "CREATE TABLE user_privacy_settings (bot_id uuid NOT NULL, user_id bigint NOT NULL, mode text NOT NULL)",
          );
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await tx.unsafe(statement);
          }

          await tx.unsafe(`INSERT INTO bots (id) VALUES ('${botId}')`);
          await tx.unsafe(`
          INSERT INTO bot_memories (id, bot_id, telegram_id) VALUES
          (1, '${botId}', NULL), (2, '${botId}', 41), (3, '${botId}', NULL)
        `);
          await tx.unsafe("UPDATE bot_memories SET updated_at = '2020-01-01' WHERE id = 1");
          await tx.unsafe(`
          INSERT INTO conversation_messages (id, bot_id, chat_id, user_id) VALUES
          (101, '${botId}', -100, 41), (102, '${botId}', 41, 41)
        `);
          await tx.unsafe(`
          INSERT INTO memory_consolidation_evidence
            (bot_id, chat_id, action, memory_id, source_message_ids, participant_ids) VALUES
          ('${botId}', -100, 'add', 1, ARRAY[101], ARRAY[41, 42]::bigint[]),
          ('${botId}', -100, 'ignore', NULL, ARRAY[101], ARRAY[41]::bigint[]),
          ('${botId}', 41, 'add', 2, ARRAY[102], ARRAY[41]::bigint[])
        `);

          // Ordinary 30-day raw-history cleanup must preserve the long-term record.
          await tx.unsafe("DELETE FROM conversation_messages WHERE id = 101");
          expect(
            await tx.unsafe("SELECT id FROM bot_memories WHERE id = 1 AND is_active"),
          ).toHaveLength(1);
          expect(
            await tx.unsafe("SELECT id FROM memory_consolidation_evidence WHERE memory_id = 1"),
          ).toHaveLength(1);
          expect(
            await tx.unsafe("SELECT id FROM memory_consolidation_evidence WHERE action = 'ignore'"),
          ).toHaveLength(0);

          // /privacy forget sets mode off, deletes raw history, then deletes only
          // directly attributable personal memories via telegram_id.
          await tx.unsafe(`
          INSERT INTO user_privacy_settings (bot_id, user_id, mode) VALUES ('${botId}', 41, 'off')
        `);
          await tx.unsafe("DELETE FROM conversation_messages WHERE user_id = 41");
          expect(await tx.unsafe("SELECT id FROM bot_memories WHERE id = 2")).toHaveLength(1);
          await tx.unsafe("DELETE FROM bot_memories WHERE telegram_id = 41");
          expect(await tx.unsafe("SELECT id FROM bot_memories WHERE id = 2")).toHaveLength(0);
          expect(
            await tx.unsafe("SELECT id FROM memory_consolidation_evidence WHERE memory_id = 2"),
          ).toHaveLength(0);
          expect(
            await tx.unsafe("SELECT id FROM bot_memories WHERE id = 1 AND NOT is_active"),
          ).toHaveLength(1);
          expect(
            await tx.unsafe(`
              SELECT id FROM bot_memories WHERE id = 1
                AND updated_at > now() - interval '1 minute'
            `),
          ).toHaveLength(1);
          expect(
            await tx.unsafe(`
              SELECT id FROM bot_memories WHERE id = 1 AND NOT is_active
                AND updated_at < now() - interval '30 days'
            `),
          ).toHaveLength(0);
          // A repeated privacy setting does not renew an already retired row.
          await tx.unsafe("UPDATE bot_memories SET updated_at = '2020-01-01' WHERE id = 1");
          await tx.unsafe("UPDATE user_privacy_settings SET mode = 'off' WHERE user_id = 41");
          expect(
            await tx.unsafe(
              "SELECT id FROM bot_memories WHERE id = 1 AND updated_at = '2020-01-01'",
            ),
          ).toHaveLength(1);
          expect(
            await tx.unsafe("SELECT id FROM memory_consolidation_evidence WHERE memory_id = 1"),
          ).toHaveLength(1);
          expect(
            await tx.unsafe("SELECT id FROM bot_memories WHERE id = 3 AND is_active"),
          ).toHaveLength(1);

          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await client.end();
    }
  },
);
