import type { Database } from "@cos-tool-bot/database";
import { botMemories } from "@cos-tool-bot/database";
import type { BotMemory, BotMemoryAccess, BotMemoryKind } from "@cos-tool-bot/shared";
import {
  and,
  count,
  cosineDistance,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { escapeLike, rrfMerge } from "../utils/search.js";

/** The queries used here are available on both the pool and a Drizzle transaction. */
export type BotMemoryExecutor = Pick<
  Database,
  "select" | "selectDistinct" | "insert" | "update" | "delete"
>;

function toDto(row: typeof botMemories.$inferSelect): BotMemory {
  return {
    id: row.id,
    botId: row.botId,
    telegramId: row.telegramId,
    content: row.content,
    category: row.category,
    kind: row.kind,
    scopeChatId: row.scopeChatId,
    origin: row.origin,
    sourceChatId: row.sourceChatId,
    sourceMessageId: row.sourceMessageId,
    sourceUserId: row.sourceUserId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    factValidAt: row.factValidAt?.toISOString() ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? row.createdAt.toISOString(),
  };
}

function agentMutationScope(access?: BotMemoryAccess) {
  if (!access) return undefined;
  const chatScope = eq(botMemories.scopeChatId, access.chatId);
  const personalScope =
    access.userId == null
      ? undefined
      : and(
          eq(botMemories.telegramId, access.userId),
          access.includeUnscopedPersonal === false
            ? chatScope
            : or(isNull(botMemories.scopeChatId), chatScope),
        );
  return or(and(isNull(botMemories.telegramId), chatScope), personalScope);
}

export class BotMemoryStore {
  constructor(private db: BotMemoryExecutor) {}

  async getMemory(botId: string, memoryId: number): Promise<BotMemory | null> {
    const [row] = await this.db
      .select()
      .from(botMemories)
      .where(and(eq(botMemories.botId, botId), eq(botMemories.id, memoryId)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  async saveMemory(
    botId: string,
    data: {
      content: string;
      category?: string;
      telegramId?: number;
      kind?: BotMemoryKind;
      scopeChatId?: number;
      origin?: string;
      sourceChatId?: number;
      sourceMessageId?: number;
      sourceUserId?: number;
      expiresAt?: string;
      factValidAt?: string;
      embedding?: number[];
    },
  ): Promise<BotMemory> {
    const [created] = await this.db
      .insert(botMemories)
      .values({
        botId,
        content: data.content,
        category: data.category,
        telegramId: data.telegramId,
        kind: data.kind,
        scopeChatId: data.scopeChatId,
        origin: data.origin,
        sourceChatId: data.sourceChatId,
        sourceMessageId: data.sourceMessageId,
        sourceUserId: data.sourceUserId,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        factValidAt: data.factValidAt ? new Date(data.factValidAt) : undefined,
        embedding: data.embedding,
      })
      .returning();
    return toDto(created!);
  }

  async recallMemories(
    botId: string,
    params: {
      query?: string;
      category?: string;
      telegramId?: number;
      scopeChatId?: number;
      includeUnscopedPersonal?: boolean;
      scope?: "general_only" | "user_only" | "all";
      limit?: number;
      queryEmbedding?: number[];
      maxDistance?: number;
    },
  ): Promise<BotMemory[]> {
    const limit = params.limit ?? 20;

    // Build shared scope/category filter conditions
    const buildConditions = () => {
      const conditions = [
        eq(botMemories.botId, botId),
        eq(botMemories.isActive, true),
        or(isNull(botMemories.expiresAt), gt(botMemories.expiresAt, new Date()))!,
        params.scopeChatId == null
          ? isNull(botMemories.scopeChatId)
          : or(isNull(botMemories.scopeChatId), eq(botMemories.scopeChatId, params.scopeChatId))!,
      ];

      const scope = params.scope ?? "all";
      if (scope === "general_only") {
        conditions.push(isNull(botMemories.telegramId));
      } else if (scope === "user_only") {
        if (params.telegramId != null) {
          conditions.push(eq(botMemories.telegramId, params.telegramId));
          if (params.includeUnscopedPersonal === false) {
            conditions.push(
              params.scopeChatId == null
                ? sql`1=0`
                : eq(botMemories.scopeChatId, params.scopeChatId),
            );
          }
        } else {
          conditions.push(sql`1=0`);
        }
      } else if (scope === "all") {
        if (params.telegramId != null) {
          conditions.push(
            or(
              isNull(botMemories.telegramId),
              and(
                eq(botMemories.telegramId, params.telegramId),
                params.includeUnscopedPersonal === false
                  ? params.scopeChatId == null
                    ? sql`1=0`
                    : eq(botMemories.scopeChatId, params.scopeChatId)
                  : undefined,
              ),
            )!,
          );
        } else {
          // Never broaden an unscoped lookup to every user's private memories.
          conditions.push(isNull(botMemories.telegramId));
        }
      }

      if (params.category) {
        conditions.push(eq(botMemories.category, params.category));
      }

      return conditions;
    };

    // If we have both query and embedding, do hybrid search
    if (params.query && params.queryEmbedding) {
      const conditions = buildConditions();

      // Keyword search
      const keywordConditions = [
        ...conditions,
        ilike(botMemories.content, `%${escapeLike(params.query)}%`),
      ];
      const keywordResults = await this.db
        .select()
        .from(botMemories)
        .where(and(...keywordConditions))
        .orderBy(desc(botMemories.updatedAt))
        .limit(30);

      // Vector search
      const distance = cosineDistance(botMemories.embedding, params.queryEmbedding);
      const vectorConditions = [...conditions, isNotNull(botMemories.embedding)];
      if (params.maxDistance != null) {
        vectorConditions.push(lt(distance, params.maxDistance));
      }
      const vectorResults = await this.db
        .select()
        .from(botMemories)
        .where(and(...vectorConditions))
        .orderBy(distance)
        .limit(30);

      return rrfMerge(keywordResults, vectorResults, 0.7, 0.3, 60, limit).map(toDto);
    }

    // Vector-only search (query embedding but no text query)
    if (params.queryEmbedding && !params.query) {
      const conditions = buildConditions();
      const distance = cosineDistance(botMemories.embedding, params.queryEmbedding);
      const vectorConditions = [...conditions, isNotNull(botMemories.embedding)];
      if (params.maxDistance != null) {
        vectorConditions.push(lt(distance, params.maxDistance));
      }
      const rows = await this.db
        .select()
        .from(botMemories)
        .where(and(...vectorConditions))
        .orderBy(distance)
        .limit(limit);
      return rows.map(toDto);
    }

    // Keyword-only fallback
    const conditions = buildConditions();
    if (params.query) {
      conditions.push(ilike(botMemories.content, `%${escapeLike(params.query)}%`));
    }

    const rows = await this.db
      .select()
      .from(botMemories)
      .where(and(...conditions))
      .orderBy(desc(botMemories.updatedAt))
      .limit(limit);

    return rows.map(toDto);
  }

  async listMemories(
    botId: string,
    page: number,
    limit: number,
    filters?: { category?: string; telegramId?: number | "general"; search?: string },
  ) {
    const conditions = [eq(botMemories.botId, botId)];

    if (filters?.category) {
      conditions.push(eq(botMemories.category, filters.category));
    }
    if (filters?.telegramId === "general") {
      conditions.push(isNull(botMemories.telegramId));
    } else if (filters?.telegramId != null) {
      conditions.push(eq(botMemories.telegramId, filters.telegramId));
    }
    if (filters?.search) {
      conditions.push(ilike(botMemories.content, `%${escapeLike(filters.search)}%`));
    }

    const where = and(...conditions);
    const offset = (page - 1) * limit;

    const [rows, [totalResult]] = await Promise.all([
      this.db
        .select()
        .from(botMemories)
        .where(where)
        .orderBy(desc(botMemories.updatedAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(botMemories).where(where),
    ]);

    return {
      data: rows.map(toDto),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async updateMemory(
    botId: string,
    memoryId: number,
    data: {
      content?: string;
      expectedContent?: string;
      expectedUpdatedAt?: string;
      category?: string | null;
      telegramId?: number | null;
      kind?: BotMemoryKind | null;
      scopeChatId?: number | null;
      origin?: string | null;
      sourceChatId?: number | null;
      sourceMessageId?: number | null;
      sourceUserId?: number | null;
      factValidAt?: string | null;
      expiresAt?: string | null;
    },
    access?: BotMemoryAccess,
  ): Promise<BotMemory | null> {
    const updates: Partial<typeof botMemories.$inferInsert> = {};
    if (data.content !== undefined) {
      updates.content = data.content;
    }
    if (data.category !== undefined) updates.category = data.category;
    if (data.telegramId !== undefined) updates.telegramId = data.telegramId;
    if (data.kind !== undefined) updates.kind = data.kind;
    if (data.scopeChatId !== undefined) updates.scopeChatId = data.scopeChatId;
    if (data.origin !== undefined) updates.origin = data.origin;
    if (data.sourceChatId !== undefined) updates.sourceChatId = data.sourceChatId;
    if (data.sourceMessageId !== undefined) updates.sourceMessageId = data.sourceMessageId;
    if (data.sourceUserId !== undefined) updates.sourceUserId = data.sourceUserId;
    if (data.factValidAt !== undefined) {
      updates.factValidAt = data.factValidAt === null ? null : new Date(data.factValidAt);
    }
    if (data.expiresAt !== undefined) {
      updates.expiresAt = data.expiresAt === null ? null : new Date(data.expiresAt);
    }

    const [updated] = await this.db
      .update(botMemories)
      .set({
        ...updates,
        // Database DEFAULT now() may have microseconds, while the API version is milliseconds.
        // Advance the stored version by at least one millisecond for a reliable CAS token.
        updatedAt: sql`greatest(
          date_trunc('milliseconds', clock_timestamp() at time zone 'UTC'),
          date_trunc('milliseconds', coalesce(${botMemories.updatedAt}, ${botMemories.createdAt})) + interval '1 millisecond'
        )`,
        ...(data.content === undefined
          ? {}
          : {
              embedding: sql`case when ${botMemories.content} is distinct from ${data.content}
                then null else ${botMemories.embedding} end`,
            }),
      })
      .where(
        and(
          eq(botMemories.botId, botId),
          eq(botMemories.id, memoryId),
          eq(botMemories.isActive, true),
          data.expectedContent === undefined
            ? undefined
            : eq(botMemories.content, data.expectedContent),
          data.expectedUpdatedAt === undefined
            ? undefined
            : sql`date_trunc('milliseconds', coalesce(${botMemories.updatedAt}, ${botMemories.createdAt})) = ${new Date(data.expectedUpdatedAt).toISOString()}::timestamp`,
          agentMutationScope(access),
          access &&
            (data.kind === "event" || data.kind === "commitment" || data.kind === "relationship")
            ? eq(botMemories.scopeChatId, access.chatId)
            : undefined,
        ),
      )
      .returning();
    return updated ? toDto(updated) : null;
  }

  async updateEmbeddingIfContentMatches(
    botId: string,
    memoryId: number,
    content: string,
    embedding: number[],
  ): Promise<boolean> {
    const updated = await this.db
      .update(botMemories)
      .set({ embedding, updatedAt: sql`${botMemories.updatedAt}` })
      .where(
        and(
          eq(botMemories.botId, botId),
          eq(botMemories.id, memoryId),
          eq(botMemories.content, content),
          eq(botMemories.isActive, true),
        ),
      )
      .returning({ id: botMemories.id });
    return updated.length > 0;
  }

  async deleteMemory(botId: string, memoryId: number, access?: BotMemoryAccess): Promise<boolean> {
    if (access && access.userId == null) return false;
    const result = await this.db
      .delete(botMemories)
      .where(
        and(
          eq(botMemories.botId, botId),
          eq(botMemories.id, memoryId),
          access ? eq(botMemories.telegramId, access.userId!) : undefined,
          access
            ? access.includeUnscopedPersonal === false
              ? eq(botMemories.scopeChatId, access.chatId)
              : or(isNull(botMemories.scopeChatId), eq(botMemories.scopeChatId, access.chatId))
            : undefined,
        ),
      )
      .returning({ id: botMemories.id });
    return result.length > 0;
  }

  async getMemoriesForPrompt(
    botId: string,
    params: {
      telegramId?: number;
      scopeChatId?: number;
      includeUnscopedPersonal?: boolean;
      limit?: number;
    },
  ): Promise<BotMemory[]> {
    const limit = params.limit ?? 20;
    const conditions = [
      eq(botMemories.botId, botId),
      eq(botMemories.isActive, true),
      or(isNull(botMemories.expiresAt), gt(botMemories.expiresAt, new Date()))!,
      params.scopeChatId == null
        ? isNull(botMemories.scopeChatId)
        : or(isNull(botMemories.scopeChatId), eq(botMemories.scopeChatId, params.scopeChatId))!,
    ];
    if (params.telegramId != null) {
      conditions.push(
        or(
          isNull(botMemories.telegramId),
          and(
            eq(botMemories.telegramId, params.telegramId),
            params.includeUnscopedPersonal === false
              ? params.scopeChatId == null
                ? sql`1=0`
                : eq(botMemories.scopeChatId, params.scopeChatId)
              : undefined,
          ),
        )!,
      );
    } else {
      conditions.push(isNull(botMemories.telegramId));
    }

    const rows = await this.db
      .select()
      .from(botMemories)
      .where(and(...conditions))
      .orderBy(desc(botMemories.updatedAt))
      .limit(limit);

    return rows.map(toDto);
  }

  async getCategories(botId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ category: botMemories.category })
      .from(botMemories)
      .where(and(eq(botMemories.botId, botId), isNotNull(botMemories.category)));
    return rows.map((r) => r.category!).filter(Boolean);
  }

  /** Find memories similar to the given embedding (for deduplication). */
  async findSimilar(
    botId: string,
    embedding: number[],
    threshold: number,
    opts?: { telegramId?: number; scopeChatId?: number; limit?: number },
  ): Promise<Array<BotMemory & { distance: number }>> {
    const limit = opts?.limit ?? 5;
    const distance = cosineDistance(botMemories.embedding, embedding);
    const conditions = [
      eq(botMemories.botId, botId),
      eq(botMemories.isActive, true),
      or(isNull(botMemories.expiresAt), gt(botMemories.expiresAt, new Date()))!,
      isNotNull(botMemories.embedding),
      lt(distance, threshold),
      opts?.scopeChatId == null
        ? isNull(botMemories.scopeChatId)
        : eq(botMemories.scopeChatId, opts.scopeChatId),
    ];
    // Dedup only within the exact owner scope. General and personal facts must not collapse.
    if (opts?.telegramId != null) {
      conditions.push(eq(botMemories.telegramId, opts.telegramId));
    } else {
      conditions.push(isNull(botMemories.telegramId));
    }
    const rows = await this.db
      .select({
        row: botMemories,
        distance: distance.as("distance"),
      })
      .from(botMemories)
      .where(and(...conditions))
      .orderBy(distance)
      .limit(limit);

    return rows.map((r) => ({ ...toDto(r.row), distance: Number(r.distance) }));
  }

  /** Retire an active memory, optionally linking a successor in the same Bot. */
  async retireMemory(
    botId: string,
    memoryId: number,
    supersededById?: number,
    access?: BotMemoryAccess,
    expectedContent?: string,
  ): Promise<boolean> {
    if (supersededById === memoryId) return false;
    const updates: Partial<typeof botMemories.$inferInsert> = { isActive: false };
    if (supersededById != null) updates.supersededById = supersededById;
    const successorCondition =
      supersededById == null
        ? undefined
        : sql`exists (
            select 1 from bot_memories successor
            where successor.id = ${supersededById}
              and successor.bot_id = ${botId}
              and successor.is_active = true
              and successor.telegram_id is not distinct from ${botMemories.telegramId}
              and successor.scope_chat_id is not distinct from ${botMemories.scopeChatId}
          )`;
    const retired = await this.db
      .update(botMemories)
      .set(updates)
      .where(
        and(
          eq(botMemories.botId, botId),
          eq(botMemories.id, memoryId),
          eq(botMemories.isActive, true),
          expectedContent === undefined ? undefined : eq(botMemories.content, expectedContent),
          agentMutationScope(access),
          successorCondition,
        ),
      )
      .returning({ id: botMemories.id });
    return retired.length > 0;
  }

  /** Touch updatedAt of an existing memory (for dedup "seen again" scenario). */
  async touchMemory(memoryId: number): Promise<void> {
    await this.db
      .update(botMemories)
      .set({ updatedAt: new Date() })
      .where(eq(botMemories.id, memoryId));
  }
}
