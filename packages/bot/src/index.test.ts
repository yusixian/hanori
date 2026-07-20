import type { MemoryCallbacks, PeopleProfileObservation } from "@cos-tool-bot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const telegramApi = vi.hoisted(() => {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string) => {
    const method = new URL(input).pathname.split("/").pop()!;
    calls.push(method);
    const result =
      method === "sendMessage"
        ? {
            message_id: 1,
            date: 1_700_000_000,
            chat: { id: -100, type: "supergroup", title: "Test Group" },
            text: "ok",
          }
        : true;
    return { json: async () => ({ ok: true, result }) };
  });
  return { calls, fetch };
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

import { createBot } from "./index.js";

const chatId = -100;
const userId = 42;

afterEach(() => {
  telegramApi.calls.length = 0;
});

function createMemory() {
  const touchProfile = vi.fn(async (_observation: PeopleProfileObservation) => ({
    created: false,
    profileId: 1,
    avatarVersion: null,
  }));
  const memory = {
    getProfile: vi.fn(),
    upsertProfile: vi.fn(),
    searchProfiles: vi.fn(),
    searchHistory: vi.fn(),
    touchProfile,
    updateProfileAvatar: vi.fn(),
  } as unknown as MemoryCallbacks;
  return { memory, touchProfile };
}

function createProfileBot(options: { whitelisted?: boolean; adminIds?: number[] } = {}) {
  const { memory, touchProfile } = createMemory();
  const bot = createBot({
    token: "test-token",
    botId: "bot-1",
    adminChatIds: options.adminIds ?? [],
    logger: { warn: vi.fn(), error: vi.fn() } as never,
    aiReply: {
      botId: "bot-1",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "test-model",
      systemPrompt: "test",
      triggerConfig: {
        replyToBot: false,
        mentionBot: false,
        triggerWords: [],
        randomReplyPercent: 100,
        randomReplyCooldown: 0,
      },
      groupOverrides: {
        [chatId]: { chatId, whitelisted: options.whitelisted ?? true },
      },
      memoryConfig: {
        enabled: true,
        maxSteps: 1,
        autoReadProfile: false,
        autoUpdateLastSeen: true,
        toolChoice: "auto",
      },
      memory,
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
  return { bot, touchProfile, apiCalls: telegramApi.calls };
}

function groupMessage(content: Record<string, unknown>) {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup", title: "Test Group" },
      from: { id: userId, is_bot: false, first_name: "Ai", username: "sample" },
      ...content,
    },
  };
}

describe("createBot profile observation", () => {
  it("observes an authorized sticker without sending it to AI", async () => {
    const { bot, touchProfile, apiCalls } = createProfileBot();

    await bot.handleUpdate(
      groupMessage({
        sticker: {
          file_id: "sticker-1",
          file_unique_id: "sticker-unique-1",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
        },
      }) as never,
    );

    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(1));
    expect(apiCalls).not.toContain("sendChatAction");
  });

  it("continues observing normal messages after /stop disables AI replies", async () => {
    const { bot, touchProfile, apiCalls } = createProfileBot({ adminIds: [userId] });

    await bot.handleUpdate(
      groupMessage({
        text: "/stop",
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      }) as never,
    );
    await bot.handleUpdate(
      groupMessage({
        voice: {
          file_id: "voice-1",
          file_unique_id: "voice-unique-1",
          duration: 1,
        },
      }) as never,
    );

    await vi.waitFor(() => expect(touchProfile).toHaveBeenCalledTimes(1));
    expect(apiCalls).not.toContain("sendChatAction");
  });

  it("does not observe messages from an unwhitelisted group", async () => {
    const { bot, touchProfile, apiCalls } = createProfileBot({ whitelisted: false });

    await bot.handleUpdate(groupMessage({ text: "hello" }) as never);

    expect(touchProfile).not.toHaveBeenCalled();
    expect(apiCalls).not.toContain("sendChatAction");
  });
});
