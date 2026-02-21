export type CommandEntity = {
  name: string;
  args: string[];
  original_msg: string;
};

export type BotStatus = "running" | "stopped" | "restarting";

export type LogLevel = "info" | "warn" | "error";

export interface BotStatusResponse {
  status: BotStatus;
  uptime: number | null;
}

export interface LogEntry {
  id: number;
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
