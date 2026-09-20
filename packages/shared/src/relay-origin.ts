import type { ConversationRelayOrigin } from "./types.js";

export function parseConversationRelayOrigin(value: unknown): ConversationRelayOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = record["initiatorTelegramId"];
  if (
    record["source"] !== "cosinside" ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0
  )
    return undefined;
  const name = record["initiatorName"];
  return {
    source: "cosinside",
    initiatorTelegramId: id,
    initiatorName:
      typeof name === "string" && name.trim()
        ? name.trim().replace(/\s+/g, " ").slice(0, 256)
        : String(id),
  };
}

export function formatConversationRelayOrigin(value: ConversationRelayOrigin | undefined): string {
  const origin = parseConversationRelayOrigin(value);
  if (!origin) return "";
  return `[cosinside 代发：发起人 ${JSON.stringify(origin.initiatorName)}（Telegram ID: ${origin.initiatorTelegramId}）通过 bot 发送，非 AI 自主发言]`;
}
