import type {
  IBotManager,
  TelegramRichMessageReceipt,
  TelegramRichMessageSender,
} from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { BotPool } from "./bot-pool.js";

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key" },
}));

interface RichMessageTestPool {
  managers: Map<string, IBotManager>;
  sendRichMessage: BotPool["sendRichMessage"];
}

function createPool(manager?: IBotManager) {
  const pool = Object.create(BotPool.prototype) as RichMessageTestPool;
  pool.managers = new Map(manager ? [[manager.botId, manager]] : []);
  return pool;
}

function createManager(capability?: TelegramRichMessageSender): IBotManager {
  return {
    botId: "bot-1",
    status: "running",
    uptime: 1,
    start: vi.fn(),
    stop: vi.fn(),
    sendHtml: vi.fn(),
    ...capability,
  };
}

describe("BotPool Telegram Rich Message capability", () => {
  it("delegates only to managers that expose the Telegram capability", async () => {
    const receipt: TelegramRichMessageReceipt = {
      messageId: 91,
      chatId: 123,
      format: "markdown",
    };
    const sendRichMessage = vi.fn().mockResolvedValue(receipt);
    const pool = createPool(createManager({ sendRichMessage }));

    await expect(pool.sendRichMessage("bot-1", 123, "markdown", "# Hello")).resolves.toEqual(
      receipt,
    );
    expect(sendRichMessage).toHaveBeenCalledWith(123, "markdown", "# Hello");
  });

  it("rejects managers without the Telegram capability without attempting delivery", async () => {
    const manager = createManager();
    const pool = createPool(manager);

    await expect(pool.sendRichMessage("bot-1", 123, "html", "<b>Hello</b>")).rejects.toThrow(
      "Bot bot-1 does not support Telegram Rich Messages",
    );
    expect(manager.sendHtml).not.toHaveBeenCalled();
  });

  it("reports a stopped or unknown bot separately", async () => {
    const pool = createPool();

    await expect(pool.sendRichMessage("missing", 123, "markdown", "Hello")).rejects.toThrow(
      "Bot missing is not running",
    );
  });
});
