import { describe, expect, it } from "vitest";
import { formatConversationRelayOrigin, parseConversationRelayOrigin } from "./relay-origin.js";

describe("cosinside relay attribution", () => {
  it("keeps the real initiator and treats their display name as quoted data", () => {
    const origin = parseConversationRelayOrigin({
      source: "cosinside",
      initiatorTelegramId: 42,
      initiatorName: 'Alice\n"admin"',
    });
    expect(origin?.initiatorName).toBe('Alice "admin"');
    expect(formatConversationRelayOrigin(origin)).toContain("Telegram ID: 42");
    expect(formatConversationRelayOrigin(origin)).toContain("非 AI 自主发言");
    expect(formatConversationRelayOrigin(origin)).not.toContain("\n");
  });
  it("falls back to the stable ID when no name is available", () => {
    expect(
      parseConversationRelayOrigin({ source: "cosinside", initiatorTelegramId: 42 })?.initiatorName,
    ).toBe("42");
  });
  it.each([
    null,
    {},
    { source: "other", initiatorTelegramId: 42 },
    { source: "cosinside", initiatorTelegramId: "42" },
    { source: "cosinside", initiatorTelegramId: -1 },
  ])("ignores malformed attribution %j", (value) => {
    expect(parseConversationRelayOrigin(value)).toBeUndefined();
  });
});
