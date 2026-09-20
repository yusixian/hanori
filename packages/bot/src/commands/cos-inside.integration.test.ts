import type { ConversationCallbacks } from "@cos-tool-bot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const telegramApi = vi.hoisted(() => {
  let messageId = 100;
  const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const method = new URL(input).pathname.split("/").pop()!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, body });
    const chatId = typeof body?.["chat_id"] === "number" ? body["chat_id"] : 42;
    const result =
      method === "sendMessage"
        ? {
            message_id: ++messageId,
            date: 1_700_000_000,
            chat:
              chatId < 0
                ? { id: chatId, type: "supergroup", title: "Target" }
                : { id: chatId, type: "private", first_name: "Admin" },
            text: String(body?.["text"] ?? ""),
          }
        : true;
    return { json: async () => ({ ok: true, result }) };
  });
  return {
    fetch,
    requests,
    reset: () => {
      messageId = 100;
      requests.length = 0;
    },
  };
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

import { createBot, disposeBot } from "../index.js";

const ACTOR_ID = 42;
const TARGET_CHAT_ID = -1001;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function messageUpdate(
  updateId: number,
  chat: Record<string, unknown>,
  text: string,
  commandLength?: number,
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat,
      from: {
        id: ACTOR_ID,
        is_bot: false,
        first_name: "Admin",
        last_name: "Operator",
        username: "admin",
      },
      text,
      ...(commandLength === undefined
        ? {}
        : { entities: [{ type: "bot_command", offset: 0, length: commandLength }] }),
    },
  };
}

afterEach(() => {
  telegramApi.reset();
});

describe("cosinside runtime coordination", () => {
  it("keeps target capture and clear behind the relay's target-chat and actor fence", async () => {
    const historyGate = deferred();
    const events: string[] = [];
    const clearHistory = vi.fn(async () => {
      events.push("clear");
    });
    const forget = vi.fn(async () => {
      events.push("forget");
      return { conversationMessages: 1, profiles: 0, personalMemories: 0 };
    });
    const addMessage = vi.fn(async () => undefined);
    const conversation: ConversationCallbacks = {
      getHistory: vi.fn(async () => ({ summary: null, messages: [] })),
      addMessage,
      addMessages: vi.fn(async () => undefined),
      triggerCompression: vi.fn(),
      clearHistory,
    };
    const onChatObserved = vi.fn(async (observation: { sourceUpdateId: number }) => {
      if (observation.sourceUpdateId === 2) events.push("ordinary");
    });
    const bot = createBot({
      token: "test-token",
      botId: "cosinside-runtime",
      adminChatIds: [ACTOR_ID],
      logger: { warn: vi.fn(), error: vi.fn() } as never,
      telegramObservation: { onChatObserved },
      conversation,
      privacy: {
        getMode: vi.fn(async () => "normal" as const),
        runExclusive: vi.fn(async (_userId, operation) => operation()),
        setMode: vi.fn(async () => undefined),
        forget,
      },
      aiReply: {
        botId: "cosinside-runtime",
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        model: "test-model",
        systemPrompt: "test",
        triggerConfig: {
          replyToBot: false,
          mentionBot: false,
          triggerWords: [],
          randomReplyPercent: 0,
          randomReplyCooldown: 0,
        },
        groupOverrides: {
          [TARGET_CHAT_ID]: { chatId: TARGET_CHAT_ID, whitelisted: true },
        },
        conversation,
      },
      cosInside: {
        targets: [{ alias: "ops", chatId: TARGET_CHAT_ID }],
        history: {
          isEnabled: () => true,
          save: async (entry) => {
            events.push("history:start");
            expect(entry).toMatchObject({
              targetChatId: TARGET_CHAT_ID,
              body: "锁内消息",
              actorUserId: ACTOR_ID,
              actorName: "Admin Operator",
            });
            await historyGate.promise;
            events.push("history:end");
          },
        },
      },
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test Bot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    };

    const relay = bot.handleUpdate(
      messageUpdate(
        1,
        { id: ACTOR_ID, type: "private", first_name: "Admin" },
        "/cosinside ops 锁内消息",
        10,
      ) as never,
    );
    await vi.waitFor(() => expect(events).toContain("history:start"));

    const ordinary = bot.handleUpdate(
      messageUpdate(
        2,
        { id: TARGET_CHAT_ID, type: "supergroup", title: "Target" },
        "普通群消息",
      ) as never,
    );
    const clear = bot.handleUpdate(
      messageUpdate(
        3,
        { id: TARGET_CHAT_ID, type: "supergroup", title: "Target" },
        "/clear",
        6,
      ) as never,
    );
    const privacyForget = bot.handleUpdate(
      messageUpdate(
        4,
        { id: ACTOR_ID, type: "private", first_name: "Admin" },
        "/privacy forget confirm",
        8,
      ) as never,
    );
    await Promise.resolve();

    expect(onChatObserved).not.toHaveBeenCalledWith(expect.objectContaining({ sourceUpdateId: 2 }));
    expect(clearHistory).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();

    historyGate.resolve();
    await Promise.all([relay, ordinary, clear, privacyForget]);

    expect(events.indexOf("history:end")).toBeLessThan(events.indexOf("ordinary"));
    expect(events.indexOf("history:end")).toBeLessThan(events.indexOf("clear"));
    expect(events.indexOf("history:end")).toBeLessThan(events.indexOf("forget"));
    expect(clearHistory).toHaveBeenCalledWith(TARGET_CHAT_ID);
    expect(forget).toHaveBeenCalledWith(ACTOR_ID);
    const sentBodies = telegramApi.requests
      .filter(({ method }) => method === "sendMessage")
      .map(({ body }) => body);
    expect(sentBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chat_id: TARGET_CHAT_ID, text: "锁内消息" }),
        expect.objectContaining({ chat_id: ACTOR_ID, text: "已代发至 ops。" }),
      ]),
    );
    await disposeBot(bot);
  });
});
