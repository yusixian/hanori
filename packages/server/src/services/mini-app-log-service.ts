import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import type { LogLevel } from "@cos-tool-bot/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export interface MiniAppSafeLogEntry {
  id: number;
  level: LogLevel;
  message: string;
  createdAt: string;
  meta: unknown;
}

export interface MiniAppLogPage {
  logs: MiniAppSafeLogEntry[];
  nextCursor: number | null;
}

export interface MiniAppLogQuery {
  limit: number;
  before?: number;
  level?: LogLevel;
}

interface StoredLogRow {
  id: number;
  level: string;
  message: string;
  meta: unknown;
  createdAt: Date;
}

export function projectMiniAppLogEntry(row: StoredLogRow): MiniAppSafeLogEntry {
  const level: LogLevel =
    row.level === "debug" || row.level === "warn" || row.level === "error" ? row.level : "info";
  return {
    id: row.id,
    level,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    meta: row.meta,
  };
}

export class MiniAppLogService {
  constructor(private readonly db: Database) {}

  async read(botId: string, query: MiniAppLogQuery): Promise<MiniAppLogPage> {
    const conditions: SQL[] = [eq(botLogs.botId, botId)];
    if (query.before) conditions.push(lt(botLogs.id, query.before));
    if (query.level) conditions.push(eq(botLogs.level, query.level));

    const rows = await this.db
      .select({
        id: botLogs.id,
        level: botLogs.level,
        message: botLogs.message,
        meta: botLogs.meta,
        createdAt: botLogs.createdAt,
      })
      .from(botLogs)
      .where(and(...conditions))
      .orderBy(desc(botLogs.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map(projectMiniAppLogEntry);
    return {
      logs: page,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.id : null,
    };
  }
}
