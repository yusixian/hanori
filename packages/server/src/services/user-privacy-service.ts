import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@cos-tool-bot/database";
import {
  botMemories,
  conversationCompactionState,
  conversationMessages,
  engagementSamples,
  generationCharacters,
  peopleProfiles,
  settings,
  userPrivacySettings,
} from "@cos-tool-bot/database";
import {
  UserPrivacyBusyError,
  type EngagementContextMessage,
  type UserPrivacyMode,
} from "@cos-tool-bot/shared";
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
  private readonly heldLocks = new AsyncLocalStorage<
    ReadonlyMap<string, { botId: string; userId: number; active: boolean }>
  >();
  private readonly contextResetAt = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly now = () => Date.now(),
  ) {}

  runExclusive<T>(botId: string, userId: number, operation: () => Promise<T>): Promise<T> {
    const key = `${botId}:${userId}`;
    return this.lock.run(key, async () => {
      const lease = { botId, userId, active: true };
      const held = new Map(this.heldLocks.getStore());
      held.set(key, lease);
      try {
        return await this.heldLocks.run(held, operation);
      } finally {
        // Detached descendants must never treat an already released lock as owned.
        lease.active = false;
      }
    });
  }

  /** Library tools can execute inside an AI turn which already owns the caller's lock. */
  runLibraryExclusiveMany<T>(
    botId: string,
    userIds: readonly number[],
    operation: () => Promise<T>,
    options: { waitIfBusy?: boolean } = {},
  ): Promise<T> {
    const held = this.heldLocks.getStore();
    const missing = [...new Set(userIds)]
      .filter((id) => !held?.get(`${botId}:${id}`)?.active)
      .sort((a, b) => a - b);
    const owned = [...(held?.values() ?? [])].filter(
      (lease) => lease.active && lease.botId === botId,
    );
    const acquire = (index: number): Promise<T> => {
      const id = missing[index];
      if (id === undefined) return operation();
      // A free inverse lock can be reserved synchronously. Never wait on an inverse
      // acquisition: another turn could be holding it while waiting on ours.
      if (
        (options.waitIfBusy === false || owned.some((lease) => id < lease.userId)) &&
        this.lock.isLocked(`${botId}:${id}`)
      ) {
        return Promise.reject(
          new UserPrivacyBusyError(
            "This user's library is busy; retry or manage it from the panel",
          ),
        );
      }
      return this.runExclusive(botId, id, () => acquire(index + 1));
    };
    return acquire(0);
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

  async getQuoteResetAt(botId: string, userId: number): Promise<number | undefined> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, `quote-reset:${botId}:${userId}`))
      .limit(1);
    const value = row ? Number(row.value) : undefined;
    return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private async clearQuoteSources(
    botId: string,
    userId: number,
    db: Pick<Database, "insert" | "update"> = this.db,
  ): Promise<void> {
    await db
      .update(conversationMessages)
      .set({ meta: sql`(${conversationMessages.meta}::jsonb - 'quoteSource')::json` })
      .where(
        and(
          eq(conversationMessages.botId, botId),
          sql`${conversationMessages.meta}::jsonb ? 'quoteSource'`,
          sql`(${conversationMessages.meta}->'quoteSource'->'privacyUserIds')::jsonb @> jsonb_build_array(${userId}::bigint)`,
        ),
      );
    const key = `quote-reset:${botId}:${userId}`,
      value = String(this.now());
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
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
    const writeMode = async (db: Pick<Database, "insert">) => {
      await db
        .insert(userPrivacySettings)
        .values({ botId, userId, mode })
        .onConflictDoUpdate({
          target: [userPrivacySettings.botId, userPrivacySettings.userId],
          set: { mode, updatedAt: new Date() },
        });
    };
    if (mode === "off") {
      await this.db.transaction(async (tx) => {
        await writeMode(tx);
        await this.clearQuoteSources(botId, userId, tx);
      });
      this.recordContextReset(botId, userId);
    } else await writeMode(this.db);
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

      await this.clearQuoteSources(botId, userId, tx);

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

      // Character bindings cascade, including bindings made by other people to this OC.
      await tx
        .delete(generationCharacters)
        .where(
          and(
            eq(generationCharacters.botId, botId),
            eq(generationCharacters.source, "original"),
            eq(generationCharacters.ownerTelegramId, userId),
          ),
        )
        .returning({ id: generationCharacters.id });

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
