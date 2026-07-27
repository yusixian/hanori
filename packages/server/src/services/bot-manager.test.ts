import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBot: vi.fn(() => ({ api: {} })),
  disposeBot: vi.fn(),
  run: vi.fn<
    (
      _bot: unknown,
      _options?: unknown,
    ) => { stop: () => Promise<void>; task: () => Promise<void> | undefined }
  >(() => ({ stop: vi.fn(async () => {}), task: vi.fn(() => undefined) })),
}));

vi.mock("@cos-tool-bot/bot", () => ({
  createBot: mocks.createBot,
  disposeBot: mocks.disposeBot,
  recoverPixAIGeneration: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({ run: mocks.run }));

import { BotManager, TELEGRAM_LONG_POLL_UPDATE_TYPES } from "./bot-manager.js";
import type { DbLogger } from "./db-logger.js";

function createManager(): BotManager {
  const dbLogger = {
    info: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    log: vi.fn(async () => {}),
  } as unknown as DbLogger;
  return new BotManager({
    botId: "bot-1",
    token: "123:test",
    adminChatIds: [1],
    logger: {} as Logger,
    dbLogger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createBot.mockImplementation(() => ({ api: {} }));
  mocks.disposeBot.mockImplementation(() => {});
  mocks.run.mockImplementation(() => ({
    stop: vi.fn(async () => {}),
    task: vi.fn(() => undefined),
  }));
});

describe("BotManager runtime disposal", () => {
  it("resets Telegram allowed updates instead of inheriting stale server state", async () => {
    const manager = createManager();

    await manager.start();

    expect(mocks.run).toHaveBeenCalledWith(expect.anything(), {
      runner: { fetch: { allowed_updates: TELEGRAM_LONG_POLL_UPDATE_TYPES } },
    });
    expect(TELEGRAM_LONG_POLL_UPDATE_TYPES).toContain("message");
    expect(TELEGRAM_LONG_POLL_UPDATE_TYPES).toContain("my_chat_member");
  });

  it("forwards Telegram observation callbacks into the bot runtime", async () => {
    const telegramObservation = { onChatObserved: vi.fn() };
    const manager = new BotManager({
      botId: "bot-1",
      token: "123:test",
      adminChatIds: [1],
      logger: {} as Logger,
      dbLogger: {
        info: vi.fn(async () => {}),
        warn: vi.fn(async () => {}),
        error: vi.fn(async () => {}),
        log: vi.fn(async () => {}),
      } as unknown as DbLogger,
      telegramObservation,
    });

    await manager.start();

    expect(mocks.createBot).toHaveBeenCalledWith(expect.objectContaining({ telegramObservation }));
  });

  it("disposes every bot runtime across repeated starts and stops", async () => {
    const manager = createManager();

    await manager.start();
    const firstBot = mocks.createBot.mock.results[0]!.value;
    await manager.stop();
    await manager.start();
    const secondBot = mocks.createBot.mock.results[1]!.value;
    await manager.stop();

    expect(mocks.disposeBot).toHaveBeenNthCalledWith(1, firstBot);
    expect(mocks.disposeBot).toHaveBeenNthCalledWith(2, secondBot);
    expect(manager.status).toBe("stopped");
  });

  it("aborts an active job before waiting for the runner to stop", async () => {
    const manager = createManager();
    const activeJob = new AbortController();
    mocks.disposeBot.mockImplementationOnce(() => activeJob.abort(new Error("bot disposed")));
    const stop = vi.fn(async () => {
      expect(activeJob.signal.aborted).toBe(true);
    });
    mocks.run.mockImplementationOnce(() => ({ stop, task: vi.fn(() => undefined) }));
    await manager.start();

    await manager.stop();

    expect(mocks.disposeBot).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps runtime state disposed when runner shutdown fails", async () => {
    const manager = createManager();
    const stopError = new Error("runner stop failed");
    mocks.run.mockImplementationOnce(() => ({
      stop: vi.fn(async () => {
        throw stopError;
      }),
      task: vi.fn(() => undefined),
    }));
    await manager.start();

    await expect(manager.stop()).rejects.toBe(stopError);

    expect(mocks.disposeBot).toHaveBeenCalledOnce();
    expect(manager.status).toBe("stopped");
  });

  it("disposes the created runtime when runner startup fails", async () => {
    const manager = createManager();
    mocks.run.mockImplementationOnce(() => {
      throw new Error("runner failed");
    });

    await manager.start();

    expect(mocks.disposeBot).toHaveBeenCalledWith(mocks.createBot.mock.results[0]!.value);
    expect(manager.status).toBe("stopped");
  });

  it("disposes the runtime when the runner crashes", async () => {
    const manager = createManager();
    let rejectTask!: (error: Error) => void;
    const task = new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    });
    mocks.run.mockImplementationOnce(() => ({
      stop: vi.fn(async () => {}),
      task: vi.fn(() => task),
    }));
    await manager.start();
    const bot = mocks.createBot.mock.results[0]!.value;

    rejectTask(new Error("runner crashed"));
    await vi.waitFor(() => expect(mocks.disposeBot).toHaveBeenCalledWith(bot));

    expect(manager.status).toBe("stopped");
  });
});
