import type { Database } from "@cos-tool-bot/database";
import {
  bots,
  miniAppChatGrants,
  miniAppOperatorGrants,
  telegramBotProfiles,
  telegramChats,
} from "@cos-tool-bot/database";
import { and, eq, isNull, lt, or } from "drizzle-orm";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TelegramChatType = "group" | "supergroup";
export type TelegramBotMembershipStatus =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked";

export interface TelegramBotProfileObservation {
  botId: string;
  telegramUserId: number;
  username: string;
  displayName: string;
  observedAt: Date;
}

export interface TelegramChatObservation {
  botId: string;
  chatId: number;
  type: TelegramChatType;
  title: string | null;
  username: string | null;
  observedAt: Date;
}

export interface TelegramBotMembershipObservation extends TelegramChatObservation {
  status: TelegramBotMembershipStatus | null;
}

export interface TelegramAccessSnapshot {
  botId: string;
  adminTelegramUserIds: number[];
  operatorTelegramUserIds: number[];
  grantedChatIds: number[];
}

function assertBotId(botId: string): void {
  if (!UUID_PATTERN.test(botId)) throw new TypeError("botId must be a UUID");
}

function isTelegramUserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function assertTelegramUserId(value: number, field: string): void {
  if (!isTelegramUserId(value)) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function isTelegramGroupId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value < 0;
}

function assertTelegramGroupId(value: number): void {
  if (!isTelegramGroupId(value)) {
    throw new TypeError("chatId must be a negative safe integer");
  }
}

function assertObservedAt(observedAt: Date): void {
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    throw new TypeError("observedAt must be a valid Date");
  }
}

function assertRequiredText(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertOptionalText(value: string | null, field: string): void {
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`${field} must be null or a non-empty string`);
  }
}

function validateChatObservation(input: TelegramChatObservation): void {
  assertBotId(input.botId);
  assertTelegramGroupId(input.chatId);
  if (input.type !== "group" && input.type !== "supergroup") {
    throw new TypeError("type must be group or supergroup");
  }
  assertOptionalText(input.title, "title");
  assertOptionalText(input.username, "username");
  assertObservedAt(input.observedAt);
}

function uniqueSorted(values: unknown[], predicate: (value: unknown) => value is number): number[] {
  return [...new Set(values.filter(predicate))].sort((a, b) => a - b);
}

export class TelegramDirectoryService {
  constructor(private readonly db: Database) {}

  async upsertBotProfile(input: TelegramBotProfileObservation): Promise<boolean> {
    assertBotId(input.botId);
    assertTelegramUserId(input.telegramUserId, "telegramUserId");
    assertRequiredText(input.username, "username");
    assertRequiredText(input.displayName, "displayName");
    assertObservedAt(input.observedAt);

    const rows = await this.db
      .insert(telegramBotProfiles)
      .values(input)
      .onConflictDoUpdate({
        target: telegramBotProfiles.botId,
        set: {
          telegramUserId: input.telegramUserId,
          username: input.username,
          displayName: input.displayName,
          observedAt: input.observedAt,
        },
        where: lt(telegramBotProfiles.observedAt, input.observedAt),
      })
      .returning({ botId: telegramBotProfiles.botId });
    return rows.length > 0;
  }

  async observeChat(input: TelegramChatObservation): Promise<boolean> {
    validateChatObservation(input);

    const rows = await this.db
      .insert(telegramChats)
      .values({
        botId: input.botId,
        chatId: input.chatId,
        type: input.type,
        title: input.title,
        username: input.username,
        lastObservedAt: input.observedAt,
      })
      .onConflictDoUpdate({
        target: [telegramChats.botId, telegramChats.chatId],
        set: {
          type: input.type,
          title: input.title,
          username: input.username,
          lastObservedAt: input.observedAt,
        },
        where: lt(telegramChats.lastObservedAt, input.observedAt),
      })
      .returning({ chatId: telegramChats.chatId });
    return rows.length > 0;
  }

  async observeBotMembership(
    input: TelegramBotMembershipObservation,
  ): Promise<{ chatObserved: boolean; membershipObserved: boolean }> {
    validateChatObservation(input);
    if (
      input.status !== null &&
      !["creator", "administrator", "member", "restricted", "left", "kicked"].includes(input.status)
    ) {
      throw new TypeError("status is not a supported Bot membership status");
    }

    const chatObserved = await this.observeChat(input);
    if (input.status === null) return { chatObserved, membershipObserved: false };

    const leftAt = input.status === "left" || input.status === "kicked" ? input.observedAt : null;
    const rows = await this.db
      .insert(telegramChats)
      .values({
        botId: input.botId,
        chatId: input.chatId,
        type: input.type,
        title: input.title,
        username: input.username,
        botMembershipStatus: input.status,
        membershipObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
        leftAt,
      })
      .onConflictDoUpdate({
        target: [telegramChats.botId, telegramChats.chatId],
        set: {
          botMembershipStatus: input.status,
          membershipObservedAt: input.observedAt,
          leftAt,
        },
        where: or(
          isNull(telegramChats.membershipObservedAt),
          lt(telegramChats.membershipObservedAt, input.observedAt),
        ),
      })
      .returning({ chatId: telegramChats.chatId });

    return { chatObserved, membershipObserved: rows.length > 0 };
  }

  async readAccessSnapshot(botId: string): Promise<TelegramAccessSnapshot | null> {
    assertBotId(botId);

    const [bot] = await this.db
      .select({ adminChatIds: bots.adminChatIds })
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
    if (!bot) return null;

    const [operators, chatGrants] = await Promise.all([
      this.db
        .select({ telegramUserId: miniAppOperatorGrants.telegramUserId })
        .from(miniAppOperatorGrants)
        .where(eq(miniAppOperatorGrants.botId, botId)),
      this.db
        .select({ chatId: miniAppChatGrants.chatId })
        .from(miniAppChatGrants)
        .where(eq(miniAppChatGrants.botId, botId)),
    ]);

    return {
      botId,
      adminTelegramUserIds: uniqueSorted(bot.adminChatIds, isTelegramUserId),
      operatorTelegramUserIds: uniqueSorted(
        operators.map((row) => row.telegramUserId),
        isTelegramUserId,
      ),
      grantedChatIds: uniqueSorted(
        chatGrants.map((row) => row.chatId),
        isTelegramGroupId,
      ),
    };
  }
}
