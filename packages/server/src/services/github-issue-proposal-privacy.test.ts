import type { Database } from "@cos-tool-bot/database";
import { settings } from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import { expect, it } from "vitest";
import { AsrSettingsService } from "./asr-settings.js";
import { BackupService } from "./backup.js";

it("public settings projections only read their fixed key and never enumerate retained proposals", async () => {
  const queries: string[] = [];
  const values = new Map([
    ["backup_config", JSON.stringify({ storage: { type: "local" } })],
    [
      "github-issue-proposal:v1:bot:id",
      JSON.stringify({ body: "private-body", diagnostic: "private-diagnostic" }),
    ],
  ]);
  const db = {
    select: () => ({
      from: (table: unknown) => {
        expect(table).toBe(settings);
        return {
          where: (condition: SQL) => {
            const query = new PgDialect().sqlToQuery(condition);
            expect(query.sql).toContain('"settings"."key" = $1');
            const key = query.params[0] as string;
            queries.push(key);
            const value = values.get(key);
            const rows = value ? [{ value }] : [];
            return Object.assign(Promise.resolve(rows), { limit: async () => rows });
          },
        };
      },
    }),
  } as unknown as Database;
  const asr = await new AsrSettingsService(db, "test-key").getPublic();
  const backup = await new BackupService({
    db,
    encryptionKey: "test-key",
    databaseUrl: "postgresql://localhost/unit",
    backupDir: "/tmp/issue-172-unused",
    logger: {} as Logger,
  }).getConfig();
  expect(queries).toEqual(["asr_accounts", "backup_config"]);
  expect(JSON.stringify({ asr, backup })).not.toMatch(/private-body|private-diagnostic/);
  expect(backup).toEqual({ storage: { type: "local" } });
});
