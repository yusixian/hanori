import { describe, expect, it } from "vitest";
import {
  formatConversationForwardOrigin,
  parseConversationForwardOrigin,
} from "./forward-origin.js";

describe("conversation forward origin", () => {
  it("formats only the attribution Telegram exposes", () => {
    expect(
      formatConversationForwardOrigin({ type: "user", name: "Alice", username: "alice" }),
    ).toBe("[Forwarded from user: Alice (@alice)]");
    expect(formatConversationForwardOrigin({ type: "hidden_user", name: "Private Sender" })).toBe(
      "[Forwarded from hidden user: Private Sender]",
    );
    expect(
      formatConversationForwardOrigin({
        type: "channel",
        name: "Daily News",
        username: "daily_news",
        authorSignature: "Editor",
      }),
    ).toBe("[Forwarded from channel: Daily News (@daily_news), author: Editor]");
  });

  it("sanitizes persisted metadata and rejects incomplete values", () => {
    expect(
      parseConversationForwardOrigin({
        type: "chat",
        name: "  Public\n Group ",
        username: "@public_group",
        authorSignature: " Admin\tName ",
        id: -100,
        date: 123,
      }),
    ).toEqual({
      type: "chat",
      name: "Public Group",
      username: "public_group",
      authorSignature: "Admin Name",
    });
    expect(parseConversationForwardOrigin({ type: "user", username: "missing_name" })).toBe(
      undefined,
    );
    expect(parseConversationForwardOrigin({ type: "unknown", name: "Sender" })).toBe(undefined);
    expect(formatConversationForwardOrigin(undefined)).toBe("");
  });
});
