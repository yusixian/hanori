import { conversationMessages, userPrivacySettings, type Database } from "@cos-tool-bot/database";
import type { HistoryCoverage } from "@cos-tool-bot/shared";
import { conversationMessageOrderId } from "./conversation-store.js";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

/** Reads attributable messages and optional assistant replies with verified source privacy/topic. */
export async function readScopedHistory(
  db: Pick<Database, "select">,
  source: { botId: string; chatId: number; threadId: number | null },
  window: { since: Date; until: Date; limit: number },
  roles: readonly string[] = ["user", "context"],
) {
  const rows = await db
    .select({
      content: conversationMessages.userAuthoredContent,
      fallback: conversationMessages.content,
      createdAt: conversationMessages.createdAt,
      userName: conversationMessages.userName,
      role: conversationMessages.role,
      meta: conversationMessages.meta,
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
        inArray(
          conversationMessages.role,
          roles.filter((role) => ["user", "context", "assistant"].includes(role)),
        ),
        sql`(
          (${conversationMessages.role} IN ('user','context') AND ${conversationMessages.userId} IS NOT NULL
            AND coalesce(${userPrivacySettings.mode}, 'normal') = 'normal')
          OR (${conversationMessages.role} = 'assistant' AND EXISTS (
            SELECT 1 FROM conversation_messages summary_source
            LEFT JOIN user_privacy_settings summary_privacy
              ON summary_privacy.bot_id = summary_source.bot_id AND summary_privacy.user_id = summary_source.user_id
            WHERE summary_source.id::text = ${conversationMessages.meta}->>'turnOrderId'
              AND summary_source.bot_id = ${conversationMessages.botId}
              AND summary_source.chat_id = ${conversationMessages.chatId}
              AND summary_source.role IN ('user','context') AND summary_source.user_id IS NOT NULL
              AND summary_source.meta::jsonb ? 'threadId'
              AND (summary_source.meta->>'threadId') IS NOT DISTINCT FROM (${conversationMessages.meta}->>'threadId')
              AND coalesce(summary_privacy.mode, 'normal') = 'normal'
          ))
        )`,
        source.threadId === null
          ? sql`${conversationMessages.meta}::jsonb ? 'threadId' AND ${conversationMessages.meta}->>'threadId' IS NULL`
          : sql`${conversationMessages.meta}->>'threadId' = ${String(source.threadId)}`,
      ),
    )
    .orderBy(desc(conversationMessageOrderId()), desc(conversationMessages.id))
    .limit(window.limit + 1);
  const truncated = rows.length > window.limit;
  const messages = rows
    .slice(0, window.limit)
    .reverse()
    .map((row) => ({
      content: row.content ?? row.fallback,
      createdAt: row.createdAt.toISOString(),
      userName: row.userName,
      role: row.role,
      meta: row.meta,
    }));
  const timestamps = messages.map((message) => message.createdAt).sort();
  const coverage: HistoryCoverage = {
    scope: {
      ...source,
      since: window.since.toISOString(),
      until: window.until.toISOString(),
      limit: window.limit,
    },
    returnedCount: messages.length,
    firstMessageAt: timestamps[0] ?? null,
    lastMessageAt: timestamps.at(-1) ?? null,
    complete: !truncated,
    truncated,
    reason: truncated ? "message_limit" : null,
    collectionCoverage: "unknown",
  };
  return { messages, complete: coverage.complete, coverage };
}
