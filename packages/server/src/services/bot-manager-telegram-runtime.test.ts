import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChatMember: vi.fn(),
  getMe: vi.fn(),
  createBot: vi.fn(),
  disposeBot: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@cos-tool-bot/bot", () => ({
  createBot: mocks.createBot,
  disposeBot: mocks.disposeBot,
  recoverPixAIGeneration: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({ run: mocks.run }));

import { BotManager } from "./bot-manager.js";
import type { DbLogger } from "./db-logger.js";

function createManager(): BotManager {
  return new BotManager({
    botId: "bot-a",
    token: "secret-bot-token",
    adminChatIds: [1],
    logger: {} as Logger,
    dbLogger: {
      info: vi.fn(async () => {}),
      warn: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
      log: vi.fn(async () => {}),
    } as unknown as DbLogger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createBot.mockImplementation(() => ({
    api: { getChatMember: mocks.getChatMember, getMe: mocks.getMe },
  }));
  mocks.run.mockImplementation(() => ({
    stop: vi.fn(async () => {}),
    task: vi.fn(() => undefined),
  }));
});

describe("BotManager Telegram runtime capability", () => {
  it.each([
    [{ status: "creator" }, true],
    [{ status: "administrator" }, true],
    [{ status: "member" }, true],
    [{ status: "restricted", is_member: true }, true],
    [{ status: "restricted", is_member: false }, false],
    [{ status: "left" }, false],
    [{ status: "kicked" }, false],
  ] as const)("maps Telegram membership %#", async (member, expected) => {
    const manager = createManager();
    mocks.getChatMember.mockResolvedValue(member);
    await manager.start();

    await expect(manager.isTelegramMember({ chatId: -1001, userId: 42 })).resolves.toBe(expected);
    expect(mocks.getChatMember).toHaveBeenCalledWith(-1001, 42);
  });

  it("rejects invalid IDs before calling Telegram", async () => {
    const manager = createManager();
    await manager.start();

    for (const chatId of [0, 1, Number.MIN_SAFE_INTEGER - 1]) {
      await expect(manager.isTelegramMember({ chatId, userId: 42 })).rejects.toThrow(
        "negative safe integer",
      );
    }
    for (const userId of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(manager.isTelegramMember({ chatId: -1001, userId })).rejects.toThrow(
        "positive safe integer",
      );
    }
    expect(mocks.getChatMember).not.toHaveBeenCalled();
  });

  it("propagates Telegram API failures and rejects stopped runtimes", async () => {
    const manager = createManager();
    const apiError = new Error("Telegram unavailable");
    mocks.getChatMember.mockRejectedValue(apiError);
    mocks.getMe.mockRejectedValue(apiError);

    await expect(manager.isTelegramMember({ chatId: -1001, userId: 42 })).rejects.toThrow(
      "not running",
    );
    await manager.start();
    await expect(manager.isTelegramMember({ chatId: -1001, userId: 42 })).rejects.toBe(apiError);
    await expect(manager.getTelegramProfile()).rejects.toBe(apiError);
    await manager.stop();
    await expect(manager.getTelegramProfile()).rejects.toThrow("not running");
  });

  it("returns only the public getMe projection", async () => {
    const manager = createManager();
    mocks.getMe.mockResolvedValue({
      id: 777,
      username: "example_chat_bot",
      first_name: "Example Bot",
      last_name: "Helper",
      is_bot: true,
      token: "must-not-leak",
    });
    await manager.start();
    const before = Date.now();

    const profile = await manager.getTelegramProfile();

    expect(profile).toEqual({
      telegramUserId: 777,
      username: "example_chat_bot",
      displayName: "Example Bot Helper",
      observedAt: expect.any(Date),
    });
    expect(profile.observedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(Object.keys(profile).sort()).toEqual([
      "displayName",
      "observedAt",
      "telegramUserId",
      "username",
    ]);
    expect(JSON.stringify(profile)).not.toContain("must-not-leak");
  });

  it("reads the Bot's current administrator status for grant validation", async () => {
    const manager = createManager();
    mocks.getMe.mockResolvedValue({
      id: 777,
      username: "example_chat_bot",
      first_name: "Example Bot",
      is_bot: true,
    });
    mocks.getChatMember.mockResolvedValue({ status: "administrator" });
    await manager.start();

    await expect(manager.getTelegramBotMembership({ chatId: -1001 })).resolves.toBe(
      "administrator",
    );
    expect(mocks.getChatMember).toHaveBeenCalledWith(-1001, 777);
  });

  it("rejects an invalid getMe identity", async () => {
    const manager = createManager();
    mocks.getMe.mockResolvedValue({
      id: Number.MAX_SAFE_INTEGER + 1,
      username: "invalid_bot",
      first_name: "Invalid",
    });
    await manager.start();

    await expect(manager.getTelegramProfile()).rejects.toThrow("invalid bot user ID");
  });
});
