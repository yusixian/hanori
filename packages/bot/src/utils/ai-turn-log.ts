import { randomUUID } from "node:crypto";
import type { BotLogEntry } from "@cos-tool-bot/shared";
import { toToolLogValue } from "./tool-log.js";

/** One diagnostic scope shared by model, tools, delivery and failure events. */
export function createAiTurnLogger(
  onLog: ((entry: BotLogEntry) => void | Promise<void>) | undefined,
  scope: Record<string, unknown>,
  secrets: readonly string[] = [],
): (entry: BotLogEntry) => void {
  const correlationId = randomUUID();
  return (entry) => {
    if (!onLog) return;
    try {
      const diagnostic = entry.meta === undefined ? {} : toToolLogValue(entry.meta, secrets);
      const metadata =
        diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)
          ? diagnostic
          : { details: diagnostic };
      const result = onLog({
        ...entry,
        message: String(toToolLogValue(entry.message, secrets)),
        meta: {
          ...metadata,
          ...scope,
          correlationId,
        },
      });
      void Promise.resolve(result).catch(() => {});
    } catch {
      // A diagnostic sink must not change reply delivery or mask its original error.
    }
  };
}
