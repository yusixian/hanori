import type { Database } from "@cos-tool-bot/database";
import { summaryConfigs } from "@cos-tool-bot/database";
import type { SummaryAccessMode, SummaryConfigRecord } from "@cos-tool-bot/shared";
import { and, eq } from "drizzle-orm";

function toRecord(r: typeof summaryConfigs.$inferSelect): SummaryConfigRecord {
  return {
    id: r.id,
    botId: r.botId,
    chatId: r.chatId,
    isActive: r.isActive,
    scheduleHour: r.scheduleHour,
    scheduleMinute: r.scheduleMinute,
    windowHours: r.windowHours,
    customPrompt: r.customPrompt,
    modelId: r.modelId,
    maxMessages: r.maxMessages,
    cooldownSeconds: r.cooldownSeconds,
    accessMode: r.accessMode as SummaryAccessMode,
    lastScheduledAt: r.lastScheduledAt?.toISOString() ?? null,
    lastManualAt: r.lastManualAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? r.createdAt.toISOString(),
  };
}

export class SummaryConfigService {
  constructor(private db: Database) {}

  async list(botId: string): Promise<SummaryConfigRecord[]> {
    const rows = await this.db.select().from(summaryConfigs).where(eq(summaryConfigs.botId, botId));
    return rows.map(toRecord);
  }

  async get(id: number): Promise<SummaryConfigRecord | null> {
    const [row] = await this.db.select().from(summaryConfigs).where(eq(summaryConfigs.id, id));
    return row ? toRecord(row) : null;
  }

  async getByChat(botId: string, chatId: number): Promise<SummaryConfigRecord | null> {
    const [row] = await this.db
      .select()
      .from(summaryConfigs)
      .where(and(eq(summaryConfigs.botId, botId), eq(summaryConfigs.chatId, chatId)));
    return row ? toRecord(row) : null;
  }

  async create(params: {
    botId: string;
    chatId: number;
    isActive?: boolean;
    scheduleHour?: number | null;
    scheduleMinute?: number | null;
    windowHours?: number;
    customPrompt?: string | null;
    modelId?: string | null;
    maxMessages?: number | null;
    cooldownSeconds?: number | null;
    accessMode?: SummaryAccessMode;
  }): Promise<SummaryConfigRecord> {
    const [row] = await this.db
      .insert(summaryConfigs)
      .values({
        botId: params.botId,
        chatId: params.chatId,
        isActive: params.isActive ?? true,
        scheduleHour: params.scheduleHour ?? null,
        scheduleMinute: params.scheduleMinute ?? null,
        windowHours: params.windowHours ?? 24,
        customPrompt: params.customPrompt ?? null,
        modelId: params.modelId ?? null,
        maxMessages: params.maxMessages ?? null,
        cooldownSeconds: params.cooldownSeconds ?? null,
        accessMode: params.accessMode ?? "all",
      })
      .returning();
    return toRecord(row!);
  }

  async update(
    id: number,
    updates: Partial<{
      isActive: boolean;
      scheduleHour: number | null;
      scheduleMinute: number | null;
      windowHours: number;
      customPrompt: string | null;
      modelId: string | null;
      maxMessages: number | null;
      cooldownSeconds: number | null;
      accessMode: SummaryAccessMode;
    }>,
  ): Promise<SummaryConfigRecord | null> {
    const [row] = await this.db
      .update(summaryConfigs)
      .set(updates)
      .where(eq(summaryConfigs.id, id))
      .returning();
    return row ? toRecord(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const deleted = await this.db
      .delete(summaryConfigs)
      .where(eq(summaryConfigs.id, id))
      .returning({ id: summaryConfigs.id });
    return deleted.length > 0;
  }
}
