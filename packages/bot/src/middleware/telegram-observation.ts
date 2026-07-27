import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { MiddlewareFn } from "grammy";
import type { Chat, ChatMember, Update } from "grammy/types";
import type { WrapperContext } from "../context.js";

export type TelegramGroupChatType = "group" | "supergroup";
export type TelegramBotMembershipStatus = ChatMember["status"];

interface TelegramObservationBase {
  /** Stable across retries of the same Telegram update. */
  idempotencyKey: string;
  botId: string;
  sourceUpdateId: number;
  /** Telegram event time in Unix seconds. */
  observedAt: number;
}

export interface TelegramChatObservation extends TelegramObservationBase {
  kind: "chat";
  chatId: number;
  chatType: TelegramGroupChatType;
  title: string;
  username?: string;
}

export interface TelegramBotMembershipObservation extends TelegramObservationBase {
  kind: "bot_membership";
  chatId: number;
  chatType: TelegramGroupChatType;
  previousStatus: TelegramBotMembershipStatus;
  status: TelegramBotMembershipStatus;
}

export interface TelegramChatMigrationObservation extends TelegramObservationBase {
  kind: "chat_migration";
  oldChatId: number;
  newChatId: number;
}

export interface TelegramObservationCallbacks {
  onChatObserved?: (observation: TelegramChatObservation) => void | Promise<void>;
  onBotMembershipObserved?: (observation: TelegramBotMembershipObservation) => void | Promise<void>;
  onChatMigrationObserved?: (observation: TelegramChatMigrationObservation) => void | Promise<void>;
}

type TelegramObservation =
  | TelegramChatObservation
  | TelegramBotMembershipObservation
  | TelegramChatMigrationObservation;

type OnLog = (entry: BotLogEntry) => void | Promise<void>;

export function isValidTelegramGroupChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}

function isGroupChat(chat: Chat): chat is Chat.GroupChat | Chat.SupergroupChat {
  return (
    (chat.type === "group" || chat.type === "supergroup") &&
    isValidTelegramGroupChatId(chat.id) &&
    typeof chat.title === "string"
  );
}

function getChatSource(update: Update): { chat: Chat; observedAt: number } | undefined {
  if (update.message) return { chat: update.message.chat, observedAt: update.message.date };
  if (update.edited_message) {
    return { chat: update.edited_message.chat, observedAt: update.edited_message.edit_date };
  }
  if (update.guest_message) {
    return { chat: update.guest_message.chat, observedAt: update.guest_message.date };
  }
  if (update.message_reaction) {
    return { chat: update.message_reaction.chat, observedAt: update.message_reaction.date };
  }
  if (update.message_reaction_count) {
    return {
      chat: update.message_reaction_count.chat,
      observedAt: update.message_reaction_count.date,
    };
  }
  if (update.my_chat_member) {
    return { chat: update.my_chat_member.chat, observedAt: update.my_chat_member.date };
  }
  if (update.chat_member) {
    return { chat: update.chat_member.chat, observedAt: update.chat_member.date };
  }
  if (update.chat_join_request) {
    return { chat: update.chat_join_request.chat, observedAt: update.chat_join_request.date };
  }
  if (update.chat_boost) {
    return { chat: update.chat_boost.chat, observedAt: update.chat_boost.boost.add_date };
  }
  if (update.removed_chat_boost) {
    return {
      chat: update.removed_chat_boost.chat,
      observedAt: update.removed_chat_boost.remove_date,
    };
  }
  return undefined;
}

function createIdempotencyKey(
  botId: string,
  updateId: number,
  kind: TelegramObservation["kind"],
  identity: string,
): string {
  return `${botId}:telegram:${updateId}:${kind}:${identity}`;
}

function projectChatObservation(
  update: Update,
  botId: string,
): TelegramChatObservation | undefined {
  const source = getChatSource(update);
  if (!source || !isGroupChat(source.chat) || !Number.isSafeInteger(source.observedAt)) {
    return undefined;
  }

  const { chat, observedAt } = source;
  const username = typeof chat.username === "string" ? chat.username : undefined;
  return {
    kind: "chat",
    idempotencyKey: createIdempotencyKey(botId, update.update_id, "chat", String(chat.id)),
    botId,
    sourceUpdateId: update.update_id,
    chatId: chat.id,
    chatType: chat.type,
    title: chat.title,
    ...(username ? { username } : {}),
    observedAt,
  };
}

function projectMembershipObservation(
  update: Update,
  botId: string,
): TelegramBotMembershipObservation | undefined {
  const membership = update.my_chat_member;
  if (!membership || !isGroupChat(membership.chat) || !Number.isSafeInteger(membership.date)) {
    return undefined;
  }

  const { chat } = membership;
  return {
    kind: "bot_membership",
    idempotencyKey: createIdempotencyKey(
      botId,
      update.update_id,
      "bot_membership",
      String(chat.id),
    ),
    botId,
    sourceUpdateId: update.update_id,
    chatId: chat.id,
    chatType: chat.type,
    previousStatus: membership.old_chat_member.status,
    status: membership.new_chat_member.status,
    observedAt: membership.date,
  };
}

function projectMigrationObservation(
  update: Update,
  botId: string,
): TelegramChatMigrationObservation | undefined {
  const message = update.message;
  if (!message || !Number.isSafeInteger(message.date)) return undefined;

  let oldChatId: unknown;
  let newChatId: unknown;
  if (message.chat.type === "group" && message.migrate_to_chat_id !== undefined) {
    oldChatId = message.chat.id;
    newChatId = message.migrate_to_chat_id;
  } else if (message.chat.type === "supergroup" && message.migrate_from_chat_id !== undefined) {
    oldChatId = message.migrate_from_chat_id;
    newChatId = message.chat.id;
  } else {
    return undefined;
  }

  if (
    !isValidTelegramGroupChatId(oldChatId) ||
    !isValidTelegramGroupChatId(newChatId) ||
    oldChatId === newChatId
  ) {
    return undefined;
  }

  return {
    kind: "chat_migration",
    // Telegram may emit the same migration once from each side. Deliberately
    // exclude update_id so consumers can deduplicate both forms by bot + edge.
    idempotencyKey: `${botId}:telegram:chat_migration:${oldChatId}:${newChatId}`,
    botId,
    sourceUpdateId: update.update_id,
    oldChatId,
    newChatId,
    observedAt: message.date,
  };
}

export function projectTelegramObservations(update: Update, botId: string): TelegramObservation[] {
  if (!Number.isSafeInteger(update.update_id)) return [];

  return [
    projectChatObservation(update, botId),
    projectMembershipObservation(update, botId),
    projectMigrationObservation(update, botId),
  ].filter((observation): observation is TelegramObservation => observation !== undefined);
}

async function reportCallbackFailure(
  onLog: OnLog | undefined,
  observation: TelegramObservation,
): Promise<void> {
  if (!onLog) return;

  try {
    await onLog({
      level: "error",
      message: "Failed to persist Telegram observation",
      meta: {
        botId: observation.botId,
        updateId: observation.sourceUpdateId,
        observationKind: observation.kind,
      },
    });
  } catch {
    // Observation and logging adapters are external seams. Neither may break update handling.
  }
}

async function dispatchObservation(
  callbacks: TelegramObservationCallbacks,
  observation: TelegramObservation,
): Promise<void> {
  if (observation.kind === "chat") {
    await callbacks.onChatObserved?.(observation);
  } else if (observation.kind === "bot_membership") {
    await callbacks.onBotMembershipObserved?.(observation);
  } else {
    await callbacks.onChatMigrationObserved?.(observation);
  }
}

export function createTelegramObservationMiddleware(
  botId: string,
  callbacks?: TelegramObservationCallbacks,
  onLog?: OnLog,
): MiddlewareFn<WrapperContext> {
  if (!callbacks) return (_ctx, next) => next();

  return async (ctx, next) => {
    for (const observation of projectTelegramObservations(ctx.update, botId)) {
      try {
        await dispatchObservation(callbacks, observation);
      } catch {
        await reportCallbackFailure(onLog, observation);
      }
    }
    await next();
  };
}
