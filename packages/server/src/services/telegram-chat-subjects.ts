import { telegramChats } from "@cos-tool-bot/database";
import type { Database } from "@cos-tool-bot/database";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { escapeLike } from "../utils/search.js";

export interface TelegramChatSubject {
  id: string;
  name: string | null;
  username: string | null;
}

export function normalizeTelegramChatSubjectQuery(rawQuery: string | undefined): string {
  return (rawQuery ?? "").trim().replace(/^@/, "");
}

export async function searchTelegramChatSubjects(
  db: Database,
  botId: string,
  query: string,
): Promise<TelegramChatSubject[]> {
  const pattern = `%${escapeLike(query)}%`;
  const numericId = /^-\d+$/.test(query) ? Number(query) : undefined;
  const matches = query
    ? numericId !== undefined && Number.isSafeInteger(numericId)
      ? eq(telegramChats.chatId, numericId)
      : or(
          ilike(telegramChats.title, pattern),
          ilike(telegramChats.username, pattern),
          sql`${telegramChats.chatId}::text ILIKE ${pattern}`,
        )
    : undefined;
  const subjects = await db
    .select({
      id: telegramChats.chatId,
      name: telegramChats.title,
      username: telegramChats.username,
    })
    .from(telegramChats)
    .where(
      and(
        eq(telegramChats.botId, botId),
        isNull(telegramChats.leftAt),
        isNull(telegramChats.migratedToChatId),
        matches,
      ),
    )
    .orderBy(desc(telegramChats.lastObservedAt))
    .limit(20);
  return subjects.map((subject) => ({ ...subject, id: String(subject.id) }));
}
