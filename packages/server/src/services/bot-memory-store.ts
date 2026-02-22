import type { Database } from "@cos-tool-bot/database";
import { botMemories } from "@cos-tool-bot/database";
import type { BotMemory } from "@cos-tool-bot/shared";
import { and, count, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

function toDto(row: typeof botMemories.$inferSelect): BotMemory {
  return {
    id: row.id,
    botId: row.botId,
    telegramId: row.telegramId,
    content: row.content,
    category: row.category,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? row.createdAt.toISOString(),
  };
}

export class BotMemoryStore {
  constructor(private db: Database) {}

  async saveMemory(
    botId: string,
    data: { content: string; category?: string; telegramId?: number },
  ): Promise<BotMemory> {
    const [created] = await this.db
      .insert(botMemories)
      .values({
        botId,
        content: data.content,
        category: data.category,
        telegramId: data.telegramId,
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
    },
  ): Promise<BotMemory[]> {
    const conditions = [eq(botMemories.botId, botId)];

    // Scope filtering
    const scope = params.scope ?? "all";
    if (scope === "general_only") {
      conditions.push(isNull(botMemories.telegramId));
    } else if (scope === "user_only") {
      if (params.telegramId != null) {
        conditions.push(eq(botMemories.telegramId, params.telegramId));
      } else {
        conditions.push(sql`1=0`);
      }
    } else if (scope === "all" && params.telegramId != null) {
      conditions.push(
        or(isNull(botMemories.telegramId), eq(botMemories.telegramId, params.telegramId))!,
      );
    }

    if (params.category) {
      conditions.push(eq(botMemories.category, params.category));
    }

    if (params.query) {
      conditions.push(ilike(botMemories.content, `%${escapeLike(params.query)}%`));
    }

    const rows = await this.db
      .select()
      .from(botMemories)
      .where(and(...conditions))
      .orderBy(desc(botMemories.updatedAt))
      .limit(params.limit ?? 20);

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

  async deleteMemory(botId: string, memoryId: number): Promise<boolean> {
    const result = await this.db
      .delete(botMemories)
      .where(and(eq(botMemories.botId, botId), eq(botMemories.id, memoryId)))
      .returning({ id: botMemories.id });
    return result.length > 0;
  }

  async getMemoriesForPrompt(botId: string, telegramId?: number, limit = 20): Promise<BotMemory[]> {
    const conditions = [eq(botMemories.botId, botId)];
    if (telegramId != null) {
      conditions.push(or(isNull(botMemories.telegramId), eq(botMemories.telegramId, telegramId))!);
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
}
