import { afterEach, describe, expect, it, vi } from "vitest";

const telegramApi = vi.hoisted(() => {
  const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const method = new URL(input).pathname.split("/").pop()!;
    requests.push({
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const result =
      method === "sendMessage"
        ? { message_id: 1, date: 1_700_000_000, chat: { id: -100, type: "supergroup" }, text: "ok" }
        : true;
    return { json: async () => ({ ok: true, result }) };
  });
  return { fetch, requests };
});

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(token: string, options: Record<string, unknown> = {}) {
        super(token, { ...options, client: { fetch: telegramApi.fetch } });
      }
    },
  };
});

import { Bot } from "grammy";
import type { BotContext } from "../context.js";
import { createBot, getActiveBotCommands } from "../index.js";
import { createHarnessMiddleware } from "./middleware.js";
import type { HarnessAssistantRuntime, HarnessBotPort } from "./types.js";

const HARNESS_CHAT = -1001;
const OTHER_CHAT = -2002;
const OWNER = 42;

afterEach(() => {
  telegramApi.requests.length = 0;
});

function createPort(overrides: Partial<HarnessBotPort> = {}): HarnessBotPort {
  return {
    isHarnessChat: (chatId) => chatId === HARNESS_CHAT,
    isOwner: (userId) => userId === OWNER,
    allowsCasualReplies: () => false,
    usageHint: vi.fn(() => "hint"),
    onBotReady: vi.fn(),
    handleCommand: vi.fn(async () => ({ html: "harness reply" })),
    handleCallback: vi.fn(async () => ({ text: "done" })),
    handleReply: vi.fn(async () => null),
    handleTopicMessage: vi.fn(async () => {}),
    ...overrides,
  };
}

const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: "Harness",
  username: "harness_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as never;

function createHarnessBot(port: HarnessBotPort) {
  const bot = createBot({
    token: "test-token",
    botId: "bot-harness",
    adminChatIds: [OWNER],
    logger: { warn: vi.fn(), error: vi.fn() } as never,
    harness: port,
  });
  bot.botInfo = BOT_INFO;
  return bot;
}

/** Only the harness middleware, with a Bot AI that may be absent. */
function createAssistantBot(port: HarnessBotPort, runtime: HarnessAssistantRuntime | undefined) {
  const bot = new Bot<BotContext>("test-token");
  bot.botInfo = BOT_INFO;
  const resolveAssistant = vi.fn(() => runtime);
  bot.use(createHarnessMiddleware(port, { resolveAssistant }));
  return { bot, resolveAssistant };
}

let updateId = 1;
function message(chatId: number, text: string, from = OWNER, extra: Record<string, unknown> = {}) {
  const command = text.startsWith("/") ? text.split(" ", 1)[0]!.length : 0;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup", title: "Group", is_forum: true },
      from: { id: from, is_bot: false, first_name: "User" },
      text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command }] } : {}),
      ...extra,
    },
  } as never;
}

const sentTexts = () =>
  telegramApi.requests.filter((r) => r.method === "sendMessage").map((r) => r.body?.text);

describe("harness middleware", () => {
  it("registers /harness and hands the Telegram adapter to the port", () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    expect(getActiveBotCommands(bot).map((c) => c.command)).toContain("harness");
    expect(port.onBotReady).toHaveBeenCalledOnce();
  });

  it("routes harness commands in the harness chat with the topic thread", async () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    await bot.handleUpdate(
      message(HARNESS_CHAT, "/status@harness_bot", OWNER, {
        is_topic_message: true,
        message_thread_id: 77,
      }),
    );
    expect(port.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "status", args: "", threadId: 77, userId: OWNER }),
    );
    const reply = telegramApi.requests.find((r) => r.method === "sendMessage")!;
    expect(reply.body).toMatchObject({ text: "harness reply", message_thread_id: 77 });
  });

  it("routes /list, /cancel, and /retry in the harness chat and points elsewhere", async () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    for (const text of ["/list", "/cancel #12", "/retry ab12cd34"]) {
      await bot.handleUpdate(message(HARNESS_CHAT, text, OWNER));
    }
    expect(vi.mocked(port.handleCommand).mock.calls.map(([r]) => [r.command, r.args])).toEqual([
      ["list", ""],
      ["cancel", "#12"],
      ["retry", "ab12cd34"],
    ]);
    telegramApi.requests.length = 0;
    await bot.handleUpdate(message(OTHER_CHAT, "/cancel", OWNER));
    expect(port.handleCommand).toHaveBeenCalledTimes(3);
    expect(sentTexts()).toEqual(["请在 Dev Harness 话题群中使用 /cancel。"]);
  });

  it("sends the port's keyboard and passes the Bot username", async () => {
    const port = createPort({
      handleCommand: vi.fn(async () => ({
        html: "status",
        keyboard: [[{ text: "⚙️ 管理项目", url: "https://t.me/harness_bot?startapp=harness" }]],
      })),
    });
    const bot = createHarnessBot(port);
    await bot.handleUpdate(message(HARNESS_CHAT, "/status", OWNER));
    expect(port.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ botUsername: "harness_bot" }),
    );
    const reply = telegramApi.requests.find((r) => r.method === "sendMessage")!;
    expect(reply.body?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "⚙️ 管理项目", url: "https://t.me/harness_bot?startapp=harness" }],
      ],
    });
  });

  it("keeps the regular /status outside the harness chat", async () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    await bot.handleUpdate(message(OTHER_CHAT, "/status"));
    expect(port.handleCommand).not.toHaveBeenCalled();
    expect(sentTexts().join("\n")).toContain("状态");
  });

  it("ignores non-owners and commands aimed at other bots", async () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    await bot.handleUpdate(message(HARNESS_CHAT, "/status", 7));
    await bot.handleUpdate(message(HARNESS_CHAT, "hello", 7));
    await bot.handleUpdate(message(HARNESS_CHAT, "/status@other_bot"));
    expect(port.handleCommand).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual([]);
  });

  it("answers ordinary owner messages with a usage hint instead of chatting", async () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    await bot.handleUpdate(message(HARNESS_CHAT, "please fix the login page"));
    expect(port.usageHint).toHaveBeenCalledWith(undefined);
    expect(sentTexts()).toEqual(["hint"]);
  });

  it("stays silent on service messages", async () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    const update = message(HARNESS_CHAT, "x") as { message: Record<string, unknown> };
    delete update.message.text;
    update.message.forum_topic_created = { name: "koyori", icon_color: 1 };
    await bot.handleUpdate(update as never);
    expect(sentTexts()).toEqual([]);
  });

  it("gates harness buttons by owner and forwards the card message", async () => {
    const port = createPort();
    const bot = createHarnessBot(port);
    const callback = (from: number) =>
      ({
        update_id: updateId++,
        callback_query: {
          id: `cb-${updateId}`,
          from: { id: from, is_bot: false, first_name: "User" },
          chat_instance: "x",
          data: "hx:AbCdEfGhIjKlMnOpQrStUv:m",
          message: {
            message_id: 55,
            date: 1_700_000_000,
            chat: { id: HARNESS_CHAT, type: "supergroup", title: "Group" },
            is_topic_message: true,
            message_thread_id: 77,
          },
        },
      }) as never;
    await bot.handleUpdate(callback(7));
    expect(port.handleCallback).not.toHaveBeenCalled();
    await bot.handleUpdate(callback(OWNER));
    expect(port.handleCallback).toHaveBeenCalledWith({
      data: "hx:AbCdEfGhIjKlMnOpQrStUv:m",
      chatId: HARNESS_CHAT,
      threadId: 77,
      messageId: 55,
      userId: OWNER,
    });
    const answers = telegramApi.requests.filter((r) => r.method === "answerCallbackQuery");
    expect(answers.map((a) => a.body?.text)).toEqual(["无权限", "done"]);
  });

  it("routes owner replies to Bot messages and passes /bug attachments", async () => {
    const port = createPort({
      handleReply: vi.fn(async (request) =>
        request.replyToMessageId === 55 ? { html: "" } : null,
      ),
    });
    const bot = createHarnessBot(port);
    const botMessage = (id: number) => ({
      message_id: id,
      date: 1_700_000_000,
      chat: { id: HARNESS_CHAT, type: "supergroup" },
      from: { id: 999, is_bot: true, first_name: "Harness" },
      text: "card",
    });
    await bot.handleUpdate(
      message(HARNESS_CHAT, "改成蓝色", OWNER, { reply_to_message: botMessage(55) }),
    );
    expect(port.handleReply).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 55, text: "改成蓝色", userId: OWNER }),
    );
    expect(sentTexts()).toEqual([]);

    await bot.handleUpdate(
      message(HARNESS_CHAT, "随便说说", OWNER, { reply_to_message: botMessage(56) }),
    );
    expect(sentTexts()).toEqual(["hint"]);

    const photoUpdate = message(HARNESS_CHAT, "", OWNER) as { message: Record<string, unknown> };
    delete photoUpdate.message.text;
    Object.assign(photoUpdate.message, {
      caption: "/bug 头像裂了",
      caption_entities: [{ type: "bot_command", offset: 0, length: 4 }],
      photo: [
        { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
        { file_id: "large", file_unique_id: "l", width: 900, height: 900 },
      ],
    });
    await bot.handleUpdate(photoUpdate as never);
    expect(port.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bug",
        args: "头像裂了",
        attachments: [{ kind: "photo", fileId: "large", width: 900, height: 900 }],
      }),
    );
  });

  it("sends nothing when the port answers with an empty reply", async () => {
    const port = createPort({ handleCommand: vi.fn(async () => ({ html: "" })) });
    const bot = createHarnessBot(port);
    await bot.handleUpdate(message(HARNESS_CHAT, "/bug 保存失败"));
    expect(sentTexts()).toEqual([]);
  });

  describe("topic assistant", () => {
    const runtime = { model: "fake-model" } as unknown as HarnessAssistantRuntime;

    it("hands owner free text to the assistant with the topic and the Bot's model", async () => {
      const port = createPort();
      const { bot, resolveAssistant } = createAssistantBot(port, runtime);
      await bot.handleUpdate(
        message(HARNESS_CHAT, "  这个项目下一步做什么？ ", OWNER, {
          is_topic_message: true,
          message_thread_id: 77,
        }),
      );
      expect(resolveAssistant).toHaveBeenCalledWith(HARNESS_CHAT, OWNER);
      expect(port.handleTopicMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: HARNESS_CHAT,
          threadId: 77,
          userId: OWNER,
          text: "这个项目下一步做什么？",
        }),
        runtime,
      );
      expect(port.usageHint).not.toHaveBeenCalled();
      expect(sentTexts()).toEqual([]);
    });

    it("keeps commands, card replies, non-owners, and non-text away from the assistant", async () => {
      const port = createPort({
        handleReply: vi.fn(async () => ({ html: "" })),
      });
      const { bot } = createAssistantBot(port, runtime);
      await bot.handleUpdate(message(HARNESS_CHAT, "/status"));
      await bot.handleUpdate(message(HARNESS_CHAT, "/new"));
      await bot.handleUpdate(
        message(HARNESS_CHAT, "改成蓝色", OWNER, {
          reply_to_message: {
            message_id: 55,
            date: 1_700_000_000,
            chat: { id: HARNESS_CHAT, type: "supergroup" },
            from: { id: 999, is_bot: true, first_name: "Harness" },
            text: "card",
          },
        }),
      );
      await bot.handleUpdate(message(HARNESS_CHAT, "路过", 7));
      const sticker = message(HARNESS_CHAT, "x") as { message: Record<string, unknown> };
      delete sticker.message.text;
      sticker.message.sticker = { file_id: "s", file_unique_id: "s", type: "regular" };
      await bot.handleUpdate(sticker as never);

      expect(port.handleCommand).toHaveBeenCalledTimes(2);
      expect(port.handleCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "new" }),
      );
      expect(port.handleReply).toHaveBeenCalledOnce();
      expect(port.handleTopicMessage).not.toHaveBeenCalled();
      expect(sentTexts()).toEqual(["harness reply", "harness reply", "hint"]);
    });

    it("falls back to the usage hint when the Bot has no AI", async () => {
      const port = createPort();
      const { bot } = createAssistantBot(port, undefined);
      await bot.handleUpdate(message(HARNESS_CHAT, "帮我看看 issue"));
      expect(port.handleTopicMessage).not.toHaveBeenCalled();
      expect(sentTexts()).toEqual(["hint"]);
    });
  });
});
