import type { BotLogEntry } from "@cos-tool-bot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  streamText: vi.fn(),
  requests: [] as Array<{ method: string; body?: unknown }>,
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: testState.streamText,
}));

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(token: string, options: Record<string, unknown> = {}) {
        super(token, {
          ...options,
          client: {
            fetch: vi.fn(async (input: string, init?: RequestInit) => {
              const method = new URL(input).pathname.split("/").pop()!;
              const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
              testState.requests.push({ method, body });
              const result =
                method === "sendMessage"
                  ? {
                      message_id: testState.requests.length + 100,
                      date: 1_700_000_000,
                      chat: { id: -100, type: "supergroup", title: "Test Group" },
                      text: (body as { text?: string } | undefined)?.text ?? "ok",
                    }
                  : true;
              return { json: async () => ({ ok: true, result }) };
            }),
          },
        });
      }
    },
  };
});

import { createBot, disposeBot } from "./index.js";

const CHAT_ID = -100;
const USER_ID = 42;

function streamResult(text: string) {
  async function* textStream() {
    yield text;
  }
  return {
    textStream: textStream(),
    text: Promise.resolve(text),
    steps: Promise.resolve([]),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    finishReason: Promise.resolve("stop"),
  };
}

function messageUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
      from: { id: USER_ID, is_bot: false, first_name: "Tester" },
      text: "sample 给我两个选项",
      entities: [],
    },
  };
}

function callbackUpdate(data: string, messageId: number) {
  return {
    update_id: 2,
    callback_query: {
      id: "callback-1",
      from: { id: USER_ID, is_bot: false, first_name: "Tester" },
      message: {
        message_id: messageId,
        date: 1_700_000_001,
        chat: { id: CHAT_ID, type: "supergroup", title: "Test Group" },
        text: "选择一个",
      },
      chat_instance: "chat-instance",
      data,
    },
  };
}

afterEach(() => {
  testState.streamText.mockReset();
  testState.requests.length = 0;
});

describe("createBot send_choice callback ingress", () => {
  it("continues a choice callback through the complete Telegram update pipeline", async () => {
    let choiceData = "";
    testState.streamText
      .mockImplementationOnce((options: any) => {
        async function* textStream() {
          const output = await options.tools.send_choice.execute({
            prompt: "选择一个",
            options: ["A", "B"],
            target_user_id: USER_ID,
          });
          choiceData = `cos:c:${output.choice_id}:0`;
          yield "选项已发送";
        }
        return {
          textStream: textStream(),
          text: Promise.resolve("选项已发送"),
          steps: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          finishReason: Promise.resolve("stop"),
        };
      })
      .mockImplementationOnce(() => streamResult("已按选择继续"));

    const logs: BotLogEntry[] = [];
    const bot = createBot({
      token: "test-token",
      botId: "bot-choice-ingress",
      adminChatIds: [],
      logger: { warn: vi.fn(), error: vi.fn() } as never,
      onLog: (entry) => {
        logs.push(entry);
      },
      privacy: {
        getMode: async () => "normal",
        runExclusive: async (_userId, operation) => operation(),
        setMode: async () => {},
        forget: async () => ({ conversationMessages: 0, profiles: 0, personalMemories: 0 }),
      },
      aiReply: {
        botId: "bot-choice-ingress",
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        model: "model-a",
        systemPrompt: "test",
        triggerConfig: {
          replyToBot: false,
          mentionBot: false,
          triggerWords: ["sample"],
          randomReplyPercent: 0,
          randomReplyCooldown: 0,
        },
        groupOverrides: { [CHAT_ID]: { chatId: CHAT_ID, whitelisted: true } },
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

    let callback: Promise<void> | undefined;
    try {
      await bot.handleUpdate(messageUpdate() as never);
      await vi.waitFor(() => expect(choiceData).toMatch(/^cos:c:[^:]+:0$/));

      const choiceRequestIndex = testState.requests.findIndex(
        ({ method, body }) =>
          method === "sendMessage" && (body as { text?: string } | undefined)?.text === "选择一个",
      );
      expect(choiceRequestIndex).toBeGreaterThanOrEqual(0);
      const choiceMessageId = choiceRequestIndex + 101;
      callback = bot.handleUpdate(callbackUpdate(choiceData, choiceMessageId) as never);
      await vi.waitFor(() => {
        expect(testState.requests.some(({ method }) => method === "answerCallbackQuery")).toBe(
          true,
        );
        expect(testState.requests.some(({ method }) => method === "editMessageText")).toBe(true);
      });
      await vi.waitFor(() => expect(testState.streamText).toHaveBeenCalledTimes(2), {
        timeout: 1_000,
        interval: 10,
      });
      await callback;

      expect(JSON.stringify(testState.streamText.mock.calls[1]?.[0]?.messages)).toContain(
        "选择了: A",
      );
      expect(logs).toContainEqual(
        expect.objectContaining({ message: "send_choice callback received" }),
      );
      expect(
        testState.requests.some(
          ({ method, body }) =>
            method === "sendMessage" &&
            (body as { text?: string } | undefined)?.text === "已按选择继续",
        ),
      ).toBe(true);
    } finally {
      void callback;
      await disposeBot(bot);
    }
  });
});
