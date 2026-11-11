import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { getTableColumns, sql, eq } from "drizzle-orm";
import { bots, createDb } from "@cos-tool-bot/database";
import type { AiConfigStored, PromptSnapshot } from "@cos-tool-bot/shared";
import {
  PromptVersionService,
  readActivePromptSnapshot,
  promptSnapshotSchema,
} from "./prompt-versions.js";

const databaseUrl = process.env.PROMPT_VERSION_TEST_DATABASE_URL;
const botId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const workingConfig: AiConfigStored = {
  enabled: true,
  model: "current-model",
  encryptedApiKey: "synthetic-current-key",
  baseURL: "https://example.invalid",
  systemPrompt: "working",
  triggerConfig: {
    replyToBot: true,
    mentionBot: true,
    triggerWords: [],
    randomReplyPercent: 0,
    randomReplyCooldown: 60,
  },
  groupOverrides: {},
};
const snapshot: PromptSnapshot = {
  systemPrompt: "Synthetic persona",
  behavioralPrompt: "Be concise",
  groupBehavioralPrompt: "Wait for a useful contribution",
  files: [
    { name: "IDENTITY.md", content: "Original identity", enabled: true },
    { name: "REFERENCE.md", content: "Original reference", enabled: false },
  ],
  maxInjectionBytes: 1024,
  skills: [
    {
      id: "fixture",
      name: "fixture",
      displayName: "Fixture",
      description: "Fixture help",
      summary: "Fixture help",
      source: "custom",
      instructions: "Original skill",
      resources: { "reference.md": "Original resource" },
      digest: "old",
      enabled: true,
    },
  ],
};
it("accepts only authored prompt fields and rejects duplicate files", () => {
  expect(
    promptSnapshotSchema.parse({
      ...snapshot,
      apiKey: "not-a-version-field",
      model: "not-a-version-field",
    }),
  ).not.toHaveProperty("apiKey");
  expect(
    promptSnapshotSchema.safeParse({ ...snapshot, files: [...snapshot.files, snapshot.files[0]] })
      .success,
  ).toBe(false);
});

describe.runIf(Boolean(databaseUrl))(
  "prompt version PostgreSQL lifecycle and migration 0074",
  () => {
    let connection: ReturnType<typeof createDb>;
    let service: PromptVersionService;
    let ownsTables = false;
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.pathname.endsWith("_test")
      )
        throw new Error("Requires an isolated local _test database");
      connection = createDb(databaseUrl!);
      await connection.db.transaction(async (db) => {
        // This dedicated empty database needs only the existing bots shape, not historical pgvector migrations.
        const columns = Object.values(getTableColumns(bots)).filter(
          (column) => column.name !== "active_prompt_version_id",
        );
        await db.execute(
          sql.raw(
            `CREATE TABLE bots (${columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`).join(",")})`,
          ),
        );
        const migration = await readFile(
          new URL("../../../database/drizzle/0074_supreme_captain_flint.sql", import.meta.url),
          "utf8",
        );
        for (const statement of migration.split("--> statement-breakpoint"))
          await db.execute(sql.raw(statement));
        await db.insert(bots).values(
          [botId, otherId].map((id) => ({
            id,
            name: "Fixture",
            encryptedToken: "synthetic",
            aiConfig: workingConfig,
          })),
        );
      });
      ownsTables = true;
      service = new PromptVersionService(connection.db, "fixture-app-sha");
    });
    afterAll(async () => {
      if (connection) {
        if (ownsTables) {
          await connection.db.execute(sql`DROP TABLE prompt_versions`);
          await connection.db.execute(sql`DROP TABLE bots`);
        }
        await connection.client.end();
      }
    });
    it("saves immutable content separately from activation, restores and protects active versions", async () => {
      const original = await service.create(botId, {
        name: "Original",
        description: "Synthetic baseline",
        snapshot,
      });
      expect(await readActivePromptSnapshot(connection.db, botId)).toBeNull();
      const candidate = await service.create(botId, {
        name: "Candidate",
        description: "",
        snapshot: { ...snapshot, behavioralPrompt: "Short" },
      });
      expect(candidate.snapshot.skills[0]!.digest).not.toBe("old");
      await expect(service.get(otherId, original.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.activate(otherId, original.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.remove(otherId, original.id)).rejects.toMatchObject({ status: 404 });
      await service.activate(botId, original.id);
      await expect(service.remove(botId, original.id)).rejects.toMatchObject({ status: 409 });
      await service.activate(botId, candidate.id);
      await service.activate(botId, original.id);
      const active = await readActivePromptSnapshot(connection.db, botId);
      expect(active?.snapshot.files).toEqual(snapshot.files);
      expect(active?.snapshot.skills[0]?.resources).toEqual(snapshot.skills[0]?.resources);
      const [bot] = await connection.db.select().from(bots).where(eq(bots.id, botId));
      expect(bot?.aiConfig).toEqual(workingConfig);
      const list = await service.list(botId);
      expect(list.versions[0]).not.toHaveProperty("snapshot");
      expect(list.versions[0]).not.toHaveProperty("previews");
      expect(original.applicationVersion).toBe("fixture-app-sha");
      expect(original.previews.private.fullPrompt).toContain("Original identity");
      await service.remove(botId, candidate.id);
      await service.activate(botId, null);
      await service.remove(botId, original.id);
    });
    it("serializes activation and removal without leaving an invalid active pointer", async () => {
      const version = await service.create(botId, {
        name: "Concurrent",
        description: "",
        snapshot,
      });
      const results = await Promise.allSettled([
        service.activate(botId, version.id),
        service.remove(botId, version.id),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const current = await readActivePromptSnapshot(connection.db, botId);
      if (current) {
        expect(current.id).toBe(version.id);
        await service.activate(botId, null);
        await service.remove(botId, version.id);
      } else await expect(service.get(botId, version.id)).rejects.toMatchObject({ status: 404 });
    });
  },
);
