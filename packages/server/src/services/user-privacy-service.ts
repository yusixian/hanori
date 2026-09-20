import type { Database } from "@cos-tool-bot/database";
import {
  botMemories,
  conversationCompactionState,
  conversationMessages,
  engagementSamples,
  peopleProfiles,
  userPrivacySettings,
} from "@cos-tool-bot/database";
import type { EngagementContextMessage, UserPrivacyMode } from "@cos-tool-bot/shared";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

const PRIVACY_MODES = new Set<UserPrivacyMode>(["normal", "isolated", "off"]);

export interface ForgetUserDataResult {
  conversationMessages: number;
  profiles: number;
  personalMemories: number;
}

export class UserPrivacyService {
  private readonly lock = new KeyedAsyncLock();
  private readonly contextResetAt = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly now = () => Date.now(),
  ) {}

  runExclusive<T>(botId: string, userId: number, operation: () => Promise<T>): Promise<T> {
    return this.lock.run(`${botId}:${userId}`, operation);
  }

  runExclusiveMany<T>(
    botId: string,
    userIds: readonly number[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const sortedUserIds = [
      ...new Set(userIds.filter((userId) => Number.isSafeInteger(userId) && userId > 0)),
    ].sort((left, right) => left - right);
    const acquire = (index: number): Promise<T> => {
      const userId = sortedUserIds[index];
      if (userId === undefined) return operation();
      return this.runExclusive(botId, userId, () => acquire(index + 1));
    };
    return acquire(0);
  }

  getContextResetAt(botId: string, userId: number): number | undefined {
    return this.contextResetAt.get(`${botId}:${userId}`);
  }

  async runWithEngagementContextPrivacy<T>(
    botId: string,
    context: readonly EngagementContextMessage[],
    operation: (allowedContext: EngagementContextMessage[]) => Promise<T>,
  ): Promise<T> {
    const privacyUserIds = [
      ...new Set(context.flatMap((message) => engagementContextUserIds(message))),
    ].sort((left, right) => left - right);
    return this.runExclusiveMany(botId, privacyUserIds, async () => {
      const privacyByUser = new Map(
        await Promise.all(
          privacyUserIds.map(async (userId) => {
            try {
              return [
                userId,
                {
                  mode: await this.getMode(botId, userId),
                  resetAt: this.getContextResetAt(botId, userId),
                },
              ] as const;
            } catch {
              return [userId, { mode: "off" as const, resetAt: undefined }] as const;
            }
          }),
        ),
      );
      return operation(
        context.filter((message) =>
          engagementContextUserIds(message).every((userId) => {
            const privacy = privacyByUser.get(userId);
            const privacyCapturedAt = message.privacyCapturedAt ?? message.timestamp;
            return (
              privacy?.mode !== "off" &&
              (privacy?.resetAt === undefined || privacyCapturedAt > privacy.resetAt)
            );
          }),
        ),
      );
    });
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
    if (mode === "off") this.recordContextReset(botId, userId);
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
    const result = await this.db.transaction(async (tx) => {
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

      const privacyUserIds = JSON.stringify([userId]);
      await tx
        .update(engagementSamples)
        .set({ context: null, contextPurgedAt: new Date(this.now()) })
        .where(
          and(
            eq(engagementSamples.botId, botId),
            isNotNull(engagementSamples.context),
            sql`exists (
              select 1
              from jsonb_array_elements(${engagementSamples.context}::jsonb) as message
              where (
                jsonb_typeof(message->'privacyUserIds') = 'array'
                and message->'privacyUserIds' @> ${privacyUserIds}::jsonb
              ) or (
                not (message ? 'privacyUserIds')
                and coalesce(message->>'isBot', 'false') <> 'true'
                and jsonb_typeof(message->'userId') = 'number'
                and (message->>'userId')::bigint = ${userId}
              )
            )`,
          ),
        );

      return {
        conversationMessages: deletedMessages.length,
        profiles: deletedProfiles.length,
        personalMemories: deletedMemories.length,
      };
    });
    this.recordContextReset(botId, userId);
    return result;
  }

  private recordContextReset(botId: string, userId: number): void {
    this.contextResetAt.set(`${botId}:${userId}`, this.now());
  }
}

export function engagementContextUserIds(message: EngagementContextMessage): number[] {
  if (message.privacyUserIds !== undefined) {
    return [
      ...new Set(
        message.privacyUserIds.filter((userId) => Number.isSafeInteger(userId) && userId > 0),
      ),
    ];
  }
  return !message.isBot && Number.isSafeInteger(message.userId) && message.userId > 0
    ? [message.userId]
    : [];
}
