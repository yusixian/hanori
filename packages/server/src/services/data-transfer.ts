import type { Database } from "@cos-tool-bot/database";
import * as schema from "@cos-tool-bot/database";
import type { ExportManifest, ExportPayload, ImportResult } from "@cos-tool-bot/shared";
import { eq, getTableName, isTable, sql } from "drizzle-orm";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { encrypt } from "../utils/crypto.js";

// Transient media jobs must not be replayed (or expose retained transcripts) through Bot JSON imports.
const EXCLUDED_TABLES = new Set(["bot_logs", "media_transcription_jobs"]);

// Sensitive field sanitizers per DB table name
const SENSITIVE_FIELDS: Record<string, (row: Record<string, unknown>) => Record<string, unknown>> =
  {
    bot_plugin_configs: sanitizePluginConfigTransfer,
    bots: (row) => {
      const { encryptedToken: _encryptedToken, ...rest } = row;
      if (rest.aiConfig && typeof rest.aiConfig === "object") {
        rest.aiConfig = sanitizeAiConfig(rest.aiConfig as Record<string, unknown>);
      }
      return rest;
    },
  };

function sanitizePluginConfigTransfer(row: Record<string, unknown>): Record<string, unknown> {
  const { encryptedSecrets, encrypted_secrets, ...rest } = row;
  const values =
    rest.values && typeof rest.values === "object" && !Array.isArray(rest.values)
      ? { ...(rest.values as Record<string, unknown>) }
      : {};
  for (const secrets of [encryptedSecrets, encrypted_secrets]) {
    if (secrets && typeof secrets === "object" && !Array.isArray(secrets)) {
      for (const key of Object.keys(secrets)) delete values[key];
    }
  }
  // Bot-scoped ciphertext cannot be replayed into an imported Bot. Reconfigure before enabling.
  return { ...rest, values, encryptedSecrets: {}, enabled: false, revision: 1 };
}

function sanitizeAiConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { encryptedApiKey: _encryptedApiKey, ...rest } = config;
  if (rest.webToolsConfig && typeof rest.webToolsConfig === "object") {
    const wtc = { ...(rest.webToolsConfig as Record<string, unknown>) };
    if (wtc.search && typeof wtc.search === "object") {
      const { apiKey: _searchApiKey, ...searchRest } = wtc.search as Record<string, unknown>;
      wtc.search = searchRest;
    }
    if (wtc.imageGeneration && typeof wtc.imageGeneration === "object") {
      const { apiKey: _imgApiKey, ...imgRest } = wtc.imageGeneration as Record<string, unknown>;
      wtc.imageGeneration = imgRest;
    }
    rest.webToolsConfig = wtc;
  }
  // Strip embedding API key
  if (rest.embeddingConfig && typeof rest.embeddingConfig === "object") {
    const { encryptedApiKey: _embApiKey, ...embRest } = rest.embeddingConfig as Record<
      string,
      unknown
    >;
    rest.embeddingConfig = embRest;
  }
  if (rest.githubToolsConfig && typeof rest.githubToolsConfig === "object") {
    const {
      encryptedToken: _githubToken,
      githubAppInstallation: _githubAppInstallation,
      ...githubRest
    } = rest.githubToolsConfig as Record<string, unknown>;
    rest.githubToolsConfig = githubRest;
  }
  return rest;
}

/** Fields to strip from exported rows (e.g. large vector data) */
const STRIP_FIELDS = new Set(["embedding"]);

interface ChildTableInfo {
  table: PgTable<TableConfig>;
  botIdColumn: string;
  dbName: string;
  schemaKey: string;
}

// Convert snake_case DB name to camelCase schema key
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Convert date strings back to Date objects for timestamp columns before Drizzle insert */
function rehydrateDates(
  table: PgTable<TableConfig>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const config = getTableConfig(table);
  const timestampCols = new Set(
    config.columns.filter((c) => c.dataType === "date").map((c) => snakeToCamel(c.name)),
  );
  const result = { ...row };
  for (const col of timestampCols) {
    if (typeof result[col] === "string") {
      result[col] = new Date(result[col] as string);
    }
  }
  return result;
}

function discoverBotChildTables(): ChildTableInfo[] {
  const childTables: ChildTableInfo[] = [];

  for (const [key, value] of Object.entries(schema)) {
    if (!isTable(value)) continue;

    const table = value as PgTable<TableConfig>;
    const config = getTableConfig(table);
    const dbName = config.name;

    // Skip the bots table itself
    if (dbName === "bots") continue;

    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (getTableName(ref.foreignTable) === "bots") {
        const botIdCol = ref.columns[0];
        if (botIdCol) {
          childTables.push({
            table,
            botIdColumn: botIdCol.name,
            dbName,
            schemaKey: key,
          });
        }
        break;
      }
    }
  }

  return childTables;
}

const BATCH_SIZE = 500;

const IMPORT_PRIORITY: Record<string, number> = {
  peopleProfiles: 10,
  generationCharacters: 20,
  promptAssets: 20,
  generationLibraryConfigs: 20,
  imageGenerations: 30,
  peopleCharacterBindings: 40,
  imageGenerationEvents: 40,
  generationAssetUses: 40,
};

type ImportedId = string | number;

interface ImportIdMaps {
  peopleProfiles: Map<number, number>;
  generationCharacters: Map<number, number>;
  promptAssets: Map<number, number>;
  imageGenerations: Map<string, string>;
  historicalCharacters: Map<number, number>;
  historicalAssets: Map<number, number>;
}

function createImportIdMaps(): ImportIdMaps {
  return {
    peopleProfiles: new Map(),
    generationCharacters: new Map(),
    promptAssets: new Map(),
    imageGenerations: new Map(),
    historicalCharacters: new Map(),
    historicalAssets: new Map(),
  };
}

function getRowBotId(row: Record<string, unknown>): unknown {
  return row.botId ?? row.bot_id;
}

function requireMappedId<T extends ImportedId>(
  map: Map<T, T>,
  oldId: unknown,
  dependency: string,
  dependent: string,
): T {
  if (
    oldId === undefined ||
    oldId === null ||
    (typeof oldId === "number" && (!Number.isSafeInteger(oldId) || oldId <= 0))
  ) {
    throw new Error(
      `Cannot import ${dependent}: referenced ${dependency} ${String(oldId)} is missing from the same bot payload`,
    );
  }
  const mapped = map.get(oldId as T);
  if (mapped === undefined) {
    throw new Error(
      `Cannot import ${dependent}: referenced ${dependency} ${String(oldId)} is missing from the same bot payload`,
    );
  }
  return mapped;
}

function remapHistoricalId(
  liveMap: Map<number, number>,
  tombstoneMap: Map<number, number>,
  oldId: unknown,
  subject: string,
): number {
  const mapped = liveMap.get(oldId as number);
  if (mapped !== undefined) return mapped;
  if (typeof oldId !== "number" || !Number.isSafeInteger(oldId) || oldId === 0) {
    throw new Error(`Cannot import ${subject}: invalid historical id ${String(oldId)}`);
  }
  const existingTombstone = tombstoneMap.get(oldId);
  if (existingTombstone !== undefined) return existingTombstone;
  // Each source id gets a distinct negative id, avoiding both serial ids and old +/- id collisions.
  const tombstone = -(tombstoneMap.size + 1);
  tombstoneMap.set(oldId, tombstone);
  return tombstone;
}

function remapGenerationMaterials(requestSnapshot: unknown, maps: ImportIdMaps): unknown {
  if (!requestSnapshot || typeof requestSnapshot !== "object" || Array.isArray(requestSnapshot)) {
    return requestSnapshot;
  }

  const snapshot = { ...(requestSnapshot as Record<string, unknown>) };
  if (
    !snapshot.materials ||
    typeof snapshot.materials !== "object" ||
    Array.isArray(snapshot.materials)
  ) {
    return snapshot;
  }

  const materials = { ...(snapshot.materials as Record<string, unknown>) };
  if (Array.isArray(materials.characters)) {
    materials.characters = materials.characters.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const character = { ...(value as Record<string, unknown>) };
      character.id = remapHistoricalId(
        maps.generationCharacters,
        maps.historicalCharacters,
        character.id,
        "generation material character",
      );
      return character;
    });
  }
  if (Array.isArray(materials.assets)) {
    materials.assets = materials.assets.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const asset = { ...(value as Record<string, unknown>) };
      asset.id = remapHistoricalId(
        maps.promptAssets,
        maps.historicalAssets,
        asset.id,
        "generation material asset",
      );
      return asset;
    });
  }

  snapshot.materials = materials;
  return snapshot;
}

export class DataTransferService {
  private childTables: ChildTableInfo[];

  constructor(
    private db: Database,
    private encryptionKey: string,
  ) {
    this.childTables = discoverBotChildTables().filter((t) => !EXCLUDED_TABLES.has(t.dbName));
  }

  getDiscoveredTables(): string[] {
    return this.childTables.map((t) => t.dbName);
  }

  async getExportStats(botId: string): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};

    for (const child of this.childTables) {
      const config = getTableConfig(child.table);
      const botCol = config.columns.find((c) => c.name === child.botIdColumn);
      if (!botCol) continue;

      const result = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(child.table)
        .where(eq(botCol, botId));
      stats[child.schemaKey] = result[0]?.count ?? 0;
    }

    return stats;
  }

  async exportBot(botId: string, excludeTables?: Set<string>): Promise<ExportPayload> {
    // Get bot record
    const [bot] = await this.db.select().from(schema.bots).where(eq(schema.bots.id, botId));
    if (!bot) throw new Error(`Bot not found: ${botId}`);

    const botRow = this.sanitizeRow("bots", bot as unknown as Record<string, unknown>);

    const payload: Record<string, unknown> = {};
    const tables: string[] = [];
    const counts: Record<string, number> = {};

    for (const child of this.childTables) {
      if (excludeTables?.has(child.schemaKey)) continue;

      const config = getTableConfig(child.table);
      const botCol = config.columns.find((c) => c.name === child.botIdColumn);
      if (!botCol) continue;

      const rows = await this.db.select().from(child.table).where(eq(botCol, botId));
      const sanitized = rows.map((r) =>
        this.sanitizeRow(child.dbName, r as unknown as Record<string, unknown>),
      );

      payload[child.schemaKey] = sanitized;
      tables.push(child.schemaKey);
      counts[child.schemaKey] = sanitized.length;
    }

    const manifest: ExportManifest = {
      version: 1,
      exportedAt: new Date().toISOString(),
      scope: "bot",
      botId: bot.id,
      botName: bot.name,
      tables,
      counts,
    };

    return {
      manifest,
      bots: [botRow],
      ...payload,
    } as ExportPayload;
  }

  async importData(payload: ExportPayload): Promise<ImportResult> {
    // Basic validation
    if (!payload.manifest || payload.manifest.version !== 1) {
      throw new Error("Invalid export format: unsupported version");
    }
    if (!Array.isArray(payload.bots) || payload.bots.length === 0) {
      throw new Error("Invalid export format: no bots data");
    }

    const sourceBotIds = new Set<string>();
    for (const botData of payload.bots) {
      const sourceBotId = botData.id;
      if (typeof sourceBotId !== "string" || sourceBotId.length === 0) {
        throw new Error("Invalid export format: bot id is missing");
      }
      if (sourceBotIds.has(sourceBotId)) {
        throw new Error(`Invalid export format: duplicate bot id ${sourceBotId}`);
      }
      sourceBotIds.add(sourceBotId);
    }

    for (const child of this.childTables) {
      const tableData = payload[child.schemaKey];
      if (!Array.isArray(tableData)) continue;
      for (const value of tableData) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(`Invalid export format: ${child.schemaKey} contains a non-object row`);
        }
        const rowBotId = getRowBotId(value as Record<string, unknown>);
        if (typeof rowBotId !== "string" || !sourceBotIds.has(rowBotId)) {
          throw new Error(
            `Invalid export format: ${child.schemaKey} row references unknown bot ${String(rowBotId)}`,
          );
        }
      }
    }

    const result: ImportResult = { importedBots: [], counts: {} };

    const importTables = this.childTables
      .map((child, index) => ({ child, index }))
      .sort(
        (a, b) =>
          (IMPORT_PRIORITY[a.child.schemaKey] ?? 25) - (IMPORT_PRIORITY[b.child.schemaKey] ?? 25) ||
          a.index - b.index,
      )
      .map(({ child }) => child);

    await this.db.transaction(async (tx) => {
      for (const botData of payload.bots) {
        const oldBotId = botData.id as string;
        const botName = (botData.name as string) ?? "Imported Bot";
        const importedAiConfig =
          botData.aiConfig &&
          typeof botData.aiConfig === "object" &&
          !Array.isArray(botData.aiConfig)
            ? sanitizeAiConfig(botData.aiConfig as Record<string, unknown>)
            : botData.aiConfig;

        // Insert new bot with placeholder token
        const placeholderToken = encrypt("__IMPORT_PLACEHOLDER__", this.encryptionKey);
        const [newBot] = await tx
          .insert(schema.bots)
          .values({
            name: botName,
            encryptedToken: placeholderToken,
            adminChatIds: (botData.adminChatIds as number[]) ?? [],
            aiConfig: importedAiConfig as typeof schema.bots.$inferInsert.aiConfig,
            isActive: false,
          })
          .returning();

        if (!newBot) throw new Error("Failed to create bot");

        result.importedBots.push({ oldId: oldBotId, newId: newBot.id, name: botName });

        const idMaps = createImportIdMaps();

        // Import child table data
        for (const child of importTables) {
          const tableData = payload[child.schemaKey];
          if (!Array.isArray(tableData) || tableData.length === 0) continue;

          const sourceRows = (tableData as Array<Record<string, unknown>>).filter(
            (row) => getRowBotId(row) === oldBotId,
          );
          if (sourceRows.length === 0) continue;

          const config = getTableConfig(child.table);
          const botColName = child.botIdColumn;
          // Find the serial/id column name
          const idCol = config.columns.find((c) => c.name === "id" && c.hasDefault);
          const idColName = idCol?.name;

          const rows = sourceRows.map((row) => {
            const oldId = idColName ? (row[snakeToCamel(idColName)] ?? row[idColName]) : undefined;
            const newRow = rehydrateDates(
              child.table,
              child.schemaKey === "botPluginConfigs" ? sanitizePluginConfigTransfer(row) : row,
            );
            // Replace botId with new UUID
            // Map DB column name to JS field name
            const botField = snakeToCamel(botColName);
            newRow[botField] = newBot.id;
            if (botField !== botColName) delete newRow[botColName];

            if (child.schemaKey === "peopleCharacterBindings") {
              newRow.profileId = requireMappedId(
                idMaps.peopleProfiles,
                newRow.profileId,
                "people profile",
                "character binding",
              );
              newRow.characterId = requireMappedId(
                idMaps.generationCharacters,
                newRow.characterId,
                "generation character",
                "character binding",
              );
            } else if (child.schemaKey === "generationAssetUses") {
              newRow.generationId = requireMappedId(
                idMaps.imageGenerations,
                newRow.generationId,
                "image generation",
                "generation asset usage",
              );
              newRow.assetId = remapHistoricalId(
                idMaps.promptAssets,
                idMaps.historicalAssets,
                newRow.assetId,
                "generation asset usage",
              );
            } else if (child.schemaKey === "imageGenerationEvents") {
              newRow.generationId = requireMappedId(
                idMaps.imageGenerations,
                newRow.generationId,
                "image generation",
                "image generation event",
              );
            } else if (child.schemaKey === "imageGenerations") {
              newRow.requestSnapshot = remapGenerationMaterials(newRow.requestSnapshot, idMaps);
            }

            // Remove serial id to let DB auto-generate
            if (idColName) {
              const idField = snakeToCamel(idColName);
              delete newRow[idField];
              delete newRow[idColName];
            }
            return { oldId, values: newRow };
          });

          const mapsGeneratedIds =
            idCol &&
            (child.schemaKey === "peopleProfiles" ||
              child.schemaKey === "generationCharacters" ||
              child.schemaKey === "promptAssets" ||
              child.schemaKey === "imageGenerations");
          if (mapsGeneratedIds) {
            // Insert individually: the old/new id association must not depend on RETURNING row order.
            for (const row of rows) {
              const [inserted] = await tx
                .insert(child.table)
                .values(row.values)
                .returning({ id: idCol });
              const oldId = row.oldId;
              const newId = inserted?.id;
              if (oldId === undefined || newId === undefined) {
                throw new Error(`Cannot map imported ${child.schemaKey} id`);
              }
              if (child.schemaKey === "peopleProfiles") {
                idMaps.peopleProfiles.set(Number(oldId), Number(newId));
              } else if (child.schemaKey === "generationCharacters") {
                idMaps.generationCharacters.set(Number(oldId), Number(newId));
              } else if (child.schemaKey === "promptAssets") {
                idMaps.promptAssets.set(Number(oldId), Number(newId));
              } else {
                idMaps.imageGenerations.set(String(oldId), String(newId));
              }
            }
          } else {
            // Batch tables whose rows do not need generated-id correlation.
            for (let i = 0; i < rows.length; i += BATCH_SIZE) {
              const batch = rows.slice(i, i + BATCH_SIZE);
              await tx.insert(child.table).values(batch.map((row) => row.values));
            }
          }

          result.counts[child.schemaKey] = (result.counts[child.schemaKey] ?? 0) + rows.length;
        }
      }
    });

    return result;
  }

  private sanitizeRow(dbTableName: string, row: Record<string, unknown>): Record<string, unknown> {
    // Strip large vector fields from all tables
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!STRIP_FIELDS.has(key)) cleaned[key] = value;
    }
    const sanitizer = SENSITIVE_FIELDS[dbTableName];
    return sanitizer ? sanitizer(cleaned) : cleaned;
  }
}
