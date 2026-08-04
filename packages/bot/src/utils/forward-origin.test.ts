import { describe, expect, it } from "vitest";
import type { MessageOrigin } from "grammy/types";
import { normalizeTelegramForwardOrigin } from "./forward-origin.js";

describe("normalizeTelegramForwardOrigin", () => {
  it.each([
    {
      origin: {
        type: "user",
        date: 1,
        sender_user: {
          id: 100,
          is_bot: false,
          first_name: "Alice",
          last_name: "Example",
          username: "alice",
        },
      },
      expected: { type: "user", name: "Alice Example", username: "alice" },
    },
    {
      origin: { type: "hidden_user", date: 2, sender_user_name: "Hidden Alice" },
      expected: { type: "hidden_user", name: "Hidden Alice" },
    },
    {
      origin: {
        type: "chat",
        date: 3,
        sender_chat: {
          id: -100,
          type: "supergroup",
          title: "Public Group",
          username: "public_group",
        },
        author_signature: "Anonymous Admin",
      },
      expected: {
        type: "chat",
        name: "Public Group",
        username: "public_group",
        authorSignature: "Anonymous Admin",
      },
    },
    {
      origin: {
        type: "channel",
        date: 4,
        chat: { id: -101, type: "channel", title: "Daily News", username: "daily_news" },
        message_id: 99,
        author_signature: "Editor",
      },
      expected: {
        type: "channel",
        name: "Daily News",
        username: "daily_news",
        authorSignature: "Editor",
      },
    },
  ] satisfies Array<{ origin: MessageOrigin; expected: Record<string, unknown> }>)(
    "normalizes $origin.type without retaining raw IDs or dates",
    ({ origin, expected }) => {
      expect(normalizeTelegramForwardOrigin(origin)).toEqual(expected);
    },
  );

  it("leaves ordinary messages without attribution", () => {
    expect(normalizeTelegramForwardOrigin(undefined)).toBe(undefined);
  });

  it.each([{ type: "future_origin" }, { type: "user" }, { type: "chat" }, { type: "channel" }])(
    "degrades an unknown or incomplete $type origin without throwing",
    (origin) => {
      expect(normalizeTelegramForwardOrigin(origin)).toBe(undefined);
    },
  );
});
