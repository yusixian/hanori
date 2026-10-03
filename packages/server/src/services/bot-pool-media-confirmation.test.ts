import type { MediaJobView } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { BotManager } from "./bot-manager.js";
import { BotPool } from "./bot-pool.js";

vi.mock("../env.js", () => ({ env: { ENCRYPTION_KEY: "test-key" } }));

const BOT_ID = "00000000-0000-4000-8000-000000000001";

describe("BotPool audio transcription confirmation boundary", () => {
  it("loads the current Bot administrator user IDs for each authorization", async () => {
    const rows: Array<{ adminIds: number[] }> = [{ adminIds: [7] }];
    const limit = vi.fn(async () => rows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const pool = Object.assign(Object.create(BotPool.prototype), { db: { select } }) as BotPool;

    await expect(pool.isMediaAdmin(BOT_ID, 7)).resolves.toBe(true);
    rows[0]!.adminIds = [8];
    await expect(pool.isMediaAdmin(BOT_ID, 7)).resolves.toBe(false);
    await expect(pool.isMediaAdmin(BOT_ID, 8)).resolves.toBe(true);
    rows.length = 0;
    await expect(pool.isMediaAdmin(BOT_ID, 8)).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(4);
  });

  it.each([0, -1, NaN, Infinity, 1.5])(
    "rejects invalid user ID %s before querying",
    async (userId) => {
      const select = vi.fn();
      const pool = Object.assign(Object.create(BotPool.prototype), { db: { select } }) as BotPool;
      await expect(pool.isMediaAdmin(BOT_ID, userId)).resolves.toBe(false);
      expect(select).not.toHaveBeenCalled();
    },
  );

  it("sends the reviewed request to its Telegram Bot, chat and topic", async () => {
    const sendMediaConfirmation = vi.fn(async () => {});
    const manager = Object.assign(Object.create(BotManager.prototype), { sendMediaConfirmation });
    const pool = Object.assign(Object.create(BotPool.prototype), {
      managers: new Map([[BOT_ID, manager]]),
    }) as BotPool;
    const job = { id: "pending-job" } as MediaJobView;

    await pool.sendMediaConfirmation(BOT_ID, -100, job, 9);
    expect(sendMediaConfirmation).toHaveBeenCalledExactlyOnceWith(-100, job, 9);
  });

  it("fails closed when there is no Telegram manager", async () => {
    const sendHtml = vi.fn();
    const pool = Object.assign(Object.create(BotPool.prototype), {
      managers: new Map([[BOT_ID, { sendHtml }]]),
    }) as BotPool;
    const job = { id: "pending-job" } as MediaJobView;
    await expect(pool.sendMediaConfirmation(BOT_ID, -100, job)).rejects.toThrow(
      "media_confirmation_unavailable",
    );
    await expect(pool.sendMediaConfirmation("missing-bot", -100, job)).rejects.toThrow(
      "media_confirmation_unavailable",
    );
    expect(sendHtml).not.toHaveBeenCalled();
  });
});
