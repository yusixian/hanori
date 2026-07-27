import type { BotLogEntry } from "@cos-tool-bot/shared";
import type { NextFunction } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import {
  createTelegramObservationMiddleware,
  isValidTelegramGroupChatId,
  projectTelegramObservations,
  type TelegramObservationCallbacks,
} from "./telegram-observation.js";

const botId = "bot-1";
const botUser = { id: 999, is_bot: true, first_name: "Test Bot", username: "test_bot" };
const actor = { id: 42, is_bot: false, first_name: "Admin" };

function messageUpdate(
  updateId: number,
  chat: Record<string, unknown>,
  content: Record<string, unknown> = {},
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000 + updateId,
      chat,
      from: actor,
      ...content,
    },
  } as unknown as Update;
}

async function runMiddleware(
  update: Update,
  callbacks: TelegramObservationCallbacks,
  onLog?: (entry: BotLogEntry) => void | Promise<void>,
) {
  const next = vi.fn<NextFunction>(async () => {});
  const middleware = createTelegramObservationMiddleware(botId, callbacks, onLog);
  await middleware({ update } as WrapperContext, next);
  return next;
}

describe("Telegram observation projection", () => {
  it("projects only group directory identity from an ordinary update", () => {
    const update = messageUpdate(
      101,
      { id: -1_001_234, type: "supergroup", title: "Test Group", username: "test_group" },
      { text: "sensitive body", caption: "sensitive caption" },
    );

    expect(projectTelegramObservations(update, botId)).toEqual([
      {
        kind: "chat",
        idempotencyKey: "bot-1:telegram:101:chat:-1001234",
        botId,
        sourceUpdateId: 101,
        chatId: -1_001_234,
        chatType: "supergroup",
        title: "Test Group",
        username: "test_group",
        observedAt: 1_700_000_101,
      },
    ]);
  });

  it("projects chat identity and the bot membership transition from my_chat_member", () => {
    const update = {
      update_id: 102,
      my_chat_member: {
        chat: { id: -200, type: "group", title: "Basic Group" },
        from: actor,
        date: 1_700_000_102,
        old_chat_member: { status: "left", user: botUser },
        new_chat_member: { status: "member", user: botUser },
      },
    } as Update;

    expect(projectTelegramObservations(update, botId)).toEqual([
      {
        kind: "chat",
        idempotencyKey: "bot-1:telegram:102:chat:-200",
        botId,
        sourceUpdateId: 102,
        chatId: -200,
        chatType: "group",
        title: "Basic Group",
        observedAt: 1_700_000_102,
      },
      {
        kind: "bot_membership",
        idempotencyKey: "bot-1:telegram:102:bot_membership:-200",
        botId,
        sourceUpdateId: 102,
        chatId: -200,
        chatType: "group",
        previousStatus: "left",
        status: "member",
        observedAt: 1_700_000_102,
      },
    ]);
  });

  it.each([
    {
      name: "migrate_to_chat_id",
      update: messageUpdate(
        103,
        { id: -300, type: "group", title: "Old Group" },
        { migrate_to_chat_id: -1_003_003_003 },
      ),
    },
    {
      name: "migrate_from_chat_id",
      update: messageUpdate(
        104,
        { id: -1_003_003_003, type: "supergroup", title: "New Group" },
        { migrate_from_chat_id: -300 },
      ),
    },
  ])("normalizes $name to the same old-to-new direction", ({ update }) => {
    const migration = projectTelegramObservations(update, botId).find(
      (observation) => observation.kind === "chat_migration",
    );

    expect(migration).toMatchObject({
      kind: "chat_migration",
      idempotencyKey: "bot-1:telegram:chat_migration:-300:-1003003003",
      oldChatId: -300,
      newChatId: -1_003_003_003,
      observedAt: update.message!.date,
    });
  });

  it("rejects private, channel, positive, and unsafe group identities", () => {
    const invalidChatUpdates = [
      messageUpdate(110, { id: 42, type: "private", first_name: "Private" }),
      messageUpdate(111, { id: -400, type: "channel", title: "Channel" }),
      messageUpdate(112, { id: 400, type: "group", title: "Positive Group" }),
      messageUpdate(113, { id: -401, type: "group" }),
      messageUpdate(114, {
        id: Number.MIN_SAFE_INTEGER - 1,
        type: "supergroup",
        title: "Unsafe Group",
      }),
    ];

    for (const update of invalidChatUpdates) {
      expect(projectTelegramObservations(update, botId)).toEqual([]);
    }
    expect(isValidTelegramGroupChatId(-1)).toBe(true);
    expect(isValidTelegramGroupChatId(0)).toBe(false);
    expect(isValidTelegramGroupChatId(-1.5)).toBe(false);
    expect(isValidTelegramGroupChatId(Number.MIN_SAFE_INTEGER - 1)).toBe(false);
  });

  it("keeps a valid chat observation but rejects invalid migration edges", () => {
    const invalidMigrations = [
      messageUpdate(
        115,
        { id: -500, type: "group", title: "Bad Migration" },
        { migrate_to_chat_id: 500 },
      ),
      messageUpdate(
        116,
        { id: -500, type: "group", title: "Self Migration" },
        { migrate_to_chat_id: -500 },
      ),
    ];

    for (const update of invalidMigrations) {
      expect(projectTelegramObservations(update, botId)).toEqual([
        expect.objectContaining({ kind: "chat", chatId: -500 }),
      ]);
    }
  });
});

describe("Telegram observation middleware", () => {
  it("dispatches every projected event and continues the update", async () => {
    const onChatObserved = vi.fn();
    const onChatMigrationObserved = vi.fn();
    const update = messageUpdate(
      201,
      { id: -600, type: "group", title: "Old Group" },
      { migrate_to_chat_id: -1_006_006_006 },
    );

    const next = await runMiddleware(update, { onChatObserved, onChatMigrationObserved });

    expect(onChatObserved).toHaveBeenCalledTimes(1);
    expect(onChatMigrationObserved).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("logs callback failure without payload or exception details and never breaks the update", async () => {
    const onLog = vi.fn(async (_entry: BotLogEntry) => {
      throw new Error("logging adapter unavailable");
    });
    const onChatObserved = vi.fn(async () => {
      throw new Error("sensitive callback error");
    });
    const onChatMigrationObserved = vi.fn();
    const update = messageUpdate(
      202,
      { id: -700, type: "group", title: "Old Group" },
      { text: "secret message", migrate_to_chat_id: -1_007_007_007 },
    );

    const next = await runMiddleware(update, { onChatObserved, onChatMigrationObserved }, onLog);

    expect(onChatMigrationObserved).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith({
      level: "error",
      message: "Failed to persist Telegram observation",
      meta: { botId, updateId: 202, observationKind: "chat" },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("secret message");
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("sensitive callback error");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
