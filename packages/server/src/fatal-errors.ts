import type { Logger } from "pino";
import { redactDiagnostic } from "./services/run-redaction.js";

/** Fatal failures still exit immediately so the process supervisor can restart the server. */
export function registerFatalErrorHandlers(logger: Pick<Logger, "fatal">): void {
  const report = (field: "err" | "reason", error: unknown, message: string) => {
    try {
      logger.fatal({ [field]: redactDiagnostic(error) }, message);
    } finally {
      process.exit(1);
    }
  };
  process.on("uncaughtException", (error) => report("err", error, "Uncaught exception — exiting"));
  process.on("unhandledRejection", (reason) =>
    report("reason", reason, "Unhandled rejection — exiting"),
  );
}
