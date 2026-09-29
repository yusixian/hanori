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
