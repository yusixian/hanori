import type { Logger } from "pino";
import type { PixAIGenerationRecord } from "@cos-tool-bot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingGenerationInsertFallbackTracker } from "./generation-recovery.js";
import { BotPool } from "./bot-pool.js";

vi.mock("../env.js", () => ({
  env: { ENCRYPTION_KEY: "test-key" },
}));

type DownloadImages = (
  botId: string,
  taskId: string,
  urls: string[],
  logger: Logger,
) => Promise<string[]>;

type CleanupImages = (botId: string, localFiles: string[], logger: Logger) => Promise<void>;

interface PersistenceTestPool {
  db: unknown;
  logger: Logger;
  generationInsertFallbacks: PendingGenerationInsertFallbackTracker;
  persistTerminalGeneration(
    botId: string,
    record: PixAIGenerationRecord,
    downloadImages: DownloadImages,
    cleanupImages: CleanupImages,
  ): Promise<void>;
}

function completedRecord(): PixAIGenerationRecord {
  return {
    chatId: 123,
    taskId: "task-1",
    prompt: "prompt",
    modelId: "model",
    width: 512,
    height: 512,
    batchSize: 1,
    status: "completed",
    mediaUrls: ["https://example.com/image.png"],
  };
}

function createPool() {
  const claimReturning = vi.fn().mockResolvedValue([{ id: 1 }]);
  const localFilesReturning = vi.fn().mockResolvedValue([{ id: 1 }]);
  const terminalSets: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      terminalSets.push(values);
      return {
        where: vi.fn(() => ({
          returning: "localFiles" in values ? localFilesReturning : claimReturning,
        })),
      };
    }),
  }));
  const selectRows: Array<{ id: number }> = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(selectRows) })),
  }));
  const insertReturning = vi.fn().mockResolvedValue([{ id: 2 }]);
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ returning: insertReturning })),
  }));
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const pool = Object.create(BotPool.prototype) as PersistenceTestPool;
  pool.db = { update, select, insert };
  pool.logger = logger;
  pool.generationInsertFallbacks = new PendingGenerationInsertFallbackTracker();
  return {
    pool,
    logger,
    terminalSets,
    claimReturning,
    localFilesReturning,
    insertReturning,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BotPool terminal generation persistence", () => {
  it("does not download images after losing the terminal claim", async () => {
    const { pool, claimReturning } = createPool();
    claimReturning.mockResolvedValue([]);
    const downloadImages = vi.fn<DownloadImages>().mockResolvedValue(["task-1_0.png"]);

    await expect(
      pool.persistTerminalGeneration(
        "bot-a",
        completedRecord(),
        downloadImages,
        vi.fn<CleanupImages>(),
      ),
    ).rejects.toThrow("already claimed or is no longer pending");

    expect(downloadImages).not.toHaveBeenCalled();
  });

  it("downloads only after claiming completed state, then stores local files separately", async () => {
    const { pool, claimReturning, localFilesReturning, terminalSets } = createPool();
    const order: string[] = [];
    claimReturning.mockImplementation(async () => {
      order.push("claim");
      return [{ id: 1 }];
    });
    const downloadImages = vi.fn<DownloadImages>().mockImplementation(async () => {
      order.push("download");
      return ["task-1_0.png"];
    });
    localFilesReturning.mockImplementation(async () => {
      order.push("local-files");
      return [{ id: 1 }];
    });

    await pool.persistTerminalGeneration(
      "bot-a",
      completedRecord(),
      downloadImages,
      vi.fn<CleanupImages>(),
    );

    expect(order).toEqual(["claim", "download", "local-files"]);
    expect(terminalSets[0]).toMatchObject({ status: "completed" });
    expect(terminalSets[0]).not.toHaveProperty("localFiles");
    expect(terminalSets[1]).toEqual({ localFiles: ["task-1_0.png"] });
  });

  it("cleans up downloaded files when the claimed row was deleted", async () => {
    const { pool, localFilesReturning, logger } = createPool();
    localFilesReturning.mockResolvedValue([]);
    const cleanupImages = vi.fn<CleanupImages>().mockResolvedValue();

    await pool.persistTerminalGeneration(
      "bot-a",
      completedRecord(),
      vi.fn<DownloadImages>().mockResolvedValue(["task-1_0.png"]),
      cleanupImages,
    );

    expect(cleanupImages).toHaveBeenCalledWith("bot-a", ["task-1_0.png"], logger);
  });

  it("keeps the completed claim and downloaded files when localFiles persistence is ambiguous", async () => {
    const { pool, claimReturning, localFilesReturning, logger, terminalSets } = createPool();
    claimReturning.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([]);
    localFilesReturning.mockRejectedValue(new Error("database unavailable"));
    const downloadImages = vi.fn<DownloadImages>().mockResolvedValue(["task-1_0.png"]);
    const cleanupImages = vi.fn<CleanupImages>();

    await expect(
      pool.persistTerminalGeneration("bot-a", completedRecord(), downloadImages, cleanupImages),
    ).resolves.toBeUndefined();
    await expect(
      pool.persistTerminalGeneration("bot-a", completedRecord(), downloadImages, cleanupImages),
    ).rejects.toThrow("already claimed or is no longer pending");

    expect(downloadImages).toHaveBeenCalledOnce();
    expect(cleanupImages).not.toHaveBeenCalled();
    expect(terminalSets).not.toContainEqual(expect.objectContaining({ status: "pending" }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
      expect.stringContaining("commit outcome is unknown"),
    );
  });

  it("downloads after a pending-insert fallback wins the terminal claim", async () => {
    const { pool, claimReturning, insertReturning } = createPool();
    const order: string[] = [];
    pool.generationInsertFallbacks.markPendingInsertFailure("bot-a", "task-1");
    claimReturning.mockResolvedValue([]);
    insertReturning.mockImplementation(async () => {
      order.push("fallback-claim");
      return [{ id: 2 }];
    });
    const downloadImages = vi.fn<DownloadImages>().mockImplementation(async () => {
      order.push("download");
      return ["task-1_0.png"];
    });

    await pool.persistTerminalGeneration(
      "bot-a",
      completedRecord(),
      downloadImages,
      vi.fn<CleanupImages>(),
    );

    expect(order).toEqual(["fallback-claim", "download"]);
  });
});
