import type { Database } from "@cos-tool-bot/database";
import type { BotStatus, IBotManager } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerRegistry } from "./timer-registry.js";

interface FakeManager extends IBotManager {
  status: BotStatus;
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

interface FakeManagerOptions {
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

import { BotPool } from "./bot-pool.js";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function botRow() {
  return {
    id: BOT_ID,
    name: "Lifecycle Bot",
    platform: "telegram",
    encryptedToken: "encrypted-token",
    adminChatIds: [],
    aiConfig: null,
    larkWebhookConfig: null,
    emailForwardConfig: null,
    isActive: true,
    miniAppEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createPool(resumeBot = vi.fn(async () => 0)) {
  const where = vi.fn(async () => [botRow()]);
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
});

describe("BotPool failed runtime cleanup", () => {
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
