import type { Database } from "@cos-tool-bot/database";
import { chatProviderOverrides } from "@cos-tool-bot/database";
import { and, eq } from "drizzle-orm";

export class ChatProviderStore {
  constructor(private db: Database) {}

  async loadOverrides(botId: string): Promise<Map<number, string>> {
    const rows = await this.db
      .select({
        chatId: chatProviderOverrides.chatId,
        providerId: chatProviderOverrides.providerId,
      })
      .from(chatProviderOverrides)
      .where(eq(chatProviderOverrides.botId, botId));

    const map = new Map<number, string>();
    for (const row of rows) {
      map.set(row.chatId, row.providerId);
    }
    return map;
  }

  async setOverride(botId: string, chatId: number, providerId: string): Promise<void> {
    await this.db
      .insert(chatProviderOverrides)
      .values({ botId, chatId, providerId })
      .onConflictDoUpdate({
        target: [chatProviderOverrides.botId, chatProviderOverrides.chatId],
        set: { providerId },
      });
  }

  async removeOverride(botId: string, chatId: number): Promise<void> {
    await this.db
      .delete(chatProviderOverrides)
      .where(and(eq(chatProviderOverrides.botId, botId), eq(chatProviderOverrides.chatId, chatId)));
  }

  /** Remove all overrides for a bot whose providerId is not in the allowed list. */
  async purgeInvalid(botId: string, validProviderIds: string[]): Promise<void> {
    const rows = await this.db
      .select({
        chatId: chatProviderOverrides.chatId,
        providerId: chatProviderOverrides.providerId,
      })
      .from(chatProviderOverrides)
      .where(eq(chatProviderOverrides.botId, botId));
    const valid = new Set(validProviderIds);
    for (const r of rows) {
      if (!valid.has(r.providerId)) {
        await this.removeOverride(botId, r.chatId);
      }
    }
  }
}
