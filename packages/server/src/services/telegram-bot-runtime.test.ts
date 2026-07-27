import type { IBotManager } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  BotPoolTelegramRuntimeAdapter,
  supportsTelegramBotRuntime,
  type TelegramBotRuntime,
} from "./telegram-bot-runtime.js";

function telegramManager(
  overrides: Partial<IBotManager & TelegramBotRuntime> = {},
): IBotManager & TelegramBotRuntime {
  return {
    botId: "bot-a",
    status: "running",
    uptime: 100,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendHtml: vi.fn(async () => {}),
    isTelegramMember: vi.fn(async () => true),
    getTelegramBotMembership: vi.fn(async () => "administrator" as const),
    applyTelegramGroupOverride: vi.fn(),
    getTelegramProfile: vi.fn(async () => ({
      telegramUserId: 777,
      username: "example_chat_bot",
      displayName: "Example Bot",
      observedAt: new Date("2026-07-27T00:00:00.000Z"),
    })),
    ...overrides,
  };
}

describe("BotPoolTelegramRuntimeAdapter", () => {
  it("delegates membership and profile reads within the requested Bot scope", async () => {
    const manager = telegramManager();
    const getManager = vi.fn(() => manager);
    const adapter = new BotPoolTelegramRuntimeAdapter({ getManager });

    await expect(adapter.isMember({ botId: "bot-a", chatId: -1001, userId: 42 })).resolves.toBe(
      true,
    );
    await expect(adapter.getProfile("bot-a")).resolves.toMatchObject({
      telegramUserId: 777,
      username: "example_chat_bot",
    });
    await expect(adapter.getBotMembership({ botId: "bot-a", chatId: -1001 })).resolves.toBe(
      "administrator",
    );
    await adapter.applyGroupOverride({
      botId: "bot-a",
      chatId: -1001,
      override: { chatId: -1001, whitelisted: true },
    });
    expect(getManager).toHaveBeenCalledWith("bot-a");
    expect(manager.isTelegramMember).toHaveBeenCalledWith({ chatId: -1001, userId: 42 });
    expect(manager.getTelegramBotMembership).toHaveBeenCalledWith({ chatId: -1001 });
    expect(manager.applyTelegramGroupOverride).toHaveBeenCalledWith({
      chatId: -1001,
      override: { chatId: -1001, whitelisted: true },
    });
  });

  it("rejects a mismatched manager instead of crossing Bot scope", async () => {
    const adapter = new BotPoolTelegramRuntimeAdapter({
      getManager: () => telegramManager({ botId: "bot-b" }),
    });

    await expect(adapter.isMember({ botId: "bot-a", chatId: -1001, userId: 42 })).rejects.toThrow(
      "scope mismatch",
    );
    await expect(adapter.getProfile("bot-a")).rejects.toThrow("scope mismatch");
  });

  it("rejects absent, stopped, and non-Telegram managers", async () => {
    const absent = new BotPoolTelegramRuntimeAdapter({ getManager: () => undefined });
    await expect(absent.isMember({ botId: "bot-a", chatId: -1001, userId: 42 })).rejects.toThrow(
      "not running",
    );

    const stopped = new BotPoolTelegramRuntimeAdapter({
      getManager: () => telegramManager({ status: "stopped" }),
    });
    await expect(stopped.getProfile("bot-a")).rejects.toThrow("not running");

    const nonTelegram: IBotManager = {
      ...telegramManager(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      sendHtml: vi.fn(async () => {}),
    };
    delete (nonTelegram as Partial<TelegramBotRuntime>).getTelegramProfile;
    delete (nonTelegram as Partial<TelegramBotRuntime>).isTelegramMember;
    delete (nonTelegram as Partial<TelegramBotRuntime>).getTelegramBotMembership;
    delete (nonTelegram as Partial<TelegramBotRuntime>).applyTelegramGroupOverride;
    expect(supportsTelegramBotRuntime(nonTelegram)).toBe(false);
    const unsupported = new BotPoolTelegramRuntimeAdapter({ getManager: () => nonTelegram });
    await expect(unsupported.getProfile("bot-a")).rejects.toThrow(
      "does not support Telegram runtime operations",
    );
  });

  it("validates identifiers before manager lookup", async () => {
    const getManager = vi.fn(() => telegramManager());
    const adapter = new BotPoolTelegramRuntimeAdapter({ getManager });

    await expect(adapter.getProfile("  ")).rejects.toThrow("Bot ID is required");
    await expect(adapter.isMember({ botId: "bot-a", chatId: 1, userId: 42 })).rejects.toThrow(
      "negative safe integer",
    );
    await expect(
      adapter.isMember({
        botId: "bot-a",
        chatId: -1001,
        userId: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("positive safe integer");
    expect(getManager).not.toHaveBeenCalled();
  });

  it("propagates runtime API failures for fail-closed policy handling", async () => {
    const apiError = new Error("Telegram unavailable");
    const adapter = new BotPoolTelegramRuntimeAdapter({
      getManager: () =>
        telegramManager({
          isTelegramMember: vi.fn(async () => {
            throw apiError;
          }),
        }),
    });

    await expect(adapter.isMember({ botId: "bot-a", chatId: -1001, userId: 42 })).rejects.toBe(
      apiError,
    );
  });
});
