import type { Database } from "@cos-tool-bot/database";
import {
  miniAppAuditEvents,
  miniAppChatGrants,
  miniAppOperatorGrants,
  peopleProfiles,
  telegramBotProfiles,
  telegramChats,
} from "@cos-tool-bot/database";
import { and, desc, eq, gte, ilike, or } from "drizzle-orm";
import { escapeLike } from "../utils/search.js";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

export type MiniAppAccessErrorCode =
  | "bot_admin_required"
  | "conflict"
  | "not_found"
  | "verification_unavailable";

export class MiniAppAccessError extends Error {
  constructor(
    readonly code: MiniAppAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MiniAppAccessError";
  }
}

export interface TelegramBotMembershipReader {
  getBotMembership(input: {
    botId: string;
    chatId: number;
  }): Promise<"creator" | "administrator" | "member" | "restricted" | "left" | "kicked">;
}

export interface MiniAppAuditFilters {
  actorTelegramUserId?: number;
  action?: string;
  resource?: string;
}

export interface MiniAppGrantInput {
  botId: string;
  actorTelegramUserId: number;
  chatId: number;
  note: string | null;
}

export interface MiniAppOperatorGrantInput {
  botId: string;
  actorTelegramUserId: number;
  telegramUserId: number;
  note: string | null;
}

function iso(value: Date): string {
  return value.toISOString();
}

function nullableIso(value: Date | null): string | null {
  return value ? iso(value) : null;
}

export class MiniAppAccessService {
  constructor(
    private readonly db: Database,
    private readonly membershipReader: TelegramBotMembershipReader,
    private readonly now = () => new Date(),
  ) {}

  async readAccess(botId: string, filters: MiniAppAuditFilters = {}) {
    const auditConditions = [
      eq(miniAppAuditEvents.botId, botId),
      gte(miniAppAuditEvents.createdAt, new Date(this.now().getTime() - NINETY_DAYS_MS)),
    ];
    if (filters.actorTelegramUserId !== undefined) {
      auditConditions.push(eq(miniAppAuditEvents.actorTelegramUserId, filters.actorTelegramUserId));
    }
    if (filters.action) auditConditions.push(eq(miniAppAuditEvents.action, filters.action));
    if (filters.resource) {
      auditConditions.push(
        or(
          eq(miniAppAuditEvents.resourceType, filters.resource),
          eq(miniAppAuditEvents.resourceId, filters.resource),
        )!,
      );
    }

    const [botRows, chatRows, operatorRows, activityRows] = await Promise.all([
      this.db
        .select({
          username: telegramBotProfiles.username,
          displayName: telegramBotProfiles.displayName,
        })
        .from(telegramBotProfiles)
        .where(eq(telegramBotProfiles.botId, botId)),
      this.db
        .select({
          chatId: telegramChats.chatId,
          type: telegramChats.type,
          title: telegramChats.title,
          username: telegramChats.username,
          botMembershipStatus: telegramChats.botMembershipStatus,
          membershipObservedAt: telegramChats.membershipObservedAt,
          lastObservedAt: telegramChats.lastObservedAt,
          leftAt: telegramChats.leftAt,
          grantCreatedBy: miniAppChatGrants.createdBy,
          grantNote: miniAppChatGrants.note,
          grantCreatedAt: miniAppChatGrants.createdAt,
        })
        .from(telegramChats)
        .leftJoin(
          miniAppChatGrants,
          and(
            eq(miniAppChatGrants.botId, telegramChats.botId),
            eq(miniAppChatGrants.chatId, telegramChats.chatId),
          ),
        )
        .where(eq(telegramChats.botId, botId))
        .orderBy(desc(telegramChats.lastObservedAt)),
      this.db
        .select({
          telegramUserId: miniAppOperatorGrants.telegramUserId,
          username: peopleProfiles.username,
          displayName: peopleProfiles.displayName,
          createdBy: miniAppOperatorGrants.createdBy,
          note: miniAppOperatorGrants.note,
          createdAt: miniAppOperatorGrants.createdAt,
        })
        .from(miniAppOperatorGrants)
        .leftJoin(
          peopleProfiles,
          and(
            eq(peopleProfiles.botId, miniAppOperatorGrants.botId),
            eq(peopleProfiles.telegramId, miniAppOperatorGrants.telegramUserId),
          ),
        )
        .where(eq(miniAppOperatorGrants.botId, botId))
        .orderBy(desc(miniAppOperatorGrants.createdAt)),
      this.db
        .select({
          id: miniAppAuditEvents.id,
          actorTelegramUserId: miniAppAuditEvents.actorTelegramUserId,
          actorRole: miniAppAuditEvents.actorRole,
          action: miniAppAuditEvents.action,
          resourceType: miniAppAuditEvents.resourceType,
          resourceId: miniAppAuditEvents.resourceId,
          outcome: miniAppAuditEvents.outcome,
          createdAt: miniAppAuditEvents.createdAt,
        })
        .from(miniAppAuditEvents)
        .where(and(...auditConditions))
        .orderBy(desc(miniAppAuditEvents.createdAt))
        .limit(100),
    ]);

    const bot = botRows[0];
    return {
      bot: {
        username: bot?.username ?? "",
        displayName: bot?.displayName ?? "",
      },
      chats: chatRows.map((row) => ({
        chatId: row.chatId,
        type: row.type as "group" | "supergroup",
        title: row.title,
        username: row.username,
        botMembershipStatus: row.botMembershipStatus,
        membershipObservedAt: row.membershipObservedAt
          ? nullableIso(row.membershipObservedAt)
          : null,
        lastObservedAt: iso(row.lastObservedAt),
        leftAt: nullableIso(row.leftAt),
        granted: row.grantCreatedAt !== null,
        grant:
          row.grantCreatedAt === null || row.grantCreatedBy === null
            ? null
            : {
                createdBy: row.grantCreatedBy,
                note: row.grantNote,
                createdAt: iso(row.grantCreatedAt),
              },
      })),
      operators: operatorRows.map((row) => ({
        telegramUserId: row.telegramUserId,
        username: row.username,
        displayName: row.displayName,
        verified: row.username !== null || row.displayName !== null,
        createdBy: row.createdBy,
        note: row.note,
        createdAt: iso(row.createdAt),
      })),
      activity: activityRows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
    };
  }

  async searchPeople(botId: string, rawQuery: string) {
    const query = rawQuery.trim().replace(/^@/, "");
    if (query.length < 2 || query.length > 64) return [];
    const pattern = `%${escapeLike(query)}%`;
    const telegramUserId = /^\d+$/.test(query) ? Number(query) : null;
    const matches = [
      ilike(peopleProfiles.username, pattern),
      ilike(peopleProfiles.displayName, pattern),
    ];
    if (telegramUserId !== null && Number.isSafeInteger(telegramUserId) && telegramUserId > 0) {
      matches.push(eq(peopleProfiles.telegramId, telegramUserId));
    }
    const rows = await this.db
      .select({
        telegramUserId: peopleProfiles.telegramId,
        username: peopleProfiles.username,
        displayName: peopleProfiles.displayName,
        lastSeen: peopleProfiles.lastSeen,
      })
      .from(peopleProfiles)
      .where(and(eq(peopleProfiles.botId, botId), or(...matches)))
      .orderBy(desc(peopleProfiles.lastSeen))
      .limit(20);
    return rows.map((row) => ({ ...row, lastSeen: iso(row.lastSeen) }));
  }

  async grantChat(input: MiniAppGrantInput): Promise<void> {
    const [candidate] = await this.db
      .select({ chatId: telegramChats.chatId })
      .from(telegramChats)
      .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.chatId)));
    if (!candidate) throw new MiniAppAccessError("not_found", "Chat was not observed by this Bot");

    let membership: Awaited<ReturnType<TelegramBotMembershipReader["getBotMembership"]>>;
    try {
      membership = await this.membershipReader.getBotMembership({
        botId: input.botId,
        chatId: input.chatId,
      });
    } catch {
      throw new MiniAppAccessError(
        "verification_unavailable",
        "Current Bot administrator status could not be verified",
      );
    }
    if (membership !== "creator" && membership !== "administrator") {
      throw new MiniAppAccessError(
        "bot_admin_required",
        "The Bot must currently be an administrator of this group",
      );
    }

    const observedAt = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(telegramChats)
        .set({ botMembershipStatus: membership, membershipObservedAt: observedAt, leftAt: null })
        .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.chatId)));
      const inserted = await tx
        .insert(miniAppChatGrants)
        .values({
          botId: input.botId,
          chatId: input.chatId,
          createdBy: input.actorTelegramUserId,
          note: input.note,
          createdAt: observedAt,
        })
        .onConflictDoNothing()
        .returning({ chatId: miniAppChatGrants.chatId });
      if (inserted.length === 0) {
        throw new MiniAppAccessError("conflict", "Chat is already granted");
      }
      await tx.insert(miniAppAuditEvents).values({
        botId: input.botId,
        actorTelegramUserId: input.actorTelegramUserId,
        actorRole: "admin",
        capability: "access.manage",
        action: "access.chat-grant.created",
        resourceType: "chat",
        resourceId: String(input.chatId),
        previousSummary: null,
        nextSummary: { hasNote: input.note !== null },
        outcome: "succeeded",
        createdAt: observedAt,
      });
    });
  }

  async revokeChat(input: Omit<MiniAppGrantInput, "note">): Promise<void> {
    const createdAt = this.now();
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(miniAppChatGrants)
        .where(
          and(eq(miniAppChatGrants.botId, input.botId), eq(miniAppChatGrants.chatId, input.chatId)),
        )
        .returning({ note: miniAppChatGrants.note });
      if (removed.length === 0) {
        throw new MiniAppAccessError("not_found", "Chat grant was not found");
      }
      await tx.insert(miniAppAuditEvents).values({
        botId: input.botId,
        actorTelegramUserId: input.actorTelegramUserId,
        actorRole: "admin",
        capability: "access.manage",
        action: "access.chat-grant.deleted",
        resourceType: "chat",
        resourceId: String(input.chatId),
        previousSummary: { hadNote: removed[0]!.note !== null },
        nextSummary: null,
        outcome: "succeeded",
        createdAt,
      });
    });
  }

  async grantOperator(input: MiniAppOperatorGrantInput): Promise<void> {
    const createdAt = this.now();
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(miniAppOperatorGrants)
        .values({
          botId: input.botId,
          telegramUserId: input.telegramUserId,
          createdBy: input.actorTelegramUserId,
          note: input.note,
          createdAt,
        })
        .onConflictDoNothing()
        .returning({ telegramUserId: miniAppOperatorGrants.telegramUserId });
      if (inserted.length === 0) {
        throw new MiniAppAccessError("conflict", "Operator is already granted");
      }
      const [profile] = await tx
        .select({ telegramUserId: peopleProfiles.telegramId })
        .from(peopleProfiles)
        .where(
          and(
            eq(peopleProfiles.botId, input.botId),
            eq(peopleProfiles.telegramId, input.telegramUserId),
          ),
        );
      await tx.insert(miniAppAuditEvents).values({
        botId: input.botId,
        actorTelegramUserId: input.actorTelegramUserId,
        actorRole: "admin",
        capability: "access.manage",
        action: "access.operator-grant.created",
        resourceType: "telegram-user",
        resourceId: String(input.telegramUserId),
        previousSummary: null,
        nextSummary: { profileVerified: profile !== undefined, hasNote: input.note !== null },
        outcome: "succeeded",
        createdAt,
      });
    });
  }

  async revokeOperator(input: Omit<MiniAppOperatorGrantInput, "note">): Promise<void> {
    const createdAt = this.now();
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(miniAppOperatorGrants)
        .where(
          and(
            eq(miniAppOperatorGrants.botId, input.botId),
            eq(miniAppOperatorGrants.telegramUserId, input.telegramUserId),
          ),
        )
        .returning({ note: miniAppOperatorGrants.note });
      if (removed.length === 0) {
        throw new MiniAppAccessError("not_found", "Operator grant was not found");
      }
      await tx.insert(miniAppAuditEvents).values({
        botId: input.botId,
        actorTelegramUserId: input.actorTelegramUserId,
        actorRole: "admin",
        capability: "access.manage",
        action: "access.operator-grant.deleted",
        resourceType: "telegram-user",
        resourceId: String(input.telegramUserId),
        previousSummary: { hadNote: removed[0]!.note !== null },
        nextSummary: null,
        outcome: "succeeded",
        createdAt,
      });
    });
  }
}
