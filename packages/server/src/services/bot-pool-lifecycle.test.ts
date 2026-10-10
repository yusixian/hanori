import type { Database } from "@cos-tool-bot/database";
import type { BotConfig, CosInsideCommandConfig } from "@cos-tool-bot/bot";
import {
  DEFAULT_CONVERSATION_CONFIG,
  type BotStatus,
  type IBotManager,
  type UsageGovernancePort,
} from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerRegistry } from "./timer-registry.js";

interface FakeManager extends IBotManager {
  status: BotStatus;
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

interface FakeManagerOptions {
  conversation?: {
    ensureCompression: (chatId: number) => Promise<void>;
    triggerCompression: (chatId: number) => void | Promise<void>;
  };
  cosInside?: CosInsideCommandConfig;
  quota?: BotConfig["quota"];
  timerCallbacks?: {
    onBotReady?: (handlers: {
      fireTimer: () => Promise<boolean>;
      cancelPendingTimer: () => void;
    }) => void;
  };
}

const managerMocks = vi.hoisted(() => ({
  factories: [] as Array<(options: FakeManagerOptions) => FakeManager>,
  created: [] as FakeManager[],
}));

const compressorMocks = vi.hoisted(() => ({
  compressConversation: vi.fn(async () => undefined),
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
    constructor(options: FakeManagerOptions) {
      const factory = managerMocks.factories.shift();
      if (!factory) throw new Error("Missing fake BotManager factory");
      const manager = factory(options);
      managerMocks.created.push(manager);
      return manager;
    }
  },
}));

vi.mock("./conversation-compressor.js", () => compressorMocks);

import { BotPool } from "./bot-pool.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function botRow(
  aiConfig: unknown = null,
  cosInsideConfig: { targets: Array<{ alias: string; chatId: number }> } | null = null,
) {
  return {
    id: BOT_ID,
    name: "Lifecycle Bot",
    platform: "telegram",
    encryptedToken: "encrypted-token",
    adminChatIds: [],
    aiConfig,
    cosInsideConfig,
    larkWebhookConfig: null,
    emailForwardConfig: null,
    isActive: true,
    miniAppEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createPool(resumeBot = vi.fn(async () => 0), row: ReturnType<typeof botRow> = botRow()) {
  const where = vi.fn(async () => [row]);
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
  } as unknown as Database;
  const timerRegistry = {
    pauseBot: vi.fn(async () => 0),
    resumeBot,
    listActive: vi.fn(() => []),
    cancel: vi.fn(async () => false),
  } as unknown as TimerRegistry;
  const pool = new BotPool(
    db,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    timerRegistry,
  );
  const recoverPendingTurns = vi
    .spyOn(pool.getConversationStore(), "recoverPendingTurns")
    .mockResolvedValue(0);
  return {
    pool,
    where,
    recoverPendingTurns,
    internals: pool as unknown as {
      managers: Map<string, IBotManager>;
      botTimerHandlers: Map<string, unknown>;
    },
  };
}

function fakeManager(
  options: FakeManagerOptions,
  setup: (manager: FakeManager) => void,
): FakeManager {
  const manager = {
    botId: BOT_ID,
    status: "stopped",
    uptime: null,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    sendHtml: vi.fn(async () => undefined),
  } as unknown as FakeManager;
  options.timerCallbacks?.onBotReady?.({
    fireTimer: vi.fn(async () => true),
    cancelPendingTimer: vi.fn(),
  });
  setup(manager);
  return manager;
}

beforeEach(() => {
  managerMocks.factories.length = 0;
  managerMocks.created.length = 0;
  compressorMocks.compressConversation.mockClear();
});

describe("BotPool failed runtime cleanup", () => {
  it("wires effective target history policy and the durable relay projection", async () => {
    let cosInside: CosInsideCommandConfig | undefined;
    let conversation: FakeManagerOptions["conversation"];
    managerMocks.factories.push((options) => {
      cosInside = options.cosInside;
      conversation = options.conversation;
      return fakeManager(options, (manager) => {
        manager.start.mockImplementation(async () => {
          manager.status = "running";
        });
      });
    });
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
      groupOverrides: {
        "-1001": { chatId: -1001, whitelisted: true, conversationEnabled: true },
        "-1002": { chatId: -1002, whitelisted: true, conversationEnabled: false },
        "-1003": {
          chatId: -1003,
          enabled: false,
          whitelisted: true,
          conversationEnabled: true,
        },
      },
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
      conversationConfig: {
        ...DEFAULT_CONVERSATION_CONFIG,
        enabled: false,
        maxRawMessagesPerChat: 0,
      },
    };
    const { pool } = createPool(
      vi.fn(async () => 0),
      botRow(aiConfig, {
        targets: [
          { alias: "saved", chatId: -1001 },
          { alias: "history-off", chatId: -1002 },
          { alias: "group-off", chatId: -1003 },
          { alias: "default-off", chatId: -1004 },
        ],
      }),
    );
    const addMessage = vi
      .spyOn(pool.getConversationStore(), "addMessage")
      .mockResolvedValue(undefined);

    await pool.startBot(BOT_ID);
    conversation!.triggerCompression = vi.fn(async () => {
      throw new Error("governance failed after persistence");
    });

    expect(cosInside?.history?.isEnabled(-1001)).toBe(true);
    expect(cosInside?.history?.isEnabled(-1002)).toBe(false);
    expect(cosInside?.history?.isEnabled(-1003)).toBe(false);
    expect(cosInside?.history?.isEnabled(-1004)).toBe(false);

    await expect(
      cosInside!.history!.save({
        targetChatId: -1001,
        body: "relay body",
        tgMessageId: 88,
        actorUserId: 42,
        actorName: "Admin Operator",
        replyToMessageId: 77,
      }),
    ).resolves.toBeUndefined();

    expect(addMessage).toHaveBeenCalledWith({
      botId: BOT_ID,
      chatId: -1001,
      role: "context",
      content: "relay body",
      userId: 42,
      userName: "Admin Operator",
      sourceKey: "telegram:88:cosinside",
      meta: {
        source: "cosinside",
        initiatorTelegramId: 42,
        initiatorName: "Admin Operator",
        tgMessageId: 88,
        publicGroupHistory: true,
        replyToMessageId: 77,
      },
    });
    expect(addMessage.mock.calls[0]?.[0]).not.toHaveProperty("userAuthoredContent");
    await vi.waitFor(() => expect(conversation!.triggerCompression).toHaveBeenCalledWith(-1001));
  });

  it("uses the dedicated conversation compression Provider at runtime", async () => {
    let conversation: FakeManagerOptions["conversation"];
    managerMocks.factories.push((options) => {
      conversation = options.conversation;
      return fakeManager(options, (manager) => {
        manager.start.mockImplementation(async () => {
          manager.status = "running";
        });
      });
    });
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
        {
          id: "compression-provider",
          label: "Compression Provider",
          encryptedApiKey: "encrypted-compression",
          baseURL: "https://compression.example/v1",
          providerFormat: "openai" as const,
          defaultModel: "summary-model",
        },
      ],
      activeProviderId: "chat-provider",
      conversationConfig: {
        ...DEFAULT_CONVERSATION_CONFIG,
        maxRawMessagesPerChat: 0,
        compressionProviderId: "compression-provider",
      },
    };
    const { pool } = createPool(
      vi.fn(async () => 0),
      botRow(aiConfig),
    );

    await pool.startBot(BOT_ID);
    await conversation!.ensureCompression(42);

    expect(compressorMocks.compressConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        baseURL: "https://compression.example/v1",
        model: "summary-model",
        force: true,
        keepRecent: 0,
      }),
    );
  });

  it("recovers pending conversation turns before accepting Telegram updates", async () => {
    managerMocks.factories.push((options) =>
      fakeManager(options, (manager) => {
        manager.start.mockImplementation(async () => {
          manager.status = "running";
        });
      }),
    );
    const { pool, recoverPendingTurns } = createPool();

    await expect(pool.startBot(BOT_ID)).resolves.toBeUndefined();

    expect(recoverPendingTurns).toHaveBeenCalledWith(BOT_ID);
    expect(recoverPendingTurns.mock.invocationCallOrder[0]).toBeLessThan(
      managerMocks.created[0]!.start.mock.invocationCallOrder[0]!,
    );
  });

  it("retains a manager whose start cleanup still cannot drain", async () => {
    const drainError = new Error("AI drain timed out");
    managerMocks.factories.push((options) =>
      fakeManager(options, (manager) => {
        manager.start.mockRejectedValueOnce(new Error("runner startup failed"));
        manager.stop.mockRejectedValue(drainError);
      }),
    );
    const { pool, internals } = createPool();

    await expect(pool.startBot(BOT_ID)).rejects.toBe(drainError);
    expect(internals.managers.get(BOT_ID)).toBe(managerMocks.created[0]);
    expect(internals.botTimerHandlers.has(BOT_ID)).toBe(true);

    await expect(pool.startBot(BOT_ID)).rejects.toBe(drainError);
    expect(managerMocks.created).toHaveLength(1);
  });

  it("retains a fast-crashed manager until stale-manager stop succeeds", async () => {
    const drainError = new Error("AI drain timed out");
    managerMocks.factories.push(
      (options) =>
        fakeManager(options, (manager) => {
          manager.start.mockImplementation(async () => {
            manager.status = "stopped";
          });
          manager.stop.mockRejectedValueOnce(drainError).mockResolvedValueOnce(undefined);
        }),
      (options) =>
        fakeManager(options, (manager) => {
          manager.start.mockImplementation(async () => {
            manager.status = "running";
          });
        }),
    );
    const { pool, internals } = createPool();

    await expect(pool.startBot(BOT_ID)).rejects.toBe(drainError);
    expect(internals.managers.get(BOT_ID)).toBe(managerMocks.created[0]);
    expect(internals.botTimerHandlers.has(BOT_ID)).toBe(true);
    expect(managerMocks.created).toHaveLength(1);

    await expect(pool.startBot(BOT_ID)).resolves.toBeUndefined();
    expect(managerMocks.created).toHaveLength(2);
    expect(internals.managers.get(BOT_ID)).toBe(managerMocks.created[1]);
  });

  it("retains the manager when timer resume cleanup fails to drain", async () => {
    const resumeError = new Error("timer resume failed");
    const drainError = new Error("AI drain timed out");
    managerMocks.factories.push((options) =>
      fakeManager(options, (manager) => {
        manager.start.mockImplementation(async () => {
          manager.status = "running";
        });
        manager.stop.mockImplementation(async () => {
          manager.status = "stopped";
          throw drainError;
        });
      }),
    );
    const { pool, internals } = createPool(vi.fn(async () => Promise.reject(resumeError)));

    await expect(pool.startBot(BOT_ID)).rejects.toBe(drainError);
    expect(internals.managers.get(BOT_ID)).toBe(managerMocks.created[0]);
    expect(internals.botTimerHandlers.has(BOT_ID)).toBe(true);

    await expect(pool.startBot(BOT_ID)).rejects.toBe(drainError);
    expect(managerMocks.created).toHaveLength(1);
  });
});

describe("BotPool service binding", () => {
  it("lets a service set after start reach the running Bot's call-time lookups", async () => {
    let quota: FakeManagerOptions["quota"];
    managerMocks.factories.push((options) => {
      quota = options.quota;
      return fakeManager(options, (manager) => {
        manager.start.mockImplementation(async () => {
          manager.status = "running";
        });
      });
    });
    const snapshot = { timezone: "UTC", resources: [] };
    const assembled = { getSnapshot: vi.fn(async () => snapshot) };
    const replacement = { getSnapshot: vi.fn(async () => snapshot) };
    const { pool } = createPool();
    pool.setUsageGovernance(assembled as unknown as UsageGovernancePort);

    await pool.startBot(BOT_ID);
    pool.setUsageGovernance(replacement as unknown as UsageGovernancePort);
    await quota?.getUsage({ chatId: -1001, userId: 42, chatType: "group" });

    expect(replacement.getSnapshot).toHaveBeenCalledOnce();
    expect(assembled.getSnapshot).not.toHaveBeenCalled();
  });
});

describe("runtime-scoped MCP restarts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function addRunningManager() {
    managerMocks.factories.push((options) =>
      fakeManager(options, (manager) => {
        manager.start.mockImplementation(async () => {
          manager.status = "running";
        });
        manager.stop.mockImplementation(async () => {
          manager.status = "stopped";
        });
      }),
    );
  }
  function capture(pool: BotPool) {
    return (
      pool as unknown as { runtimeHost: import("./bot-runtime/types.js").BotRuntimeHost }
    ).runtimeHost.createDeferredRestart(BOT_ID);
  }

  it("coalesces successful changes and preserves the two-second delay", async () => {
    const { pool } = createPool();
    addRunningManager();
    addRunningManager();
    await pool.startBot(BOT_ID);
    const request = capture(pool);
    request();
    request();
    await vi.advanceTimersByTimeAsync(1999);
    expect(managerMocks.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(managerMocks.created).toHaveLength(2);
    expect(managerMocks.created[0]!.stop).toHaveBeenCalledOnce();
    await pool.stopAll();
  });

  it.each(["stop", "stopAll"])(
    "invalidates pending and late callback requests on %s",
    async (stop) => {
      const { pool } = createPool();
      addRunningManager();
      await pool.startBot(BOT_ID);
      const request = capture(pool);
      request();
      if (stop === "stop") await pool.stopBot(BOT_ID);
      else await pool.stopAll();
      request();
      await vi.advanceTimersByTimeAsync(5000);
      expect(pool.getManager(BOT_ID)).toBeUndefined();
      expect(managerMocks.created).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not let the old runtime restart its explicit replacement", async () => {
    const { pool } = createPool();
    addRunningManager();
    addRunningManager();
    await pool.startBot(BOT_ID);
    const oldRequest = capture(pool);
    oldRequest();
    await pool.restartBot(BOT_ID);
    oldRequest();
    await vi.advanceTimersByTimeAsync(5000);
    expect(managerMocks.created).toHaveLength(2);
    expect(managerMocks.created[1]!.stop).not.toHaveBeenCalled();
    await pool.stopAll();
  });
  it.each(["queued", "reading"])("honors stop after a deferred restart is %s", async (phase) => {
    const { pool, where } = createPool();
    addRunningManager();
    addRunningManager();
    await pool.startBot(BOT_ID);
    const request = capture(pool);
    let release!: (rows: ReturnType<typeof botRow>[]) => void;
    const pending = new Promise<ReturnType<typeof botRow>[]>((resolve) => {
      release = resolve;
    });
    where.mockImplementationOnce(() => pending);
    const blocker = phase === "queued" ? pool.startBot(BOT_ID) : undefined;
    request();
    await vi.advanceTimersByTimeAsync(2000);
    const stopped = pool.stopBot(BOT_ID);
    release([botRow()]);
    await blocker;
    await stopped;
    expect(managerMocks.created).toHaveLength(1);
    expect(pool.getManager(BOT_ID)).toBeUndefined();
  });
  it("drains a deferred rebuild that temporarily has no manager", async () => {
    const { pool, where } = createPool();
    addRunningManager();
    addRunningManager();
    await pool.startBot(BOT_ID);
    let release!: (rows: ReturnType<typeof botRow>[]) => void;
    const pending = new Promise<ReturnType<typeof botRow>[]>((resolve) => {
      release = resolve;
    });
    where.mockResolvedValueOnce([botRow()]).mockImplementationOnce(() => pending);
    capture(pool)();
    await vi.advanceTimersByTimeAsync(2000);
    expect(pool.getManager(BOT_ID)).toBeUndefined();
    let finished = false;
    const stopped = pool.stopAll().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    release([botRow()]);
    await stopped;
    expect(pool.getManager(BOT_ID)).toBeUndefined();
    expect(managerMocks.created[1]!.stop).toHaveBeenCalledOnce();
  });

  it("keeps future configuration refreshes working after an explicit restart fails", async () => {
    const { pool, where } = createPool();
    addRunningManager();
    addRunningManager();
    await pool.startBot(BOT_ID);
    const request = capture(pool);
    request();
    where.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(pool.restartBot(BOT_ID)).rejects.toThrow("database unavailable");
    await vi.advanceTimersByTimeAsync(2000);
    expect(managerMocks.created).toHaveLength(1);
    request();
    await vi.advanceTimersByTimeAsync(2000);
    expect(managerMocks.created).toHaveLength(2);
    await pool.stopAll();
  });
});
