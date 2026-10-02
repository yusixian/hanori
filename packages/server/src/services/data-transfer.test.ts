import type { Database } from "@cos-tool-bot/database";
import * as schema from "@cos-tool-bot/database";
import type { ExportPayload } from "@cos-tool-bot/shared";
import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DataTransferService } from "./data-transfer.js";

interface CapturedInsert {
  table: string;
  rows: Array<Record<string, unknown>>;
}

function createImportDb() {
  const inserts: CapturedInsert[] = [];
  const counters = new Map<string, number>();

  const transaction = vi.fn(async (operation: (tx: unknown) => Promise<void>) => {
    const tx = {
      insert: (table: Parameters<typeof getTableName>[0]) => ({
        values: (value: Record<string, unknown> | Array<Record<string, unknown>>) => {
          const rows = Array.isArray(value) ? value : [value];
          const tableName = getTableName(table);
          inserts.push({ table: tableName, rows });

          const returning = async () => {
            if (table === schema.bots) {
              return [{ id: `new-bot-${String(rows[0]?.name)}` }];
            }

            const start = counters.get(tableName) ?? 0;
            counters.set(tableName, start + rows.length);
            return rows.map((_, index) => ({
              id:
                table === schema.imageGenerations
                  ? `new-generation-${start + index + 1}`
                  : (start + index + 1) * 100,
            }));
          };

          const operation = Promise.resolve() as Promise<void> & { returning: typeof returning };
          operation.returning = returning;
          return operation;
        },
      }),
    };
    await operation(tx);
  });

  return {
    db: { transaction } as unknown as Database,
    inserts,
    transaction,
  };
}

function exportPayload(
  bots: Array<Record<string, unknown>>,
  tables: Record<string, Array<Record<string, unknown>>>,
): ExportPayload {
  return {
    manifest: {
      version: 1,
      exportedAt: new Date().toISOString(),
      scope: bots.length === 1 ? "bot" : "full",
      tables: Object.keys(tables),
      counts: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.length])),
    },
    bots,
    ...tables,
  } as ExportPayload;
}

describe("DataTransferService credential sanitization", () => {
  it("exports plugin settings without ciphertext and does not copy a secret into ordinary values", async () => {
    const db = {
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) => ({
          where: async () =>
            table === schema.bots
              ? [{ id: "old-bot", name: "Synthetic Bot" }]
              : table === schema.botPluginConfigs
                ? [
                    {
                      botId: "old-bot",
                      pluginId: "fixture.plugin",
                      manifestVersion: "1.0.0",
                      manifestHash: "a".repeat(64),
                      values: { limit: 7, cookie: "unsafe-duplicate" },
                      encryptedSecrets: { cookie: "private-ciphertext" },
                      enabled: true,
                      revision: 12,
                    },
                  ]
                : [],
        }),
      }),
    } as unknown as Database;
    const service = new DataTransferService(db, "a".repeat(64));
    expect(service.getDiscoveredTables()).toContain("bot_plugin_configs");
    expect(service.getDiscoveredTables()).not.toContain("media_transcription_jobs");
    const payload = await service.exportBot("old-bot");
    expect(payload.botPluginConfigs).toEqual([
      expect.objectContaining({
        botId: "old-bot",
        pluginId: "fixture.plugin",
        values: { limit: 7 },
        encryptedSecrets: {},
        enabled: false,
        revision: 1,
      }),
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/private-ciphertext|unsafe-duplicate/);
  });

  it("strips forged plugin credentials and forces imported plugin settings to stay disabled", async () => {
    const { db, inserts } = createImportDb();
    const service = new DataTransferService(db, "a".repeat(64));
    await service.importData(
      exportPayload([{ id: "old-bot", name: "Synthetic" }], {
        botPluginConfigs: [
          {
            botId: "old-bot",
            pluginId: "fixture.plugin",
            manifestVersion: "1.0.0",
            manifestHash: "a".repeat(64),
            values: { limit: 7, cookie: "unsafe-duplicate", token: "unsafe-token" },
            encryptedSecrets: { cookie: "forged-cookie" },
            encrypted_secrets: { token: "forged-token" },
            enabled: true,
            revision: 12,
          },
        ],
      }),
    );
    const rows = inserts.find((insert) => insert.table === "bot_plugin_configs")!.rows;
    expect(rows).toEqual([
      expect.objectContaining({
        botId: "new-bot-Synthetic",
        values: { limit: 7 },
        encryptedSecrets: {},
        enabled: false,
        revision: 1,
      }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/forged-|unsafe-|encrypted_secrets/);
  });

  it("strips forged GitHub credentials and installation metadata during import", async () => {
    let insertedBot: Record<string, unknown> | undefined;
    const transaction = vi.fn(async (operation: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: () => ({
          values: (value: Record<string, unknown>) => {
            insertedBot = value;
            return {
              returning: async () => [{ id: "new-bot-id" }],
            };
          },
        }),
      };
      await operation(tx);
    });
    const service = new DataTransferService({ transaction } as unknown as Database, "a".repeat(64));
    const payload = {
      manifest: {
        version: 1,
        exportedAt: new Date().toISOString(),
        scope: "bot",
        botId: "old-bot-id",
        botName: "Imported",
        tables: [],
        counts: {},
      },
      bots: [
        {
          id: "old-bot-id",
          name: "Imported",
          aiConfig: {
            enabled: false,
            githubToolsConfig: {
              enabled: true,
              publicReadEnabled: false,
              codingAgentEnabled: true,
              encryptedToken: "forged-encrypted-pat",
              githubAppInstallation: {
                installationId: 123,
                accountLogin: "forged-owner",
                accountType: "Organization",
                repositorySelection: "all",
                repositories: ["private/secret"],
                permissions: { contents: "write" },
                connectedAt: new Date().toISOString(),
              },
              login: "forged-owner",
              authorName: "Ai-chan",
              authorEmail: "ai@example.com",
              repositories: ["private/secret"],
            },
          },
        },
      ],
    } as unknown as ExportPayload;

    await service.importData(payload);

    const aiConfig = insertedBot?.aiConfig as Record<string, unknown>;
    const github = aiConfig.githubToolsConfig as Record<string, unknown>;
    expect(github.encryptedToken).toBeUndefined();
    expect(github.githubAppInstallation).toBeUndefined();
    expect(github).toMatchObject({
      enabled: true,
      login: "forged-owner",
      repositories: ["private/secret"],
    });
  });
});

describe("DataTransferService generation library import", () => {
  it("imports dependencies in order and remaps generated ids in bindings, snapshots, and usage", async () => {
    const { db, inserts } = createImportDb();
    const service = new DataTransferService(db, "a".repeat(64));
    const payload = exportPayload([{ id: "old-bot", name: "Imported" }], {
      peopleProfiles: [{ id: 11, botId: "old-bot", telegramId: 123 }],
      generationCharacters: [{ id: 21, botId: "old-bot", source: "original", name: "Mira" }],
      peopleCharacterBindings: [
        {
          botId: "old-bot",
          profileId: 11,
          characterId: 21,
          relation: "representation",
          isDefault: true,
        },
      ],
      promptAssets: [{ id: 31, botId: "old-bot", name: "Soft", type: "style", content: "soft" }],
      imageGenerations: [
        {
          id: "old-generation",
          botId: "old-bot",
          prompt: "portrait",
          requestSnapshot: {
            materials: {
              characters: [{ id: 21, name: "Mira", content: "silver hair", version: "v1" }],
              assets: [
                { id: 31, name: "Soft", content: "soft", version: "v1" },
                { id: 99, name: "Deleted", content: "grain", version: "v1" },
              ],
            },
          },
        },
      ],
      generationAssetUses: [
        { botId: "old-bot", generationId: "old-generation", assetId: 31 },
        { botId: "old-bot", generationId: "old-generation", assetId: 99 },
      ],
      imageGenerationEvents: [
        { id: 41, botId: "old-bot", generationId: "old-generation", kind: "created" },
      ],
    });

    await service.importData(payload);

    const tableOrder = inserts.map(({ table }) => table);
    expect(tableOrder.indexOf("people_profiles")).toBeLessThan(
      tableOrder.indexOf("people_character_bindings"),
    );
    expect(tableOrder.indexOf("generation_characters")).toBeLessThan(
      tableOrder.indexOf("people_character_bindings"),
    );
    expect(tableOrder.indexOf("image_generations")).toBeLessThan(
      tableOrder.indexOf("generation_asset_uses"),
    );

    expect(inserts.find(({ table }) => table === "people_character_bindings")?.rows).toEqual([
      expect.objectContaining({
        botId: "new-bot-Imported",
        profileId: 100,
        characterId: 100,
      }),
    ]);
    expect(inserts.find(({ table }) => table === "image_generations")?.rows[0]).toMatchObject({
      botId: "new-bot-Imported",
      requestSnapshot: {
        materials: {
          characters: [{ id: 100 }],
          assets: [{ id: 100 }, { id: -1 }],
        },
      },
    });
    expect(inserts.find(({ table }) => table === "generation_asset_uses")?.rows).toEqual([
      expect.objectContaining({
        botId: "new-bot-Imported",
        generationId: "new-generation-1",
        assetId: 100,
      }),
      expect.objectContaining({
        botId: "new-bot-Imported",
        generationId: "new-generation-1",
        assetId: -1,
      }),
    ]);
    expect(inserts.find(({ table }) => table === "image_generation_events")?.rows).toEqual([
      expect.objectContaining({ generationId: "new-generation-1" }),
    ]);
  });

  it("keeps each source bot's rows and id maps isolated", async () => {
    const { db, inserts } = createImportDb();
    const service = new DataTransferService(db, "a".repeat(64));
    const payload = exportPayload(
      [
        { id: "bot-a", name: "A" },
        { id: "bot-b", name: "B" },
      ],
      {
        peopleProfiles: [
          { id: 1, botId: "bot-a", telegramId: 111 },
          { id: 1, botId: "bot-b", telegramId: 222 },
        ],
        generationCharacters: [
          { id: 2, botId: "bot-a", source: "original", name: "A character" },
          { id: 2, botId: "bot-b", source: "original", name: "B character" },
        ],
        peopleCharacterBindings: [
          {
            botId: "bot-a",
            profileId: 1,
            characterId: 2,
            relation: "representation",
            isDefault: true,
          },
          {
            botId: "bot-b",
            profileId: 1,
            characterId: 2,
            relation: "representation",
            isDefault: true,
          },
        ],
      },
    );

    await service.importData(payload);

    const bindings = inserts
      .filter(({ table }) => table === "people_character_bindings")
      .flatMap(({ rows }) => rows);
    expect(bindings).toEqual([
      expect.objectContaining({ botId: "new-bot-A", profileId: 100, characterId: 100 }),
      expect.objectContaining({ botId: "new-bot-B", profileId: 200, characterId: 200 }),
    ]);
  });

  it("uses shared collision-free tombstones for missing history across repeated imports", async () => {
    const first = createImportDb();
    const firstService = new DataTransferService(first.db, "a".repeat(64));
    await firstService.importData(
      exportPayload([{ id: "old-bot", name: "First" }], {
        imageGenerations: [
          {
            id: "old-generation",
            botId: "old-bot",
            requestSnapshot: {
              materials: {
                assets: [
                  { id: -1, name: "Earlier tombstone", content: "a", version: "v1" },
                  { id: 1, name: "Deleted asset", content: "b", version: "v1" },
                ],
              },
            },
          },
        ],
        generationAssetUses: [
          { botId: "old-bot", generationId: "old-generation", assetId: -1 },
          { botId: "old-bot", generationId: "old-generation", assetId: 1 },
        ],
      }),
    );

    const firstGeneration = first.inserts.find(({ table }) => table === "image_generations")
      ?.rows[0];
    const firstUses = first.inserts.find(({ table }) => table === "generation_asset_uses")?.rows;
    expect(firstGeneration?.requestSnapshot).toMatchObject({
      materials: { assets: [{ id: -1 }, { id: -2 }] },
    });
    expect(firstUses?.map((row) => row.assetId)).toEqual([-1, -2]);

    const second = createImportDb();
    const secondService = new DataTransferService(second.db, "a".repeat(64));
    await secondService.importData(
      exportPayload([{ id: "second-source", name: "Second" }], {
        imageGenerations: [
          {
            id: "second-generation",
            botId: "second-source",
            requestSnapshot: firstGeneration?.requestSnapshot,
          },
        ],
        generationAssetUses: (firstUses ?? []).map((row) => ({
          ...row,
          botId: "second-source",
          generationId: "second-generation",
        })),
      }),
    );

    expect(
      second.inserts.find(({ table }) => table === "image_generations")?.rows[0]?.requestSnapshot,
    ).toMatchObject({ materials: { assets: [{ id: -1 }, { id: -2 }] } });
    expect(
      second.inserts
        .find(({ table }) => table === "generation_asset_uses")
        ?.rows.map((row) => row.assetId),
    ).toEqual([-1, -2]);
  });

  it("fails clearly when a relational dependency is absent", async () => {
    const { db } = createImportDb();
    const service = new DataTransferService(db, "a".repeat(64));
    const payload = exportPayload([{ id: "old-bot", name: "Imported" }], {
      generationCharacters: [{ id: 21, botId: "old-bot", source: "original", name: "Mira" }],
      peopleCharacterBindings: [
        {
          botId: "old-bot",
          profileId: -1,
          characterId: 21,
          relation: "representation",
          isDefault: true,
        },
      ],
    });

    await expect(service.importData(payload)).rejects.toThrow(
      "Cannot import character binding: referenced people profile -1 is missing from the same bot payload",
    );
  });

  it("rejects rows for a bot not declared in the payload", async () => {
    const { db, transaction } = createImportDb();
    const service = new DataTransferService(db, "a".repeat(64));
    const payload = exportPayload([{ id: "old-bot", name: "Imported" }], {
      generationCharacters: [{ id: 21, botId: "foreign-bot", source: "original", name: "Foreign" }],
    });

    await expect(service.importData(payload)).rejects.toThrow(
      "generationCharacters row references unknown bot foreign-bot",
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});
