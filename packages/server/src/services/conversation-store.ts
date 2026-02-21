import type { Database } from "@cos-tool-bot/database";
import { conversationMessages, conversationSummaries } from "@cos-tool-bot/database";
import type { ConversationRole } from "@cos-tool-bot/shared";
import { and, count, desc, eq, ilike, inArray, lt, sql } from "drizzle-orm";

export class ConversationStore {
  constructor(private db: Database) {}

  async addMessage(params: {
    botId: string;
    chatId: number;
    role: ConversationRole;
    content: string;
    userId?: number;
    userName?: string;
    meta?: Record<string, unknown>;
  }) {
    await this.db.insert(conversationMessages).values({
      botId: params.botId,
      chatId: params.chatId,
      role: params.role,
      content: params.content,
      userId: params.userId,
      userName: params.userName,
      meta: params.meta,
    });
  }

  async addMessages(
    messages: Array<{
      botId: string;
      chatId: number;
      role: ConversationRole;
      content: string;
      userId?: number;
      userName?: string;
      meta?: Record<string, unknown>;
    }>,
  ) {
    if (messages.length === 0) return;
    await this.db.insert(conversationMessages).values(
      messages.map((m) => ({
        botId: m.botId,
        chatId: m.chatId,
        role: m.role,
        content: m.content,
        userId: m.userId,
        userName: m.userName,
        meta: m.meta,
      })),
    );
  }

  async getHistory(botId: string, chatId: number, limit: number) {
    const [latestSummary] = await this.db
      .select()
      .from(conversationSummaries)
      .where(and(eq(conversationSummaries.botId, botId), eq(conversationSummaries.chatId, chatId)))
      .orderBy(desc(conversationSummaries.id))
      .limit(1);

    const messages = await this.db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
        userName: conversationMessages.userName,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          inArray(conversationMessages.role, ["user", "assistant", "context"]),
        ),
      )
      .orderBy(desc(conversationMessages.id))
      .limit(limit);

    return {
      summary: latestSummary?.content ?? null,
      messages: messages.reverse(),
    };
  }

  async getMessageCount(botId: string, chatId: number): Promise<number> {
    const [result] = await this.db
      .select({ total: count() })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)));
    return Number(result?.total ?? 0);
  }

  async compressMessages(
    botId: string,
    chatId: number,
    summaryText: string,
    upToId: number,
    messageCount: number,
  ) {
    await this.db.transaction(async (tx) => {
      await tx.insert(conversationSummaries).values({
        botId,
        chatId,
        content: summaryText,
        summarizedUpToId: upToId,
        messageCount,
      });
      await tx
        .delete(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            eq(conversationMessages.chatId, chatId),
            lt(conversationMessages.id, upToId + 1),
          ),
        );
    });
  }

  async deleteOldestMessages(botId: string, chatId: number, keepCount: number) {
    const cutoff = await this.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)))
      .orderBy(desc(conversationMessages.id))
      .limit(1)
      .offset(keepCount);

    if (cutoff.length === 0) return;
    const cutoffId = cutoff[0]!.id;

    await this.db
      .delete(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          lt(conversationMessages.id, cutoffId + 1),
        ),
      );
  }

  async clearHistory(botId: string, chatId: number) {
    await Promise.all([
      this.db
        .delete(conversationMessages)
        .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId))),
      this.db
        .delete(conversationSummaries)
        .where(
          and(eq(conversationSummaries.botId, botId), eq(conversationSummaries.chatId, chatId)),
        ),
    ]);
  }

  async clearAllForBot(botId: string) {
    await Promise.all([
      this.db.delete(conversationMessages).where(eq(conversationMessages.botId, botId)),
      this.db.delete(conversationSummaries).where(eq(conversationSummaries.botId, botId)),
    ]);
  }

  async getConversationList(botId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;

    const rows = await this.db
      .select({
        chatId: conversationMessages.chatId,
        messageCount: count(),
        lastActive: sql<string>`max(${conversationMessages.createdAt})`.as("last_active"),
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.botId, botId))
      .groupBy(conversationMessages.chatId)
      .orderBy(sql`last_active desc`)
      .limit(limit)
      .offset(offset);

    const [totalResult] = await this.db
      .select({
        total: sql<number>`count(distinct ${conversationMessages.chatId})`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.botId, botId));

    return {
      data: rows.map((r) => ({
        chatId: r.chatId,
        messageCount: Number(r.messageCount),
        lastActive: r.lastActive,
      })),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async getConversationMessages(botId: string, chatId: number, page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [messages, [totalResult]] = await Promise.all([
      this.db
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)))
        .orderBy(desc(conversationMessages.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId))),
    ]);

    return {
      data: messages.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        userId: m.userId,
        userName: m.userName,
        meta: m.meta,
        createdAt: m.createdAt.toISOString(),
      })),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async searchMessages(
    botId: string,
    params: { query: string; chatId?: number; userId?: number; limit?: number },
  ) {
    const conditions = [
      eq(conversationMessages.botId, botId),
      ilike(conversationMessages.content, `%${params.query}%`),
    ];
    if (params.chatId !== undefined) {
      conditions.push(eq(conversationMessages.chatId, params.chatId));
    }
    if (params.userId !== undefined) {
      conditions.push(eq(conversationMessages.userId, params.userId));
    }
    const rows = await this.db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
        userName: conversationMessages.userName,
        chatId: conversationMessages.chatId,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(and(...conditions))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(params.limit ?? 20);
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      userName: r.userName,
      chatId: r.chatId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async cleanup(retentionDays: number) {
    if (retentionDays <= 0) return;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await this.db
      .delete(conversationMessages)
      .where(lt(conversationMessages.createdAt, cutoffDate));
  }

  async getOldestMessages(botId: string, chatId: number, keepRecent: number) {
    const recentIds = this.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)))
      .orderBy(desc(conversationMessages.id))
      .limit(keepRecent);

    const oldMessages = await this.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          sql`${conversationMessages.id} not in (${recentIds})`,
        ),
      )
      .orderBy(conversationMessages.id);

    return oldMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      userName: m.userName,
    }));
  }
}
