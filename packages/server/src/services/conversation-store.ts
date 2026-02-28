import type { Database } from "@cos-tool-bot/database";
import { conversationMessages, conversationSummaries } from "@cos-tool-bot/database";
import type { ConversationRole } from "@cos-tool-bot/shared";
import {
  and,
  cosineDistance,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  lt,
  sql,
} from "drizzle-orm";
import { escapeLike, rrfMerge } from "../utils/search.js";

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
  ): Promise<number[]> {
    if (messages.length === 0) return [];
    const rows = await this.db
      .insert(conversationMessages)
      .values(
        messages.map((m) => ({
          botId: m.botId,
          chatId: m.chatId,
          role: m.role,
          content: m.content,
          userId: m.userId,
          userName: m.userName,
          meta: m.meta,
        })),
      )
      .returning({ id: conversationMessages.id });
    return rows.map((r) => r.id);
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

    // 1a. Main aggregate query with role counts and user info
    const rows = await this.db
      .select({
        chatId: conversationMessages.chatId,
        messageCount: count(),
        lastActive: sql<string>`max(${conversationMessages.createdAt})`.as("last_active"),
        firstActive: sql<string>`min(${conversationMessages.createdAt})`.as("first_active"),
        distinctUserCount: sql<number>`count(distinct ${conversationMessages.userId})
          filter (where ${conversationMessages.userId} is not null)`.as("distinct_user_count"),
        userNames: sql<string[]>`array_remove(array_agg(distinct ${conversationMessages.userName})
          filter (where ${conversationMessages.userName} is not null), null)`.as("user_names"),
        roleUser: sql<number>`count(*) filter (where ${conversationMessages.role} = 'user')`.as(
          "role_user",
        ),
        roleAssistant:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'assistant')`.as(
            "role_assistant",
          ),
        roleToolCall:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'tool_call')`.as(
            "role_tool_call",
          ),
        roleToolResult:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'tool_result')`.as(
            "role_tool_result",
          ),
        roleSystem: sql<number>`count(*) filter (where ${conversationMessages.role} = 'system')`.as(
          "role_system",
        ),
        roleContext:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'context')`.as(
            "role_context",
          ),
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

    if (rows.length === 0) {
      return { data: [], total: Number(totalResult?.total ?? 0) };
    }

    const chatIds = rows.map((r) => r.chatId);

    // 1b. Latest message preview per chat (DISTINCT ON)
    const lastMessages = await this.db.execute<{
      chat_id: number;
      content: string;
      role: string;
      user_name: string | null;
    }>(
      sql`select distinct on (chat_id) chat_id, left(content, 200) as content, role, user_name
          from ${conversationMessages}
          where ${and(eq(conversationMessages.botId, botId), inArray(conversationMessages.chatId, chatIds))}
          order by chat_id, id desc`,
    );
    const lastMessageMap = new Map(lastMessages.map((m) => [Number(m.chat_id), m]));

    // 1c. Summary counts per chat
    const summaryCounts = await this.db
      .select({
        chatId: conversationSummaries.chatId,
        summaryCount: count(),
      })
      .from(conversationSummaries)
      .where(
        and(eq(conversationSummaries.botId, botId), inArray(conversationSummaries.chatId, chatIds)),
      )
      .groupBy(conversationSummaries.chatId);
    const summaryMap = new Map(summaryCounts.map((s) => [s.chatId, Number(s.summaryCount)]));

    return {
      data: rows.map((r) => {
        const lm = lastMessageMap.get(r.chatId);
        const sc = summaryMap.get(r.chatId) ?? 0;
        return {
          chatId: r.chatId,
          messageCount: Number(r.messageCount),
          lastActive: r.lastActive,
          firstActive: r.firstActive,
          chatType: (r.chatId > 0 ? "private" : "group") as "private" | "group",
          roleCounts: {
            user: Number(r.roleUser),
            assistant: Number(r.roleAssistant),
            tool_call: Number(r.roleToolCall),
            tool_result: Number(r.roleToolResult),
            system: Number(r.roleSystem),
            context: Number(r.roleContext),
          },
          distinctUserCount: Number(r.distinctUserCount),
          userNames: r.userNames?.length ? r.userNames : null,
          lastMessage: lm ? { content: lm.content, role: lm.role, userName: lm.user_name } : null,
          hasSummaries: sc > 0,
          summaryCount: sc,
        };
      }),
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

  async updateEmbedding(messageId: number, embedding: number[]): Promise<void> {
    await this.db
      .update(conversationMessages)
      .set({ embedding })
      .where(eq(conversationMessages.id, messageId));
  }

  async searchMessages(
    botId: string,
    params: {
      query: string;
      chatId?: number;
      userId?: number;
      limit?: number;
      queryEmbedding?: number[];
    },
  ) {
    const limit = params.limit ?? 20;

    const buildBaseConditions = () => {
      const conditions = [eq(conversationMessages.botId, botId)];
      if (params.chatId !== undefined) {
        conditions.push(eq(conversationMessages.chatId, params.chatId));
      }
      if (params.userId !== undefined) {
        conditions.push(eq(conversationMessages.userId, params.userId));
      }
      return conditions;
    };

    const selectFields = {
      id: conversationMessages.id,
      role: conversationMessages.role,
      content: conversationMessages.content,
      userName: conversationMessages.userName,
      chatId: conversationMessages.chatId,
      createdAt: conversationMessages.createdAt,
    };

    type Row = {
      id: number;
      role: string;
      content: string;
      userName: string | null;
      chatId: number;
      createdAt: Date;
    };
    const toResult = (r: Row) => ({
      role: r.role,
      content: r.content,
      userName: r.userName,
      chatId: r.chatId,
      createdAt: r.createdAt.toISOString(),
    });

    // Hybrid search when embedding is available
    if (params.queryEmbedding) {
      const baseConditions = buildBaseConditions();

      // Keyword search (fix: use escapeLike)
      const keywordResults = await this.db
        .select(selectFields)
        .from(conversationMessages)
        .where(
          and(
            ...baseConditions,
            ilike(conversationMessages.content, `%${escapeLike(params.query)}%`),
          ),
        )
        .orderBy(desc(conversationMessages.createdAt))
        .limit(30);

      // Vector search
      const vectorResults = await this.db
        .select(selectFields)
        .from(conversationMessages)
        .where(and(...baseConditions, isNotNull(conversationMessages.embedding)))
        .orderBy(cosineDistance(conversationMessages.embedding, params.queryEmbedding))
        .limit(30);

      const merged = rrfMerge(keywordResults, vectorResults, 0.7, 0.3, 60, limit);
      return merged.map(toResult);
    }

    // Keyword-only fallback (fix: use escapeLike)
    const conditions = [
      ...buildBaseConditions(),
      ilike(conversationMessages.content, `%${escapeLike(params.query)}%`),
    ];
    const rows = await this.db
      .select(selectFields)
      .from(conversationMessages)
      .where(and(...conditions))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);
    return rows.map(toResult);
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
