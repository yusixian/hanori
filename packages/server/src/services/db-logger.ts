import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import type { Logger } from "pino";

export class DbLogger {
  constructor(
    private db: Database,
    private pino: Logger,
    private botId?: string,
  ) {}

  async log(level: "info" | "warn" | "error", message: string, meta?: unknown) {
    this.pino[level](meta, message);
    try {
      await this.db
        .insert(botLogs)
        .values({ level, message, meta: meta ?? null, botId: this.botId ?? null });
    } catch (err) {
      this.pino.error(err, "Failed to write log to database");
    }
  }

  info(message: string, meta?: unknown) {
    return this.log("info", message, meta);
  }

  warn(message: string, meta?: unknown) {
    return this.log("warn", message, meta);
  }

  error(message: string, meta?: unknown) {
    return this.log("error", message, meta);
  }
}
