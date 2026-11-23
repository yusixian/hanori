import type { Database } from "@cos-tool-bot/database";
import { conversationMessages, settings, userPrivacySettings } from "@cos-tool-bot/database";
import {
  normalizeQuoteColor,
  parseQuoteSource,
  type QuoteSource,
  type QuoteSourceQuery,
  type QuoteSourceStoreCallbacks,
} from "@cos-tool-bot/shared";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

const quoteId = sql<number>`case when ${conversationMessages.meta}->'quoteSource'->>'messageId' ~ '^[0-9]{1,16}$' then (${conversationMessages.meta}->'quoteSource'->>'messageId')::bigint end`;

export class QuoteSourceStore {
  constructor(private readonly db: Database) {}

  forBot(botId: string): QuoteSourceStoreCallbacks {
    const colorKey = (chatId: number) => `quote-color:${botId}:${chatId}`;
    const receiptPrefix = (chatId: number) => `quote-output:${botId}:${chatId}:`;
    return {
      getQuoteSources: (chatId, threadId, query) =>
        this.getQuoteSources(botId, chatId, threadId, query),
      getQuoteReplyTargets: async (chatId, threadId, messageIds) => {
        if (
          !messageIds.length ||
          messageIds.length > 10 ||
          messageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
        )
          throw new Error("Invalid quote reply query");
        const rows = await this.db
          .selectDistinctOn([sql`${conversationMessages.meta}->>'tgMessageId'`], {
            meta: conversationMessages.meta,
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.botId, botId),
              eq(conversationMessages.chatId, chatId),
              inArray(conversationMessages.role, ["user", "context", "assistant"]),
              sql`${conversationMessages.meta}::jsonb ? 'threadId'`,
              threadId === null
                ? sql`${conversationMessages.meta}->>'threadId' is null`
                : eq(sql<string>`${conversationMessages.meta}->>'threadId'`, String(threadId)),
              inArray(
                sql<string>`${conversationMessages.meta}->>'tgMessageId'`,
                messageIds.map(String),
              ),
            ),
          )
          .orderBy(sql`${conversationMessages.meta}->>'tgMessageId'`, desc(conversationMessages.id))
          .limit(messageIds.length);
        const targets: Record<number, number> = {};
        for (const { meta } of rows) {
          const id = meta?.["tgMessageId"];
          const source = parseQuoteSource(meta?.["quoteSource"]);
          const parent =
            meta?.["replyToTgMessageId"] ??
            (source?.messageId === id && source?.threadId === threadId
              ? source.replyToMessageId
              : undefined);
          if (
            typeof id === "number" &&
            typeof parent === "number" &&
            Number.isSafeInteger(parent) &&
            parent > 0 &&
            targets[id] === undefined
          )
            targets[id] = parent;
        }
        return targets;
      },
      getQuoteColor: async (chatId) => {
        const [row] = await this.db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, colorKey(chatId)))
          .limit(1);
        return row ? normalizeQuoteColor(row.value) : undefined;
      },
      setQuoteColor: async (chatId, color) => {
        const key = colorKey(chatId);
        if (color === undefined) {
          await this.db.delete(settings).where(eq(settings.key, key));
          return;
        }
        const value = normalizeQuoteColor(color);
        if (!value) throw new Error("Invalid quote color");
        await this.db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({ target: settings.key, set: { value } });
      },
      isQuoteOutput: async (chatId, messageId) => {
        const [row] = await this.db
          .select({ key: settings.key })
          .from(settings)
          .where(eq(settings.key, `${receiptPrefix(chatId)}${messageId}`))
          .limit(1);
        return !!row;
      },
      markQuoteOutput: async (chatId, messageId) => {
        if (!Number.isSafeInteger(messageId) || messageId <= 0)
          throw new Error("Invalid quote output ID");
        const prefix = receiptPrefix(chatId);
        await this.db
          .insert(settings)
          .values({ key: `${prefix}${messageId}`, value: "1" })
          .onConflictDoNothing();
      },
    };
  }

  async getQuoteSources(
    botId: string,
    chatId: number,
    threadId: number | null,
    query: QuoteSourceQuery,
  ): Promise<QuoteSource[]> {
    const ids = "ids" in query ? [...new Set(query.ids)] : undefined;
    const limit = ids ? ids.length : "limit" in query ? query.limit : 0;
    if (
      limit < 1 ||
      limit > 10 ||
      !Number.isInteger(limit) ||
      ids?.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      ("anchorId" in query && (!Number.isSafeInteger(query.anchorId) || query.anchorId <= 0))
    )
      throw new Error("Invalid quote source query");
    const backward = "direction" in query && query.direction === "backward";
    const rows = await this.db
      .selectDistinctOn([quoteId], { meta: conversationMessages.meta })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          inArray(conversationMessages.role, ["user", "context", "assistant"]),
          sql`${conversationMessages.meta}::jsonb ? 'threadId'`,
          threadId === null
            ? sql`${conversationMessages.meta}->>'threadId' is null`
            : eq(sql<string>`${conversationMessages.meta}->>'threadId'`, String(threadId)),
          eq(sql<string>`${conversationMessages.meta}->'quoteSource'->>'version'`, "1"),
          sql`not exists (select 1 from ${userPrivacySettings} where ${userPrivacySettings.botId} = ${botId} and ${userPrivacySettings.mode} = 'off' and (${conversationMessages.meta}->'quoteSource'->'privacyUserIds')::jsonb @> jsonb_build_array(${userPrivacySettings.userId}))`,
          ids
            ? inArray(quoteId, ids)
            : "anchorId" in query
              ? backward
                ? lte(quoteId, query.anchorId)
                : gte(quoteId, query.anchorId)
              : undefined,
        ),
      )
      .orderBy(backward ? desc(quoteId) : asc(quoteId), desc(conversationMessages.id))
      .limit(limit);
    const sources = rows.flatMap((row) => {
      const source = parseQuoteSource(row.meta?.["quoteSource"]);
      return source &&
        source.threadId === threadId &&
        source.messageId === row.meta?.["tgMessageId"] &&
        !source.protectedContent
        ? [source]
        : [];
    });
    const userIds = [...new Set(sources.flatMap((source) => source.privacyUserIds))];
    const modes = userIds.length
      ? await this.db
          .select({ userId: userPrivacySettings.userId, mode: userPrivacySettings.mode })
          .from(userPrivacySettings)
          .where(
            and(eq(userPrivacySettings.botId, botId), inArray(userPrivacySettings.userId, userIds)),
          )
      : [];
    const excluded = new Set(modes.filter((row) => row.mode === "off").map((row) => row.userId));
    return sources
      .filter((source) => source.privacyUserIds.every((id) => !excluded.has(id)))
      .sort((a, b) => a.messageId - b.messageId);
  }
}
