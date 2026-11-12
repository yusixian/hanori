import type { Database } from "@cos-tool-bot/database";
import type { ScheduledTaskRecord } from "@cos-tool-bot/shared";
import { readScopedHistory } from "./scoped-history.js";

/** Task history remains restricted to attributable original user/context messages. */
export function readScheduledTaskHistory(
  db: Pick<Database, "select">,
  source: Pick<ScheduledTaskRecord, "botId" | "chatId" | "threadId">,
  window: { since: Date; until: Date; limit: number },
) {
  return readScopedHistory(db, source, window);
}
