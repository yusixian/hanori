import {
  TELEGRAM_COMMAND_CATALOG,
  type MemoryCallbacks,
  type PeopleProfileObservation,
} from "@cos-tool-bot/shared";
import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";

const telegramApi = vi.hoisted(() => {
  const calls: string[] = [];
  const requests: Array<{ method: string; body?: unknown }> = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const method = new URL(input).pathname.split("/").pop()!;
    calls.push(method);
    requests.push({
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
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
  return { calls, fetch, requests };
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

import {
  buildUpdateErrorMessage,
  createBot,
  getActiveBotCommands,
  type AiSelectionCallbacks,
  type BotAiSelectionRuntime,
} from "./index.js";

const chatId = -100;
const userId = 42;

afterEach(() => {
  telegramApi.calls.length = 0;
  telegramApi.requests.length = 0;
});

function createCommandTestBot(
  configuration: "minimal" | "complete" = "minimal",
  modelCommandAccess?: "admin" | "all",
  aiSelectionCallbacks?: AiSelectionCallbacks,
) {
  const complete = configuration === "complete";
  return createBot({
    token: "test-token",
    botId: "bot-commands",
    adminChatIds: [userId],
    logger: { warn: vi.fn(), error: vi.fn() } as never,
    miniAppUrl: complete ? "https://panel.example/mini-app/bot-commands/help" : undefined,
    aiReply: complete
      ? {
          botId: "bot-commands",
          apiKey: "test-key",
          baseURL: "https://example.test/v1",
          model: "model-a",
          systemPrompt: "test",
          triggerConfig: {
            replyToBot: false,
            mentionBot: false,
            triggerWords: [],
            randomReplyPercent: 0,
            randomReplyCooldown: 0,
          },
          groupOverrides: {},
          models: [{ id: "model-a", label: "Model A" }],
          providers: [
            {
              id: "provider-a",
              label: "Provider A",
              apiKey: "key-a",
              baseURL: "https://a.example/v1",
              providerFormat: "openai",
              defaultModel: "model-a",
              models: [
                { id: "model-a", label: "Model A" },
                { id: "model-a-2", label: "Model A 2" },
              ],
            },
            {
              id: "provider-b",
              label: "Provider B",
              apiKey: "key-b",
              baseURL: "https://b.example/v1",
              providerFormat: "openai",
              defaultModel: "model-b",
              models: [{ id: "model-b", label: "Model B" }],
            },
          ],
          activeProviderId: "provider-a",
          modelCommandAccess,
          webToolsConfig: {
            enabled: true,
            imageGeneration: {
              provider: "pixai",
              apiKey: "image-key",
              model: "image-model",
              pixaiConfig: {},
            },
          },
        }
      : undefined,
    privacy: complete
      ? {
          getMode: async () => "normal",
          runExclusive: async (_userId, operation) => operation(),
          setMode: async () => {},
          forget: async () => ({ conversationMessages: 0, profiles: 0, personalMemories: 0 }),
        }
      : undefined,
    timerCallbacks: complete
      ? {
          onGetTimers: () => [],
          onCancelTimer: async () => false,
        }
      : undefined,
    aiSelectionCallbacks,
    mcpCallbacks: complete
      ? {
          listServers: async () => [],
          addServer: async () => ({ ok: true }),
          removeServer: async () => ({ ok: true }),
        }
      : undefined,
    summary: complete
      ? {
          botId: "bot-commands",
          triggerManual: async () => ({ ok: true }),
          getAccessMode: async () => "all",
          adminChatIds: [userId],
        }
      : undefined,
  });
}

describe("createBot command registry", () => {
  it("publishes only commands that were actually registered", async () => {
    const bot = createCommandTestBot();
    const activeCommands = getActiveBotCommands(bot);
    expect(activeCommands.map(({ command }) => command)).toEqual([
      "start",
      "help",
      "md2tg",
      "status",
      "restart",
      "backup",
      "clear",
      "clearreceived",
    ]);

    expect(activeCommands.map(({ command }) => command)).not.toContain("provider");
    expect(activeCommands.map(({ command }) => command)).not.toContain("model");
    expect(activeCommands.map(({ command }) => command)).not.toContain("privacy");
    expect(activeCommands.map(({ command }) => command)).not.toContain("stop");
    expect(activeCommands.map(({ command }) => command)).not.toContain("timers");

    await vi.waitFor(() => expect(telegramApi.calls).toContain("setMyCommands"));
    const request = telegramApi.requests.find(({ method }) => method === "setMyCommands");
    expect(request).toBeDefined();
    const published = (
      request!.body as { commands: Array<{ command: string; description: string }> }
    ).commands;
    expect(published.map(({ command }) => command)).toEqual(
      activeCommands.map(({ command }) => command),
    );
    expect(published.find(({ command }) => command === "clear")?.description).toBe(
      "清除当前对话历史",
    );
  });

  it("keeps conditional provider/model commands in the registry, menu, and help together", async () => {
    const bot = createCommandTestBot("complete");
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
    const activeNames = getActiveBotCommands(bot).map(({ command }) => command);
    expect(activeNames).toEqual(TELEGRAM_COMMAND_CATALOG.map(({ command }) => command));

    await bot.handleUpdate(
      groupMessage({
        text: "/help",
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      }) as never,
    );

    const menuRequest = telegramApi.requests.find(({ method }) => method === "setMyCommands");
    expect(menuRequest).toBeDefined();
    const menuNames = (menuRequest!.body as { commands: Array<{ command: string }> }).commands.map(
      ({ command }) => command,
    );
    expect(menuNames).toEqual(activeNames);

    const helpRequest = telegramApi.requests.find(({ method }) => method === "sendMessage");
    expect(helpRequest).toBeDefined();
    const helpText = (helpRequest!.body as { text: string }).text;
    const helpNames = [...helpText.matchAll(/^\/([a-z0-9_]+) - /gm)].map((match) => match[1]);
    expect(helpNames).toEqual(activeNames);
  });

  it("opens the Mini App in private chats and directs groups to the private Bot chat", async () => {
    const bot = createCommandTestBot("complete");
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

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: userId, type: "private", first_name: "Ai" },
        from: { id: userId, is_bot: false, first_name: "Ai" },
        text: "/panel",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    } as never);
    const privateReply = telegramApi.requests.find(({ method }) => method === "sendMessage");
    expect(privateReply?.body).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ web_app: { url: "https://panel.example/mini-app/bot-commands/help" } }],
        ],
      },
    });

    telegramApi.requests.length = 0;
    await bot.handleUpdate(
      groupMessage({
        text: "/panel",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }) as never,
    );
    const groupReply = telegramApi.requests.find(({ method }) => method === "sendMessage");
    expect(groupReply?.body).toMatchObject({
      text: expect.stringContaining("private chat"),
      reply_markup: {
        inline_keyboard: [[{ url: "https://t.me/test_bot" }]],
      },
    });
    expect(groupReply?.body).not.toMatchObject({
      reply_markup: { inline_keyboard: [[{ web_app: expect.anything() }]] },
    });
  });

  it("keeps model and provider Admin-only when legacy config requests public access", () => {
    const bot = createCommandTestBot("complete", "all");
    const selectionCommands = getActiveBotCommands(bot).filter(
      ({ command }) => command === "model" || command === "provider",
    );

    expect(selectionCommands).toHaveLength(2);
    expect(selectionCommands.map(({ effectiveAccess }) => effectiveAccess)).toEqual([
      "admin",
      "admin",
    ]);
  });

  it("exposes atomic selection snapshot publishing through the Bot runtime controller", async () => {
    let runtime!: BotAiSelectionRuntime;
    const callbacks: AiSelectionCallbacks = {
      setModel: vi.fn(async () => {}),
      resetModel: vi.fn(async () => {}),
      setProvider: vi.fn(async () => {}),
      resetProvider: vi.fn(async () => {}),
      onBotReady: (value) => {
        runtime = value;
      },
    };
    const bot = createCommandTestBot("complete", undefined, callbacks);
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

    runtime.applyAiSelectionSnapshot({
      global: { activeProviderId: "provider-a", activeModelId: "model-a-2" },
      chats: {},
    });
    await bot.handleUpdate(
      groupMessage({
        text: "/model",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }) as never,
    );

    const replies = telegramApi.requests.filter(({ method }) => method === "sendMessage");
    expect((replies.at(-1)!.body as { text: string }).text).toContain("当前模型: `model-a-2`");
  });

  it("guards model and provider execution when legacy config requests public access", async () => {
    const bot = createCommandTestBot("complete", "all");
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

    for (const command of ["model", "provider"]) {
      await bot.handleUpdate(
        groupMessage(
          {
            text: `/${command} 1`,
            entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
          },
          userId + 1,
        ) as never,
      );
    }

    await vi.waitFor(() =>
      expect(telegramApi.requests.filter(({ method }) => method === "sendMessage")).toHaveLength(2),
    );
    const replies = telegramApi.requests
      .filter(({ method }) => method === "sendMessage")
      .map(({ body }) => (body as { text: string }).text);
    expect(replies).toEqual([
      "[权限不足] 这种事人家确实帮不上忙呢，可以找管理员试试哟～",
      "[权限不足] 这种事人家确实帮不上忙呢，可以找管理员试试哟～",
    ]);
  });
});

describe("createBot Telegram observation", () => {
  it("wires ordinary group updates to the configured observation callbacks", async () => {
    const onChatObserved = vi.fn();
    const bot = createBot({
      token: "test-token",
      botId: "bot-observation",
      adminChatIds: [],
      logger: { warn: vi.fn(), error: vi.fn() } as never,
      telegramObservation: { onChatObserved },
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

    await bot.handleUpdate(groupMessage({ text: "directory observation" }) as never);

    expect(onChatObserved).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "chat",
        botId: "bot-observation",
        chatId,
        chatType: "supergroup",
        title: "Test Group",
      }),
    );
  });
});

function createMemory() {
  const touchProfile = vi.fn(async (_observation: PeopleProfileObservation) => ({
    created: false,
    profileId: 1,
  }));
  const memory = {
    getProfile: vi.fn(),
    upsertProfile: vi.fn(),
    searchProfiles: vi.fn(),
    searchHistory: vi.fn(),
    touchProfile,
    beginProfileAvatarRefresh: vi.fn(async () => 1),
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

function groupMessage(content: Record<string, unknown>, senderId = userId) {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup", title: "Test Group" },
      from: { id: senderId, is_bot: false, first_name: "Ai", username: "sample" },
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

describe("buildUpdateErrorMessage", () => {
  it("includes the raw GrammyError description without any Markdown wrapping", () => {
    const description =
      "can't parse entities: Character '(' is reserved and must be escaped with the preceding '\\'";
    const error = new GrammyError(
      "Bad Request",
      { ok: false, error_code: 400, description },
      "sendMessage",
      {},
    );

    const message = buildUpdateErrorMessage(537972451, error);

    expect(message).toBe(`处理消息 537972451 时出错:\nError in request: ${description}`);
    expect(message).not.toContain("```");
  });

  it("falls back to the error message for unknown errors", () => {
    expect(buildUpdateErrorMessage(1, new Error("boom"))).toBe(
      "处理消息 1 时出错:\nUnknown error: boom",
    );
    expect(buildUpdateErrorMessage(1, "nope")).toBe("处理消息 1 时出错:\nUnknown error: nope");
  });
});
