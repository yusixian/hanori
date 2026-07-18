import type { Database } from "@cos-tool-bot/database";
import { botMemories } from "@cos-tool-bot/database";
import type { BotMemory } from "@cos-tool-bot/shared";
import {
  and,
  count,
  cosineDistance,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { escapeLike, rrfMerge } from "../utils/search.js";

function toDto(row: typeof botMemories.$inferSelect): BotMemory {
  return {
    id: row.id,
    botId: row.botId,
    telegramId: row.telegramId,
    content: row.content,
    category: row.category,
    factValidAt: row.factValidAt?.toISOString() ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? row.createdAt.toISOString(),
  };
}

export class BotMemoryStore {
  constructor(private db: Database) {}

  async saveMemory(
    botId: string,
    data: {
      content: string;
      category?: string;
      telegramId?: number;
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
      scope?: "general_only" | "user_only" | "all";
      limit?: number;
      queryEmbedding?: number[];
      maxDistance?: number;
    },
  ): Promise<BotMemory[]> {
    const limit = params.limit ?? 20;

    // Build shared scope/category filter conditions
    const buildConditions = () => {
      const conditions = [eq(botMemories.botId, botId), eq(botMemories.isActive, true)];

      const scope = params.scope ?? "all";
      if (scope === "general_only") {
        conditions.push(isNull(botMemories.telegramId));
      } else if (scope === "user_only") {
        if (params.telegramId != null) {
          conditions.push(eq(botMemories.telegramId, params.telegramId));
        } else {
          conditions.push(sql`1=0`);
        }
      } else if (scope === "all") {
        if (params.telegramId != null) {
          conditions.push(
            or(isNull(botMemories.telegramId), eq(botMemories.telegramId, params.telegramId))!,
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
    data: { content?: string; category?: string | null; telegramId?: number | null },
  ): Promise<BotMemory | null> {
    const updates: Partial<typeof botMemories.$inferInsert> = {};
    if (data.content !== undefined) updates.content = data.content;
    if (data.category !== undefined) updates.category = data.category;
    if (data.telegramId !== undefined) updates.telegramId = data.telegramId;

    const [updated] = await this.db
      .update(botMemories)
      .set(updates)
      .where(and(eq(botMemories.botId, botId), eq(botMemories.id, memoryId)))
      .returning();
    return updated ? toDto(updated) : null;
  }

  async updateEmbedding(memoryId: number, embedding: number[]): Promise<void> {
    await this.db.update(botMemories).set({ embedding }).where(eq(botMemories.id, memoryId));
  }

  async deleteMemory(botId: string, memoryId: number): Promise<boolean> {
    const result = await this.db
      .delete(botMemories)
      .where(and(eq(botMemories.botId, botId), eq(botMemories.id, memoryId)))
      .returning({ id: botMemories.id });
    return result.length > 0;
  }

  async getMemoriesForPrompt(
    botId: string,
    params: { telegramId?: number; limit?: number },
  ): Promise<BotMemory[]> {
    const limit = params.limit ?? 20;
    const conditions = [eq(botMemories.botId, botId), eq(botMemories.isActive, true)];
    if (params.telegramId != null) {
      conditions.push(
        or(isNull(botMemories.telegramId), eq(botMemories.telegramId, params.telegramId))!,
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
    opts?: { telegramId?: number; limit?: number },
  ): Promise<Array<BotMemory & { distance: number }>> {
    const limit = opts?.limit ?? 5;
    const distance = cosineDistance(botMemories.embedding, embedding);
    const conditions = [
      eq(botMemories.botId, botId),
      eq(botMemories.isActive, true),
      isNotNull(botMemories.embedding),
      lt(distance, threshold),
    ];
    // Scope: match general memories OR memories belonging to the same user
    if (opts?.telegramId != null) {
      conditions.push(
        or(isNull(botMemories.telegramId), eq(botMemories.telegramId, opts.telegramId))!,
      );
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

  /** Mark a memory as inactive (soft delete) and optionally point to its successor. */
  async deactivateMemory(memoryId: number, supersededById?: number): Promise<void> {
    const updates: Partial<typeof botMemories.$inferInsert> = { isActive: false };
    if (supersededById != null) updates.supersededById = supersededById;
    await this.db.update(botMemories).set(updates).where(eq(botMemories.id, memoryId));
  }

  /** Touch updatedAt of an existing memory (for dedup "seen again" scenario). */
  async touchMemory(memoryId: number): Promise<void> {
    await this.db
      .update(botMemories)
      .set({ updatedAt: new Date() })
      .where(eq(botMemories.id, memoryId));
  }
}
