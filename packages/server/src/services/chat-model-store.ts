import type { Database } from "@cos-tool-bot/database";
import { chatModelOverrides } from "@cos-tool-bot/database";
import { and, eq } from "drizzle-orm";

export class ChatModelStore {
  constructor(private db: Database) {}

  async loadOverrides(botId: string): Promise<Map<number, string>> {
    const rows = await this.db
      .select({ chatId: chatModelOverrides.chatId, modelId: chatModelOverrides.modelId })
      .from(chatModelOverrides)
      .where(eq(chatModelOverrides.botId, botId));

    const map = new Map<number, string>();
    for (const row of rows) {
      map.set(row.chatId, row.modelId);
    }
    return map;
  }

  async setOverride(botId: string, chatId: number, modelId: string): Promise<void> {
    await this.db
      .insert(chatModelOverrides)
      .values({ botId, chatId, modelId })
      .onConflictDoUpdate({
        target: [chatModelOverrides.botId, chatModelOverrides.chatId],
        set: { modelId },
      });
  }

  async removeOverride(botId: string, chatId: number): Promise<void> {
    await this.db
      .delete(chatModelOverrides)
      .where(and(eq(chatModelOverrides.botId, botId), eq(chatModelOverrides.chatId, chatId)));
  }
}
