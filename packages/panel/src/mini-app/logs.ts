import type { LogLevel } from "@cos-tool-bot/shared";

export interface MiniAppLogMeta {
  command?: string;
  chatType?: "private" | "group" | "supergroup" | "channel";
  updateId?: number;
  messageId?: number;
}

export interface MiniAppLogEntry {
  id: number;
  level: LogLevel;
  message: string;
  createdAt: string;
  meta: MiniAppLogMeta;
}

export interface MiniAppLogPage {
  logs: MiniAppLogEntry[];
  nextCursor: number | null;
}

export interface MiniAppLogFilters {
  before?: number;
  level?: LogLevel;
  limit?: number;
}

export class MiniAppLogApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MiniAppLogApiError";
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ENTRY_KEYS = new Set(["id", "level", "message", "createdAt", "meta"]);
const META_KEYS = new Set(["command", "chatType", "updateId", "messageId"]);
const RESPONSE_KEYS = new Set(["ok", "logs", "nextCursor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseMeta(value: unknown): MiniAppLogMeta | null {
  if (!isRecord(value) || !hasOnlyKeys(value, META_KEYS)) return null;
  const command = value["command"];
  const chatType = value["chatType"];
  const updateId = value["updateId"];
  const messageId = value["messageId"];
  if (
    (command !== undefined &&
      (typeof command !== "string" || !/^[a-z0-9_]{1,64}$/i.test(command))) ||
    (chatType !== undefined &&
      chatType !== "private" &&
      chatType !== "group" &&
      chatType !== "supergroup" &&
      chatType !== "channel") ||
    (updateId !== undefined && safePositiveInteger(updateId) === undefined) ||
    (messageId !== undefined && safePositiveInteger(messageId) === undefined)
  ) {
    return null;
  }
  return {
    ...(typeof command === "string" ? { command } : {}),
    ...(typeof chatType === "string" ? { chatType } : {}),
    ...(typeof updateId === "number" ? { updateId } : {}),
    ...(typeof messageId === "number" ? { messageId } : {}),
  } as MiniAppLogMeta;
}

function parseEntry(value: unknown): MiniAppLogEntry | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ENTRY_KEYS)) return null;
  const id = safePositiveInteger(value["id"]);
  const meta = parseMeta(value["meta"]);
  const level = value["level"];
  if (
    id === undefined ||
    (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") ||
    typeof value["message"] !== "string" ||
    value["message"].length > 501 ||
    typeof value["createdAt"] !== "string" ||
    !meta
  ) {
    return null;
  }
  return { id, level, message: value["message"], createdAt: value["createdAt"], meta };
}

export function parseMiniAppLogPage(value: unknown): MiniAppLogPage | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, RESPONSE_KEYS) ||
    value["ok"] !== true ||
    !Array.isArray(value["logs"])
  ) {
    return null;
  }
  const logs = value["logs"].map(parseEntry);
  const nextCursor = value["nextCursor"] === null ? null : safePositiveInteger(value["nextCursor"]);
  if (
    !logs.every((entry): entry is MiniAppLogEntry => entry !== null) ||
    nextCursor === undefined
  ) {
    return null;
  }
  return { logs, nextCursor };
}

export async function fetchMiniAppLogs(
  botId: string,
  filters: MiniAppLogFilters = {},
  fetcher: Fetcher = fetch,
): Promise<MiniAppLogPage> {
  const query = new URLSearchParams();
  query.set("limit", String(filters.limit ?? 25));
  if (filters.before) query.set("before", String(filters.before));
  if (filters.level) query.set("level", filters.level);
  const response = await fetcher(
    `/api/mini-app/${encodeURIComponent(botId)}/logs?${query.toString()}`,
    { credentials: "same-origin" },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new MiniAppLogApiError(
      isRecord(body) && typeof body["error"] === "string" ? body["error"] : "Log request failed",
      response.status,
    );
  }
  const parsed = parseMiniAppLogPage(body);
  if (!parsed) throw new MiniAppLogApiError("Log response was invalid", response.status);
  return parsed;
}
