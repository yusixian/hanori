import {
  parseConversationForwardOrigin,
  type ConversationForwardOrigin,
} from "@cos-tool-bot/shared";

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function userDisplayName(value: unknown): string {
  const user = objectRecord(value);
  if (!user) return "";
  return [stringField(user, "first_name"), stringField(user, "last_name")]
    .filter(Boolean)
    .join(" ");
}

function chatDisplayName(value: unknown): string {
  const chat = objectRecord(value);
  if (!chat) return "";
  return stringField(chat, "title") ?? userDisplayName(chat);
}

export function normalizeTelegramForwardOrigin(
  origin: unknown,
): ConversationForwardOrigin | undefined {
  const record = objectRecord(origin);
  if (!record) return undefined;

  switch (record["type"]) {
    case "user": {
      const sender = objectRecord(record["sender_user"]);
      return parseConversationForwardOrigin({
        type: record["type"],
        name: userDisplayName(sender),
        username: sender && stringField(sender, "username"),
      });
    }
    case "hidden_user":
      return parseConversationForwardOrigin({
        type: record["type"],
        name: stringField(record, "sender_user_name"),
      });
    case "chat": {
      const chat = objectRecord(record["sender_chat"]);
      return parseConversationForwardOrigin({
        type: record["type"],
        name: chatDisplayName(chat),
        username: chat && stringField(chat, "username"),
        authorSignature: stringField(record, "author_signature"),
      });
    }
    case "channel": {
      const chat = objectRecord(record["chat"]);
      return parseConversationForwardOrigin({
        type: record["type"],
        name: chat && stringField(chat, "title"),
        username: chat && stringField(chat, "username"),
        authorSignature: stringField(record, "author_signature"),
      });
    }
    default:
      return undefined;
  }
}
