import { conversationMessages, userPrivacySettings, type Database } from "@cos-tool-bot/database";
import type { ScheduledTaskRecord } from "@cos-tool-bot/shared";
import type { TaskHistoryMessage } from "@cos-tool-bot/bot";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

/** Reads only original messages whose source topic and current privacy are known. */
export async function readScheduledTaskHistory(
  db: Pick<Database, "select">,
  source: Pick<ScheduledTaskRecord, "botId" | "chatId" | "threadId">,
  window: { since: Date; until: Date; limit: number },
): Promise<{ messages: TaskHistoryMessage[]; complete: boolean }> {
  const rows = await db
    .select({
      content: conversationMessages.userAuthoredContent,
      fallback: conversationMessages.content,
      createdAt: conversationMessages.createdAt,
      userName: conversationMessages.userName,
      role: conversationMessages.role,
    })
    .from(conversationMessages)
    .leftJoin(
      userPrivacySettings,
      and(
        eq(userPrivacySettings.botId, conversationMessages.botId),
        eq(userPrivacySettings.userId, conversationMessages.userId),
      ),
    )
    .where(
      and(
        eq(conversationMessages.botId, source.botId),
        eq(conversationMessages.chatId, source.chatId),
        gte(conversationMessages.createdAt, window.since),
        lte(conversationMessages.createdAt, window.until),
        inArray(conversationMessages.role, ["user", "context"]),
        sql`${conversationMessages.userId} IS NOT NULL`,
        sql`coalesce(${userPrivacySettings.mode}, 'normal') = 'normal'`,
        source.threadId === null
          ? sql`${conversationMessages.meta}::jsonb ? 'threadId' AND ${conversationMessages.meta}->>'threadId' IS NULL`
          : sql`${conversationMessages.meta}->>'threadId' = ${String(source.threadId)}`,
      ),
    )
    .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
    .limit(window.limit);
  return {
    messages: rows.reverse().map((row) => ({
      content: row.content ?? row.fallback,
      createdAt: row.createdAt.toISOString(),
      userName: row.userName,
      role: row.role,
    })),
    // Retention, privacy filtering and the requested window can all omit messages.
    complete: false,
  };
}
