import type { Database } from "@cos-tool-bot/database";
import {
  DEFAULT_CONVERSATION_CONFIG,
  type BotMemory,
  type BotMemoryCallbacks,
  type BotStatus,
  type IBotManager,
} from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerRegistry } from "./timer-registry.js";

const mocks = vi.hoisted(() => ({
  managerOptions: [] as Array<{ aiReply?: { botMemory?: BotMemoryCallbacks } }>,
  embed: vi.fn(async ({ value }: { value: string }) => ({ embedding: [value.length] })),
  embedMany: vi.fn(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((value) => [value.length]),
  })),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  embed: mocks.embed,
  embedMany: mocks.embedMany,
}));

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key", BETTER_AUTH_URL: "https://example.test" },
}));

vi.mock("../utils/crypto.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/crypto.js")>()),
  tryDecrypt: vi.fn(() => "test-token"),
}));

vi.mock("./bot-manager.js", () => ({
  BotManager: class {
    constructor(options: (typeof mocks.managerOptions)[number]) {
      mocks.managerOptions.push(options);
      const manager = {
        status: "stopped" as BotStatus,
        uptime: null,
        start: vi.fn(async () => {
          manager.status = "running";
        }),
        stop: vi.fn(async () => {
          manager.status = "stopped";
        }),
      };
      return manager as unknown as IBotManager;
    }
  },
}));

import { BotPool } from "./bot-pool.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

const aiConfig = {
  enabled: true,
  encryptedApiKey: null,
  baseURL: "",
  model: "",
  systemPrompt: "Be helpful.",
  triggerConfig: {
    replyToBot: true,
    mentionBot: true,
    triggerWords: [],
    randomReplyPercent: 0,
    randomReplyCooldown: 60,
  },
  groupOverrides: {},
  providers: [
    {
      id: "chat-provider",
      label: "Chat Provider",
      encryptedApiKey: "encrypted-chat",
      baseURL: "https://chat.example/v1",
      providerFormat: "openai" as const,
      defaultModel: "chat-model",
    },
  ],
  activeProviderId: "chat-provider",
  conversationConfig: { ...DEFAULT_CONVERSATION_CONFIG, maxRawMessagesPerChat: 0 },
  botMemoryConfig: { enabled: true, maxMemories: 20, autoInjectMemories: true },
  embeddingConfig: {
    enabled: true,
    encryptedApiKey: "encrypted-embedding",
    baseURL: "https://embedding.example/v1",
    model: "embedding-model",
    dimensions: 3072,
  },
};

function memory(content: string, id = 7): BotMemory {
  return {
    id,
    botId: BOT_ID,
    telegramId: 42,
    content,
    category: null,
    kind: "preference",
    scopeChatId: null,
    origin: "agent",
    sourceChatId: null,
    sourceMessageId: null,
    sourceUserId: null,
    expiresAt: null,
    factValidAt: null,
    isActive: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function createPool() {
  const row = {
    id: BOT_ID,
    name: "Memory Bot",
    platform: "telegram",
    encryptedToken: "encrypted-token",
    adminChatIds: [],
    aiConfig,
    cosInsideConfig: null,
    larkWebhookConfig: null,
    emailForwardConfig: null,
    isActive: true,
    miniAppEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => [row]) })) })),
  } as unknown as Database;
  const timerRegistry = {
    pauseBot: vi.fn(async () => 0),
    resumeBot: vi.fn(async () => 0),
    listActive: vi.fn(() => []),
    cancel: vi.fn(async () => false),
  } as unknown as TimerRegistry;
  const pool = new BotPool(
    db,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    timerRegistry,
  );
  vi.spyOn(pool.getConversationStore(), "recoverPendingTurns").mockResolvedValue(0);
  const store = pool.getBotMemoryStore();
  return {
    pool,
    store: {
      findSimilar: vi.spyOn(store, "findSimilar").mockResolvedValue([]),
      getMemory: vi.spyOn(store, "getMemory").mockResolvedValue(memory("Prefers tea")),
      saveMemory: vi
        .spyOn(store, "saveMemory")
        .mockImplementation(async (_botId, data) => memory(data.content, 8)),
      touchMemory: vi.spyOn(store, "touchMemory").mockResolvedValue(undefined),
      updateMemory: vi
        .spyOn(store, "updateMemory")
        .mockImplementation(async (_botId, memoryId, data) =>
          memory(data.content ?? "Prefers tea", memoryId),
        ),
      updateEmbeddingIfContentMatches: vi
        .spyOn(store, "updateEmbeddingIfContentMatches")
        .mockResolvedValue(true),
    },
  };
}

async function startWithAgentMemory(pool: BotPool): Promise<BotMemoryCallbacks> {
  await pool.startBot(BOT_ID);
  const botMemory = mocks.managerOptions.at(-1)?.aiReply?.botMemory;
  if (!botMemory) throw new Error("Bot memory callbacks were not wired");
  return botMemory;
}

beforeEach(() => {
  mocks.managerOptions.length = 0;
  mocks.embed.mockClear();
  mocks.embedMany.mockClear();
});

describe("BotPool memory writes", () => {
  it("re-embeds agent and admin content edits with the running Bot's embedder", async () => {
    const { pool, store } = createPool();
    const botMemory = await startWithAgentMemory(pool);
    const access = { chatId: 42, userId: 42 };

    await botMemory.updateMemory(
      7,
      { content: "Prefers green tea", expectedContent: "Prefers tea" },
      access,
    );
    await pool.updateBotMemoryForAdmin(BOT_ID, 7, { content: "Prefers oolong" });

    expect(store.updateMemory).toHaveBeenNthCalledWith(
      1,
      BOT_ID,
      7,
      { content: "Prefers green tea", expectedContent: "Prefers tea" },
      access,
    );
    expect(store.updateEmbeddingIfContentMatches.mock.calls).toEqual([
      [BOT_ID, 7, "Prefers green tea", [17]],
      [BOT_ID, 7, "Prefers oolong", [14]],
    ]);
  });

  it("dedups an agent save but inserts an admin memory with its vector", async () => {
    const { pool, store } = createPool();
    const botMemory = await startWithAgentMemory(pool);
    const existing = { ...memory("likes tea"), distance: 0.01 };
    store.findSimilar.mockResolvedValue([existing]);

    await expect(botMemory.saveMemory({ content: "Likes tea", telegramId: 42 })).resolves.toBe(
      existing,
    );
    expect(store.touchMemory).toHaveBeenCalledWith(7);
    expect(store.saveMemory).not.toHaveBeenCalled();

    await pool.createBotMemoryForAdmin(BOT_ID, {
      content: "Likes tea",
      telegramId: 42,
      origin: "admin",
    });
    expect(store.findSimilar).toHaveBeenCalledTimes(1);
    expect(store.saveMemory).toHaveBeenCalledWith(BOT_ID, {
      content: "Likes tea",
      telegramId: 42,
      origin: "admin",
      embedding: [9],
    });
  });

  it("gives batch writers the running Bot's embedder and saves text only once it stops", async () => {
    const { pool, store } = createPool();
    await startWithAgentMemory(pool);
    const writer = pool.getBotMemoryWriter();
    const consolidated = [{ id: 9, content: "Plans a trip" }];

    await writer.refreshEmbeddings(BOT_ID, consolidated, { embeddingTimeoutMs: 1_000 });
    expect(store.updateEmbeddingIfContentMatches).toHaveBeenCalledWith(
      BOT_ID,
      9,
      "Plans a trip",
      [12],
    );

    await pool.stopBot(BOT_ID);
    store.updateEmbeddingIfContentMatches.mockClear();
    mocks.embed.mockClear();
    mocks.embedMany.mockClear();

    await writer.refreshEmbeddings(BOT_ID, consolidated, { embeddingTimeoutMs: 1_000 });
    await pool.updateBotMemoryForAdmin(BOT_ID, 7, { content: "Prefers oolong" });
    await pool.createBotMemoryForAdmin(BOT_ID, { content: "Likes tea", origin: "admin" });

    expect(store.updateMemory).toHaveBeenCalledWith(
      BOT_ID,
      7,
      { content: "Prefers oolong" },
      undefined,
    );
    expect(store.saveMemory).toHaveBeenCalledWith(BOT_ID, {
      content: "Likes tea",
      origin: "admin",
      embedding: undefined,
    });
    expect(store.updateEmbeddingIfContentMatches).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.embedMany).not.toHaveBeenCalled();
  });
});
