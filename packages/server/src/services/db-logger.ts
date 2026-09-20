import type { Database } from "@cos-tool-bot/database";
import { botLogs } from "@cos-tool-bot/database";
import type { LogLevel } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { redactDiagnostic } from "./run-redaction.js";

export class DbLogger {
  constructor(
    private db: Database,
    private pino: Logger,
    private botId?: string,
  ) {}

  async log(level: LogLevel, message: string, meta?: unknown) {
    const safeMessage = redactDiagnostic(message) as string;
    const safeMeta = meta === undefined ? undefined : redactDiagnostic(meta);
    // pino default level is info, so debug() calls are silently ignored in stdout
    if (safeMeta === undefined) this.pino[level](safeMessage);
    else this.pino[level](safeMeta, safeMessage);
    try {
      await this.db
        .insert(botLogs)
        .values({ level, message: safeMessage, meta: safeMeta ?? null, botId: this.botId ?? null });
    } catch (err) {
      this.pino.error(redactDiagnostic(err), "Failed to write log to database");
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
