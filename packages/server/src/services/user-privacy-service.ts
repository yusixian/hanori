import type { Database } from "@cos-tool-bot/database";
import {
  botMemories,
  conversationCompactionState,
  conversationMessages,
  peopleProfiles,
  userPrivacySettings,
} from "@cos-tool-bot/database";
import type { UserPrivacyMode } from "@cos-tool-bot/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

const PRIVACY_MODES = new Set<UserPrivacyMode>(["normal", "isolated", "off"]);

export interface ForgetUserDataResult {
  conversationMessages: number;
  profiles: number;
  personalMemories: number;
}

export class UserPrivacyService {
  private readonly lock = new KeyedAsyncLock();

  constructor(private readonly db: Database) {}

  runExclusive<T>(botId: string, userId: number, operation: () => Promise<T>): Promise<T> {
    return this.lock.run(`${botId}:${userId}`, operation);
  }

  async getMode(botId: string, userId: number): Promise<UserPrivacyMode> {
    const [row] = await this.db
      .select({ mode: userPrivacySettings.mode })
      .from(userPrivacySettings)
      .where(and(eq(userPrivacySettings.botId, botId), eq(userPrivacySettings.userId, userId)))
      .limit(1);
    return row && PRIVACY_MODES.has(row.mode as UserPrivacyMode)
      ? (row.mode as UserPrivacyMode)
      : "normal";
  }

  async setMode(botId: string, userId: number, mode: UserPrivacyMode): Promise<void> {
    await this.db
      .insert(userPrivacySettings)
      .values({ botId, userId, mode })
      .onConflictDoUpdate({
        target: [userPrivacySettings.botId, userPrivacySettings.userId],
        set: { mode, updatedAt: new Date() },
      });
  }

  async getAvatarPaths(botId: string, userId: number): Promise<string[]> {
    const profiles = await this.db
      .select({ avatarPath: peopleProfiles.avatarPath })
      .from(peopleProfiles)
      .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.telegramId, userId)));
    return profiles
      .map((profile) => profile.avatarPath)
      .filter((avatarPath): avatarPath is string => !!avatarPath);
  }

  async forget(botId: string, userId: number): Promise<ForgetUserDataResult> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(userPrivacySettings)
        .values({ botId, userId, mode: "off" })
        .onConflictDoUpdate({
          target: [userPrivacySettings.botId, userPrivacySettings.userId],
          set: { mode: "off", updatedAt: new Date() },
        });

      const affectedChats = await tx
        .selectDistinct({ chatId: conversationMessages.chatId })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            or(eq(conversationMessages.userId, userId), eq(conversationMessages.chatId, userId)),
          ),
        );

      const deletedMessages = await tx
        .delete(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            or(eq(conversationMessages.userId, userId), eq(conversationMessages.chatId, userId)),
          ),
        )
        .returning({ id: conversationMessages.id });

      if (affectedChats.length > 0) {
        await tx.delete(conversationCompactionState).where(
          and(
            eq(conversationCompactionState.botId, botId),
            inArray(
              conversationCompactionState.chatId,
              affectedChats.map((row) => row.chatId),
            ),
          ),
        );
      }

      const deletedProfiles = await tx
        .delete(peopleProfiles)
        .where(and(eq(peopleProfiles.botId, botId), eq(peopleProfiles.telegramId, userId)))
        .returning({ id: peopleProfiles.id });

      const deletedMemories = await tx
        .delete(botMemories)
        .where(and(eq(botMemories.botId, botId), eq(botMemories.telegramId, userId)))
        .returning({ id: botMemories.id });

      return {
        conversationMessages: deletedMessages.length,
        profiles: deletedProfiles.length,
        personalMemories: deletedMemories.length,
      };
    });
  }
}
