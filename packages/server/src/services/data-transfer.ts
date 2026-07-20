import type { Database } from "@cos-tool-bot/database";
import * as schema from "@cos-tool-bot/database";
import type { ExportManifest, ExportPayload, ImportResult } from "@cos-tool-bot/shared";
import { eq, getTableName, isTable, sql } from "drizzle-orm";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { encrypt } from "../utils/crypto.js";

// Tables excluded from export (by DB table name)
const EXCLUDED_TABLES = new Set(["bot_logs"]);

// Sensitive field sanitizers per DB table name
const SENSITIVE_FIELDS: Record<string, (row: Record<string, unknown>) => Record<string, unknown>> =
  {
    bots: (row) => {
      const { encryptedToken: _encryptedToken, ...rest } = row;
      if (rest.aiConfig && typeof rest.aiConfig === "object") {
        rest.aiConfig = sanitizeAiConfig(rest.aiConfig as Record<string, unknown>);
      }
      return rest;
    },
  };

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

    const result: ImportResult = { importedBots: [], counts: {} };

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

        // Import child table data
        for (const child of this.childTables) {
          const tableData = payload[child.schemaKey];
          if (!Array.isArray(tableData) || tableData.length === 0) continue;

          const config = getTableConfig(child.table);
          const botColName = child.botIdColumn;
          // Find the serial/id column name
          const idCol = config.columns.find((c) => c.name === "id" && c.hasDefault);
          const idColName = idCol?.name;

          const rows = tableData.map((row: Record<string, unknown>) => {
            const newRow = rehydrateDates(child.table, row);
            // Replace botId with new UUID
            // Map DB column name to JS field name
            const botField = snakeToCamel(botColName);
            if (botField in newRow) {
              newRow[botField] = newBot.id;
            } else if (botColName in newRow) {
              newRow[botColName] = newBot.id;
            }
            // Remove serial id to let DB auto-generate
            if (idColName) {
              const idField = snakeToCamel(idColName);
              delete newRow[idField];
              delete newRow[idColName];
            }
            return newRow;
          });

          // Batch insert
          for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            await tx.insert(child.table).values(rows.slice(i, i + BATCH_SIZE));
          }

          result.counts[child.schemaKey] = rows.length;
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
