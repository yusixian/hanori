import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IsolatedAudioConverter } from "../media/isolated-converter.js";
import { VideoDownloadCache } from "./cache.js";
import type { VideoDownloadConfiguration, VideoDownloadStage } from "./contracts.js";
import { VideoDownloadExecutor } from "./executor.js";
import type { VideoDownloadRow } from "./service.js";

const mocks = vi.hoisted(() => ({
  getVideo: vi.fn(),
  getVideoMedia: vi.fn(),
  client: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../media/bilibili.js", () => ({ createBilibiliClient: mocks.client }));
vi.mock("../media/http.js", async () => ({
  ...(await vi.importActual<typeof import("../media/http.js")>("../media/http.js")),
  downloadMediaFile: mocks.download,
}));
const bvid = "BV1xx411c7mD";
const sourceUrl = `https://www.bilibili.com/video/${bvid}`;
const videoBytes = Buffer.from("synthetic-video");
const audioBytes = Buffer.from("synthetic-audio");
const outputBytes = Buffer.from("synthetic-muxed-output");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const metadata = (bytes: Buffer) => ({
  bytes: bytes.length,
  sha256: sha256(bytes),
  durationSeconds: 60,
});
const config: VideoDownloadConfiguration = {
  revision: 1,
  installationRevision: 3,
  cookie: "synthetic-private-cookie",
  limits: {
    maxDurationSeconds: 600,
    maxBytes: 1000,
    maxCacheBytes: 2_000_000,
    minFreeDiskBytes: 50,
    cacheTtlMs: 60_000,
    dailyJobs: 5,
  },
};
function row(): VideoDownloadRow {
  return {
    id: randomUUID(),
    botId: randomUUID(),
    chatId: -100,
    userId: 42,
    threadId: 7,
    configRevision: 1,
    installationRevision: 3,
    sourceUrl,
    provider: "bilibili",
    bvid,
    part: 1,
    title: "Synthetic clip",
    durationSeconds: 60,
    status: "queued",
    error: null,
    bytes: null,
    messageId: null,
    cancelRequested: false,
    cleanupPending: false,
    cacheExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("video download executor", () => {
  let temporary: string;
  let root: string;
  let free: number;
  let cache: VideoDownloadCache;
  let executor: VideoDownloadExecutor;
  let converter: Pick<IsolatedAudioConverter, "health" | "muxVideo" | "cancel">;
  let stages: VideoDownloadStage[];
  const options = () => ({
    signal: new AbortController().signal,
    onStage: async (stage: VideoDownloadStage) => {
      stages.push(stage);
    },
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    temporary = await mkdtemp(join(tmpdir(), "video-executor-test-"));
    root = join(temporary, "video-downloads");
    free = 10_000_000;
    cache = new VideoDownloadCache({
      root,
      statfs: async () => ({ bavail: BigInt(free), bsize: 1n }),
    });
    stages = [];
    mocks.client.mockReturnValue({ getVideo: mocks.getVideo, getVideoMedia: mocks.getVideoMedia });
    mocks.getVideo.mockResolvedValue({
      bvid,
      selectedPart: 1,
      url: sourceUrl,
      title: "Synthetic clip",
      reference: "synthetic-ref",
      parts: [{ part: 1, durationSeconds: 60 }],
    });
    mocks.getVideoMedia.mockResolvedValue({
      video: { url: "https://media.example/video", allowedHosts: ["media.example"] },
      audio: { url: "https://media.example/audio", allowedHosts: ["media.example"] },
    });
    mocks.download.mockImplementation(
      async (
        url: string,
        policy: { maxBytes: number; onProgress(): Promise<void> },
        destination: string,
      ) => {
        const bytes = url.endsWith("/video") ? videoBytes : audioBytes;
        if (bytes.length > policy.maxBytes) throw new Error("Download byte limit exceeded");
        await writeFile(destination, bytes);
        await policy.onProgress();
        return metadata(bytes);
      },
    );
    converter = {
      health: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      muxVideo: vi.fn(async (id) => {
        await writeFile(join(root, id, "output.mp4"), outputBytes);
        return metadata(outputBytes);
      }),
    };
    executor = new VideoDownloadExecutor(
      cache,
      converter as IsolatedAudioConverter,
      process.getgid!(),
      join(temporary, "absent-worker.sock"),
    );
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it("bounds both inputs, verifies mux output hash, and retains only the final video", async () => {
    const job = row();
    const result = await executor.download(job, config, options());
    expect(await readFile(result.path)).toEqual(outputBytes);
    expect(stages).toEqual(["downloading", "merging"]);
    expect(mocks.download.mock.calls.map((call) => call[1].maxBytes)).toEqual([
      1000,
      1000 - videoBytes.length,
    ]);
    expect(converter.muxVideo).toHaveBeenCalledWith(
      job.id,
      {
        videoSha256: sha256(videoBytes),
        audioSha256: sha256(audioBytes),
        maxDurationSeconds: 600,
        maxBytes: 1000,
      },
      expect.any(AbortSignal),
    );
    expect((await readdir(join(root, job.id))).sort()).toEqual(["metadata.json", "output.mp4"]);
    expect(await readFile(join(root, job.id, "metadata.json"), "utf8")).not.toContain(
      "synthetic-private-cookie",
    );
    await executor.cleanup(job.id, true);
    const { durationSeconds, ...cached } = result;
    expect(durationSeconds).toBe(60);
    expect(await cache.inspect(job.id)).toEqual(cached);
  });

  it("rejects changed source metadata and low disk space before downloading files", async () => {
    const job = row();
    mocks.getVideo.mockResolvedValueOnce({
      bvid,
      selectedPart: 2,
      parts: [{ part: 2, durationSeconds: 60 }],
    });
    await expect(executor.download(job, config, options())).rejects.toMatchObject({
      code: "source_changed",
    });
    expect(mocks.download).not.toHaveBeenCalled();
    free = 100;
    await expect(executor.download(job, config, options())).rejects.toMatchObject({
      code: "insufficient_disk_space",
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(converter.muxVideo).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([".video-download-cache.json"]);
  });

  it("rejects a forged output hash and stops the worker before removing partial files", async () => {
    const job = row();
    vi.mocked(converter.muxVideo).mockImplementationOnce(async (id) => {
      await writeFile(join(root, id, "output.mp4"), outputBytes);
      return { ...metadata(outputBytes), sha256: "0".repeat(64) };
    });
    await expect(executor.download(job, config, options())).rejects.toMatchObject({
      code: "invalid_video",
    });
    vi.mocked(converter.cancel).mockImplementationOnce(async (id) => {
      expect((await lstat(join(root, id, "output.mp4"))).isFile()).toBe(true);
    });
    await executor.cleanup(job.id);
    expect(converter.cancel).toHaveBeenCalledWith(job.id);
    await expect(lstat(join(root, job.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps files if stopping the worker fails, then removes them on a successful retry", async () => {
    const job = row();
    mocks.download.mockImplementationOnce(async (_url, _policy, destination: string) => {
      await writeFile(destination, videoBytes);
      throw new Error("Synthetic partial download failure");
    });
    await expect(executor.download(job, config, options())).rejects.toThrow(
      "Synthetic partial download failure",
    );
    vi.mocked(converter.cancel).mockRejectedValueOnce(new Error("Synthetic worker unavailable"));
    await expect(executor.cleanup(job.id)).rejects.toThrow("Synthetic worker unavailable");
    expect(await readFile(join(root, job.id, "video.mp4"))).toEqual(videoBytes);
    await executor.cleanup(job.id);
    await expect(lstat(join(root, job.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not commit after caller cancellation during mux and cleans after worker cancellation", async () => {
    const job = row();
    const controller = new AbortController();
    vi.mocked(converter.muxVideo).mockImplementationOnce(async (id) => {
      await writeFile(join(root, id, "output.mp4"), outputBytes);
      controller.abort(new Error("Synthetic cancellation"));
      return metadata(outputBytes);
    });
    await expect(
      executor.download(job, config, { ...options(), signal: controller.signal }),
    ).rejects.toThrow("Synthetic cancellation");
    await executor.cleanup(job.id);
    expect(await cache.inspect(job.id)).toBeNull();
    await expect(lstat(join(root, job.id))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
