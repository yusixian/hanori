import { describe, expect, it } from "vitest";
import { canAccessAiChat, type AiChatAccessConfig } from "./ai-chat-access.js";

describe("canAccessAiChat", () => {
  const groupChatId = -100;

  const cases: Array<{
    name: string;
    config: AiChatAccessConfig;
    input: Parameters<typeof canAccessAiChat>[1];
    allowed: boolean;
  }> = [
    {
      name: "an ordinary user in an authorized group",
      config: { groupOverrides: { [groupChatId]: { chatId: groupChatId, whitelisted: true } } },
      input: { chatId: groupChatId, userId: 42, isPrivate: false, isBotAdmin: false },
      allowed: true,
    },
    {
      name: "an ordinary user in an unauthorized group",
      config: { groupOverrides: {} },
      input: { chatId: groupChatId, userId: 42, isPrivate: false, isBotAdmin: false },
      allowed: false,
    },
    {
      name: "a bot admin in an enabled group",
      config: { groupOverrides: {} },
      input: { chatId: groupChatId, userId: 42, isPrivate: false, isBotAdmin: true },
      allowed: true,
    },
    {
      name: "a bot admin in a disabled group",
      config: {
        groupOverrides: {
          [groupChatId]: { chatId: groupChatId, whitelisted: true, enabled: false },
        },
      },
      input: { chatId: groupChatId, userId: 42, isPrivate: false, isBotAdmin: true },
      allowed: false,
    },
    {
      name: "an ordinary private user when private access is open",
      config: { groupOverrides: {}, privateChatAccess: "all" as const },
      input: { chatId: 42, userId: 42, isPrivate: true, isBotAdmin: false },
      allowed: true,
    },
    {
      name: "an allowlisted private user",
      config: {
        groupOverrides: {},
        privateChatAccess: "allowlist" as const,
        privateChatWhitelist: [42],
      },
      input: { chatId: 42, userId: 42, isPrivate: true, isBotAdmin: false },
      allowed: true,
    },
    {
      name: "an unlisted private user",
      config: {
        groupOverrides: {},
        privateChatAccess: "allowlist" as const,
        privateChatWhitelist: [7],
      },
      input: { chatId: 42, userId: 42, isPrivate: true, isBotAdmin: false },
      allowed: false,
    },
    {
      name: "a bot admin when private access is admin-only",
      config: { groupOverrides: {}, privateChatAccess: "admin" as const },
      input: { chatId: 42, userId: 42, isPrivate: true, isBotAdmin: true },
      allowed: true,
    },
  ];

  it.each(cases)("authorizes $name", ({ config, input, allowed }) => {
    expect(canAccessAiChat(config, input)).toBe(allowed);
  });
});
