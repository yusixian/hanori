import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import type { LogLevel } from "@cos-tool-bot/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

const SAFE_CHAT_TYPES = new Set(["private", "group", "supergroup", "channel"]);
const SAFE_COMMAND = /^\/?[a-z0-9_]{1,64}$/i;
const SAFE_STATIC_MESSAGES = new Set([
  "AI reply sent",
  "Bot is already running",
  "Bot is not running",
  "Bot restarted",
  "Bot restarting...",
  "Bot started",
  "Bot stopped",
]);

export interface MiniAppSafeLogMeta {
  command?: string;
  chatType?: "private" | "group" | "supergroup" | "channel";
  updateId?: number;
  messageId?: number;
}

export interface MiniAppSafeLogEntry {
  id: number;
  level: LogLevel;
  message: string;
  createdAt: string;
  meta: MiniAppSafeLogMeta;
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

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function projectMeta(value: unknown): MiniAppSafeLogMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const command =
    typeof source["command"] === "string" && SAFE_COMMAND.test(source["command"])
      ? source["command"].replace(/^\//, "")
      : undefined;
  const chatType =
    typeof source["chatType"] === "string" && SAFE_CHAT_TYPES.has(source["chatType"])
      ? (source["chatType"] as MiniAppSafeLogMeta["chatType"])
      : undefined;
  const updateId = safePositiveInteger(source["updateId"]);
  const messageId = safePositiveInteger(source["messageId"]);
  return {
    ...(command ? { command } : {}),
    ...(chatType ? { chatType } : {}),
    ...(updateId ? { updateId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function projectMessage(row: StoredLogRow, meta: MiniAppSafeLogMeta, level: LogLevel): string {
  if (SAFE_STATIC_MESSAGES.has(row.message)) return row.message;
  if (meta.command) return "Command received";
  if (meta.updateId || meta.messageId || meta.chatType) return "Telegram update received";
  if (level === "error") return "Runtime error";
  if (level === "warn") return "Runtime warning";
  if (level === "debug") return "Runtime diagnostic event";
  return "Runtime event";
}

export function projectMiniAppLogEntry(row: StoredLogRow): MiniAppSafeLogEntry {
  const level: LogLevel =
    row.level === "debug" || row.level === "warn" || row.level === "error" ? row.level : "info";
  const meta = projectMeta(row.meta);
  return {
    id: row.id,
    level,
    message: projectMessage(row, meta, level),
    createdAt: row.createdAt.toISOString(),
    meta,
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
