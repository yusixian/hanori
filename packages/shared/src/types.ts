export type CommandEntity = {
  name: string;
  args: string[];
  original_msg: string;
};

export type BotStatus = "running" | "stopped" | "restarting";

export type LogLevel = "info" | "warn" | "error";

export interface BotRecord {
  id: string;
  name: string;
  tokenMasked: string;
  adminChatIds: number[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface BotWithStatus extends BotRecord {
  status: BotStatus;
  uptime: number | null;
}

export interface LogEntry {
  id: number;
  botId: string | null;
  level: LogLevel;
  message: string;
  meta: unknown;
  createdAt: string;
}

export interface BotLogEntry {
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}
