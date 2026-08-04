import type { ConversationForwardOrigin } from "./types.js";

function compactText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compacted = value.trim().replace(/\s+/g, " ");
  return compacted || undefined;
}

function compactUsername(value: unknown): string | undefined {
  return compactText(value)?.replace(/^@+/, "") || undefined;
}

export function parseConversationForwardOrigin(
  value: unknown,
): ConversationForwardOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = compactText(record["name"]);
  if (!name) return undefined;

  switch (record["type"]) {
    case "user": {
      const username = compactUsername(record["username"]);
      return { type: "user", name, ...(username ? { username } : {}) };
    }
    case "hidden_user":
      return { type: "hidden_user", name };
    case "chat":
    case "channel": {
      const username = compactUsername(record["username"]);
      const authorSignature = compactText(record["authorSignature"]);
      return {
        type: record["type"],
        name,
        ...(username ? { username } : {}),
        ...(authorSignature ? { authorSignature } : {}),
      };
    }
    default:
      return undefined;
  }
}

export function formatConversationForwardOrigin(
  value: ConversationForwardOrigin | undefined,
): string {
  const origin = parseConversationForwardOrigin(value);
  if (!origin) return "";

  const username = "username" in origin && origin.username ? ` (@${origin.username})` : "";
  const author =
    "authorSignature" in origin && origin.authorSignature
      ? `, author: ${origin.authorSignature}`
      : "";
  const type = origin.type === "hidden_user" ? "hidden user" : origin.type;
  return `[Forwarded from ${type}: ${origin.name}${username}${author}]`;
}
