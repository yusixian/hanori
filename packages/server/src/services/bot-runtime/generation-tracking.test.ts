import type { Logger } from "pino";
import type { PixAIGenerationRecord } from "@cos-tool-bot/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbLogger } from "../db-logger.js";
import { assembleBotRuntime } from "./index.js";
import { runtimeHost, runtimeInput, runtimeServices } from "./test-fakes.js";

type DownloadImages = (
  botId: string,
  taskId: string,
  urls: string[],
  logger: Logger,
) => Promise<string[]>;

type CleanupImages = (botId: string, localFiles: string[], logger: Logger) => Promise<void>;

const files = vi.hoisted(() => ({
  downloadImages: vi.fn<DownloadImages>(),
  cleanupImages: vi.fn<CleanupImages>(),
}));

vi.mock("./generation-files.js", () => ({
  downloadGenerationImages: files.downloadImages,
  cleanupGenerationImages: files.cleanupImages,
}));

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

async function createTracker() {
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
  const services = runtimeServices({ update, select, insert }, logger);
  const runtime = await assembleBotRuntime(
    runtimeInput({} as DbLogger, { bot: { id: "bot-a" } }),
    services,
    runtimeHost(),
  );
  const track = runtime.managerOptions.onGenerationTrack;
  if (!track) throw new Error("Generation tracking was not wired");
  return {
    track,
    fallbacks: services.generationInsertFallbacks,
    logger,
    terminalSets,
    claimReturning,
    localFilesReturning,
    insertReturning,
  };
}

beforeEach(() => {
  files.downloadImages.mockReset();
  files.cleanupImages.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bot runtime terminal generation persistence", () => {
  it("does not download images after losing the terminal claim", async () => {
    const { track, claimReturning } = await createTracker();
    claimReturning.mockResolvedValue([]);
    files.downloadImages.mockResolvedValue(["task-1_0.png"]);

    await expect(track(completedRecord())).rejects.toThrow(
      "already claimed or is no longer pending",
    );

    expect(files.downloadImages).not.toHaveBeenCalled();
  });

  it("downloads only after claiming completed state, then stores local files separately", async () => {
    const { track, claimReturning, localFilesReturning, terminalSets } = await createTracker();
    const order: string[] = [];
    claimReturning.mockImplementation(async () => {
      order.push("claim");
      return [{ id: 1 }];
    });
    files.downloadImages.mockImplementation(async () => {
      order.push("download");
      return ["task-1_0.png"];
    });
    localFilesReturning.mockImplementation(async () => {
      order.push("local-files");
      return [{ id: 1 }];
    });

    await track(completedRecord());

    expect(order).toEqual(["claim", "download", "local-files"]);
    expect(terminalSets[0]).toMatchObject({ status: "completed" });
    expect(terminalSets[0]).not.toHaveProperty("localFiles");
    expect(terminalSets[1]).toEqual({ localFiles: ["task-1_0.png"] });
  });

  it("cleans up downloaded files when the claimed row was deleted", async () => {
    const { track, localFilesReturning, logger } = await createTracker();
    localFilesReturning.mockResolvedValue([]);
    files.downloadImages.mockResolvedValue(["task-1_0.png"]);
    files.cleanupImages.mockResolvedValue();

    await track(completedRecord());

    expect(files.cleanupImages).toHaveBeenCalledWith("bot-a", ["task-1_0.png"], logger);
  });

  it("keeps the completed claim and downloaded files when localFiles persistence is ambiguous", async () => {
    const { track, claimReturning, localFilesReturning, logger, terminalSets } =
      await createTracker();
    claimReturning.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([]);
    localFilesReturning.mockRejectedValue(new Error("database unavailable"));
    files.downloadImages.mockResolvedValue(["task-1_0.png"]);

    await expect(track(completedRecord())).resolves.toBeUndefined();
    await expect(track(completedRecord())).rejects.toThrow(
      "already claimed or is no longer pending",
    );

    expect(files.downloadImages).toHaveBeenCalledOnce();
    expect(files.cleanupImages).not.toHaveBeenCalled();
    expect(terminalSets).not.toContainEqual(expect.objectContaining({ status: "pending" }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
      expect.stringContaining("commit outcome is unknown"),
    );
  });

  it("downloads after a pending-insert fallback wins the terminal claim", async () => {
    const { track, fallbacks, claimReturning, insertReturning } = await createTracker();
    const order: string[] = [];
    fallbacks.markPendingInsertFailure("bot-a", "task-1");
    claimReturning.mockResolvedValue([]);
    insertReturning.mockImplementation(async () => {
      order.push("fallback-claim");
      return [{ id: 2 }];
    });
    files.downloadImages.mockImplementation(async () => {
      order.push("download");
      return ["task-1_0.png"];
    });

    await track(completedRecord());

    expect(order).toEqual(["fallback-claim", "download"]);
  });
});
