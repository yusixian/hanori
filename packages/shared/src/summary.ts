export type SummaryMode =
  | { kind: "default" }
  | { kind: "recent"; count: number }
  | { kind: "hours"; hours: number }
  | { kind: "date"; day: "today" | "yesterday" };

export type SummaryTrigger = "manual" | "scheduled";
export type SummaryAccessMode = "all" | "admin";

export interface SummaryConfigRecord {
  id: number;
  botId: string;
  chatId: number;
  isActive: boolean;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  timezone: string | null;
  windowHours: number;
  customPrompt: string | null;
  providerId: string | null;
  modelId: string | null;
  maxMessages: number | null;
  cooldownSeconds: number | null;
  accessMode: SummaryAccessMode;
  lastScheduledAt: string | null;
  lastManualAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummaryRecord {
  id: number;
  botId: string;
  chatId: number;
  trigger: SummaryTrigger;
  triggeredBy: number | null;
  windowStart: string;
  windowEnd: string;
  messageCount: number;
  modelId: string;
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface SummaryConfigStored {
  enabled: boolean;
  defaultWindowHours: number;
  defaultMaxMessages: number;
  defaultCooldownSeconds: number;
  globalScheduleHour?: number;
  globalScheduleMinute?: number;
  modelId?: string;
  systemPrompt?: string;
  roleFilter?: Array<"user" | "context" | "assistant">;
  timezone?: string;
}

/** Exhaustion of eligible stored records, not a claim about all Telegram history. */
export interface HistoryCoverage {
  scope: {
    botId: string;
    chatId: number;
    threadId: number | null;
    since: string;
    until: string;
    limit: number;
  };
  returnedCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  complete: boolean;
  truncated: boolean;
  reason: "message_limit" | null;
  collectionCoverage: "unknown";
}

export interface SummaryRequest {
  mode?: SummaryMode;
  since?: string;
  until?: string;
  instructions?: string;
  maxMessages?: number;
}

export interface SummaryToolResult {
  ok: boolean;
  reason?: string;
  summaryId?: number;
  contentRaw?: string;
  messageCount?: number;
  coverage?: HistoryCoverage;
}

/** Bound by the server; chat identity and actor come from the current turn, never model arguments. */
export type ChatSummaryCallback = (input: {
  chatId: number;
  threadId?: number;
  userId: number;
  request: SummaryRequest;
  signal?: AbortSignal;
}) => Promise<SummaryToolResult>;
