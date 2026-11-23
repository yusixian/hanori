import { randomUUID } from "node:crypto";
import type { BotLogEntry } from "@cos-tool-bot/shared";
import { modelErrorSummary } from "./model-error-summary.js";
import { toToolLogValue } from "./tool-log.js";

/** One diagnostic scope shared by model, tools, delivery and failure events. */
export function createAiTurnLogger(
  onLog: ((entry: BotLogEntry) => void | Promise<void>) | undefined,
  scope: Record<string, unknown>,
  secrets: readonly string[] = [],
  traceId?: string,
): (entry: BotLogEntry) => void {
  const correlationId = traceId ?? randomUUID();
  return (entry) => {
    if (!onLog) return;
    try {
      const diagnostic = entry.meta === undefined ? {} : toToolLogValue(entry.meta, secrets);
      const metadata =
        diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)
          ? diagnostic
          : { details: diagnostic };
      const transportContext = Object.fromEntries(
        ["model", "providerId", "providerFormat", "stage"].flatMap((key) => {
          const value = entry.meta?.[key];
          return typeof value === "string"
            ? [[key, String(toToolLogValue(value, secrets)).slice(0, 200)]]
            : [];
        }),
      );
      const result = onLog({
        ...entry,
        message: String(toToolLogValue(entry.message, secrets)),
        meta: {
          ...metadata,
          ...transportContext,
          ...(entry.meta?.error !== undefined
            ? { errorSummary: modelErrorSummary(entry.meta.error, secrets) }
            : {}),
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
