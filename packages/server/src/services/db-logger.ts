import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import type { LogLevel } from "@cos-tool-bot/shared";
import type { Logger } from "pino";

export class DbLogger {
  constructor(
    private db: Database,
    private pino: Logger,
    private botId?: string,
  ) {}

  async log(level: LogLevel, message: string, meta?: unknown) {
    // pino default level is info, so debug() calls are silently ignored in stdout
    this.pino[level](meta, message);
    try {
      await this.db
        .insert(botLogs)
        .values({ level, message, meta: meta ?? null, botId: this.botId ?? null });
    } catch (err) {
      this.pino.error(err, "Failed to write log to database");
    }
  }

  debug(message: string, meta?: unknown) {
    return this.log("debug", message, meta);
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
