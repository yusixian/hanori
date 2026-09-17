import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_VIDEO_STICKER_BYTES, prepareTelegramVideoSticker } from "./video-sticker-media.js";

const execFileAsync = promisify(execFile);
let fixtureRoot: string;
let fixture: Buffer;
let audioFixture: Buffer;
let hangingExecutable: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-fixture-"));
  const fixturePath = join(fixtureRoot, "red-blue.webm");
  await execFileAsync("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:r=1:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=1:d=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-an",
    "-y",
    fixturePath,
  ]);
  fixture = await readFile(fixturePath);
  const audioFixturePath = join(fixtureRoot, "with-audio.webm");
  await execFileAsync("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=64x64:r=2:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "libvpx-vp9",
    "-c:a",
    "libopus",
    "-shortest",
    "-y",
    audioFixturePath,
  ]);
  audioFixture = await readFile(audioFixturePath);
  hangingExecutable = join(fixtureRoot, "hang.mjs");
  await writeFile(hangingExecutable, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", {
    mode: 0o700,
  });
  await chmod(hangingExecutable, 0o700);
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function successfulOptions(tempRoot: string) {
  return {
    api: { getFile: vi.fn().mockResolvedValue({ file_path: "stickers/red-blue.webm" }) },
    token: "123456:test-token",
    fileId: "video-sticker-id",
    fileSize: fixture.length,
    signal: new AbortController().signal,
    tempRoot,
    fetchImpl: vi.fn().mockResolvedValue(
      new Response(fixture, {
        status: 200,
        headers: { "content-length": String(fixture.length), "content-type": "video/webm" },
      }),
    ),
  };
}

describe("prepareTelegramVideoSticker", () => {
  it("extracts distinct first and last frames in chronological order", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const options = successfulOptions(tempRoot);
      const cancelStream = vi.fn();
      options.fetchImpl.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(fixture);
              controller.close();
            },
            cancel: cancelStream,
          }),
          {
            status: 200,
            headers: { "content-length": String(fixture.length), "content-type": "video/webm" },
          },
        ),
      );
      const result = await prepareTelegramVideoSticker(options);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.frames.map((frame) => frame.position)).toEqual(["first", "last"]);
      expect(result.frames.every((frame) => frame.mimeType === "image/png")).toBe(true);
      const frameStats = await Promise.all(
        result.frames.map((frame) => sharp(frame.buffer).stats()),
      );
      const firstStats = frameStats[0]!;
      const lastStats = frameStats[1]!;
      expect(firstStats.channels[0]!.mean).toBeGreaterThan(firstStats.channels[2]!.mean + 100);
      expect(lastStats.channels[2]!.mean).toBeGreaterThan(lastStats.channels[0]!.mean + 100);
      expect(await readdir(tempRoot)).toEqual([]);
      const requestedUrl = options.fetchImpl.mock.calls[0]?.[0];
      expect(String(requestedUrl)).toContain("api.telegram.org/file/bot");
      expect(String(requestedUrl)).toContain("stickers/red-blue.webm");
      expect(cancelStream).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects declared oversized files before requesting a Telegram download URL", async () => {
    const getFile = vi.fn();
    const fetchImpl = vi.fn();
    const result = await prepareTelegramVideoSticker({
      api: { getFile },
      token: "secret",
      fileId: "large",
      fileSize: MAX_VIDEO_STICKER_BYTES + 1,
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(result).toEqual({ status: "unavailable", reason: "too_large" });
    expect(getFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops a streamed download that exceeds the byte limit without Content-Length", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const options = successfulOptions(tempRoot);
      const cancelStream = vi.fn();
      options.fetchImpl.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(fixture);
            },
            cancel: cancelStream,
          }),
          { status: 200 },
        ),
      );
      const result = await prepareTelegramVideoSticker({
        ...options,
        fileSize: undefined,
        maxInputBytes: fixture.length - 1,
      });

      expect(result).toEqual({ status: "unavailable", reason: "too_large" });
      expect(cancelStream).toHaveBeenCalledOnce();
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cancels an unconsumed response body when Content-Length exceeds the byte limit", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const options = successfulOptions(tempRoot);
      const cancelStream = vi.fn();
      options.fetchImpl.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(fixture);
            },
            cancel: cancelStream,
          }),
          {
            status: 200,
            headers: { "content-length": String(MAX_VIDEO_STICKER_BYTES + 1) },
          },
        ),
      );
      const result = await prepareTelegramVideoSticker({ ...options, fileSize: undefined });

      expect(result).toEqual({ status: "unavailable", reason: "too_large" });
      expect(cancelStream).toHaveBeenCalledOnce();
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cancels a pending response body when execution is aborted during download", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    const controller = new AbortController();
    const reason = new Error("run cancelled during download");
    try {
      const options = successfulOptions(tempRoot);
      const cancelStream = vi.fn();
      options.fetchImpl.mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ cancel: cancelStream }), { status: 200 }),
      );
      const processing = prepareTelegramVideoSticker({
        ...options,
        fileSize: undefined,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(options.fetchImpl).toHaveBeenCalledOnce());
      controller.abort(reason);

      await expect(processing).rejects.toBe(reason);
      expect(cancelStream).toHaveBeenCalledOnce();
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans temporary files when probing malformed input fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const options = successfulOptions(tempRoot);
      options.fetchImpl.mockResolvedValue(
        new Response(new Uint8Array([0x00, 0x01, 0x02]), {
          status: 200,
          headers: { "content-length": "3" },
        }),
      );
      const result = await prepareTelegramVideoSticker({ ...options, fileSize: 3 });

      expect(result).toEqual({ status: "unavailable", reason: "extraction_failed" });
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back when the temporary directory cannot be created", async () => {
    const missingRoot = join(fixtureRoot, "missing-temp-root");
    const result = await prepareTelegramVideoSticker({
      ...successfulOptions(missingRoot),
      tempRoot: missingRoot,
    });

    expect(result).toEqual({ status: "unavailable", reason: "extraction_failed" });
  });

  it("reports a missing ffmpeg binary and still cleans temporary files", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const result = await prepareTelegramVideoSticker({
        ...successfulOptions(tempRoot),
        ffmpegPath: join(tempRoot, "missing-ffmpeg"),
      });

      expect(result).toEqual({ status: "unavailable", reason: "dependency_missing" });
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects WebM input that contains an audio stream", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const options = successfulOptions(tempRoot);
      options.fetchImpl.mockResolvedValue(
        new Response(audioFixture, {
          status: 200,
          headers: { "content-length": String(audioFixture.length) },
        }),
      );
      const result = await prepareTelegramVideoSticker({
        ...options,
        fileSize: audioFixture.length,
      });

      expect(result).toEqual({ status: "unavailable", reason: "unsupported_video" });
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("kills a hung media process at the total timeout and cleans temporary files", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const result = await prepareTelegramVideoSticker({
        ...successfulOptions(tempRoot),
        ffprobePath: hangingExecutable,
        timeoutMs: 50,
      });

      expect(result).toEqual({ status: "unavailable", reason: "timeout" });
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies the total timeout while Telegram getFile is pending", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    try {
      const result = await prepareTelegramVideoSticker({
        api: { getFile: vi.fn(() => new Promise<never>(() => {})) },
        token: "123456:test-token",
        fileId: "pending-file",
        signal: new AbortController().signal,
        tempRoot,
        timeoutMs: 20,
        fetchImpl: vi.fn(),
      });

      expect(result).toEqual({ status: "unavailable", reason: "timeout" });
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("kills media processing and propagates execution cancellation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cos-tool-bot-video-sticker-test-"));
    const controller = new AbortController();
    const reason = new Error("run cancelled during probing");
    try {
      const processing = prepareTelegramVideoSticker({
        ...successfulOptions(tempRoot),
        ffprobePath: hangingExecutable,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort(reason);

      await expect(processing).rejects.toBe(reason);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("propagates execution cancellation without starting work", async () => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    controller.abort(reason);

    await expect(
      prepareTelegramVideoSticker({
        api: { getFile: vi.fn() },
        token: "secret",
        fileId: "cancelled",
        signal: controller.signal,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toBe(reason);
  });
});
