import type { Api } from "grammy";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export const MAX_VIDEO_STICKER_BYTES = 256 * 1024;
export const MAX_VIDEO_STICKER_DURATION_SECONDS = 3.1;
export const MAX_VIDEO_STICKER_DIMENSION = 512;
export const MAX_VIDEO_STICKER_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_VIDEO_STICKER_TIMEOUT_MS = 15_000;

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_CONCURRENT_VIDEO_STICKER_PROCESSES = 2;

export type VideoStickerFramePosition = "first" | "last";

export interface VideoStickerFrame {
  buffer: Buffer;
  mimeType: "image/png";
  position: VideoStickerFramePosition;
}

export type VideoStickerUnavailableReason =
  | "too_large"
  | "download_failed"
  | "invalid_video"
  | "unsupported_video"
  | "dependency_missing"
  | "timeout"
  | "output_too_large"
  | "extraction_failed";

export type VideoStickerMediaResult =
  | { status: "ok"; frames: [VideoStickerFrame, VideoStickerFrame] }
  | { status: "unavailable"; reason: VideoStickerUnavailableReason };

export interface PrepareTelegramVideoStickerOptions {
  api: Pick<Api, "getFile">;
  token: string;
  fileId: string;
  fileSize?: number;
  signal: AbortSignal;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxFrameBytes?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  tempRoot?: string;
  fetchImpl?: typeof fetch;
}

interface ProbeResult {
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    width?: number;
    height?: number;
    nb_read_frames?: string;
    duration?: string;
    avg_frame_rate?: string;
  }>;
  format?: { duration?: string; format_name?: string };
}

class BoundedProcessError extends Error {
  constructor(
    message: string,
    readonly code: "dependency_missing" | "timeout" | "output_too_large" | "process_failed",
  ) {
    super(message);
    this.name = "BoundedProcessError";
  }
}

class ProcessLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < MAX_CONCURRENT_VIDEO_STICKER_PROCESSES) {
      this.active++;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const processLimiter = new ProcessLimiter();

export async function prepareTelegramVideoSticker(
  options: PrepareTelegramVideoStickerOptions,
): Promise<VideoStickerMediaResult> {
  const maxInputBytes = options.maxInputBytes ?? MAX_VIDEO_STICKER_BYTES;
  if (options.fileSize != null && options.fileSize > maxInputBytes) {
    return { status: "unavailable", reason: "too_large" };
  }

  options.signal.throwIfAborted();
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new BoundedProcessError("Video sticker processing timed out", "timeout"),
      ),
    options.timeoutMs ?? DEFAULT_VIDEO_STICKER_TIMEOUT_MS,
  );
  timeout.unref?.();
  const signal = AbortSignal.any([options.signal, timeoutController.signal]);
  let workingDirectory: string | undefined;

  try {
    workingDirectory = await mkdtemp(
      join(options.tempRoot ?? tmpdir(), "cos-tool-bot-video-sticker-"),
    );
    const inputPath = join(workingDirectory, "input.webm");
    const firstFramePath = join(workingDirectory, "first.png");
    const lastFramePath = join(workingDirectory, "last.png");
    const downloadResult = await downloadTelegramFile({
      api: options.api,
      token: options.token,
      fileId: options.fileId,
      destination: inputPath,
      maxBytes: maxInputBytes,
      signal,
      fetchImpl: options.fetchImpl ?? fetch,
    });
    if (downloadResult !== "ok") return { status: "unavailable", reason: downloadResult };

    const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    const ffprobePath = options.ffprobePath ?? "ffprobe";
    const probe = await processLimiter.run(signal, async () => {
      const { stdout } = await runBoundedProcess(
        ffprobePath,
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-show_entries",
          "stream=codec_name,codec_type,width,height,duration,avg_frame_rate:format=duration,format_name",
          "-of",
          "json",
          inputPath,
        ],
        signal,
      );
      const metadata = validateProbeMetadata(stdout);
      if (metadata.status !== "ok") return metadata;
      const counted = await runBoundedProcess(
        ffprobePath,
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-count_frames",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=nb_read_frames",
          "-of",
          "json",
          inputPath,
        ],
        signal,
      );
      return validateFrameCount(counted.stdout);
    });
    if (probe.status !== "ok") return probe;

    await processLimiter.run(signal, async () => {
      await runBoundedProcess(
        ffmpegPath,
        frameExtractionArgs(inputPath, firstFramePath, 0),
        signal,
      );
      await runBoundedProcess(
        ffmpegPath,
        frameExtractionArgs(inputPath, lastFramePath, probe.frameCount - 1),
        signal,
      );
    });

    const [first, last] = await Promise.all([
      readBoundedFile(
        firstFramePath,
        Math.min(
          options.maxFrameBytes ?? MAX_VIDEO_STICKER_FRAME_BYTES,
          MAX_VIDEO_STICKER_FRAME_BYTES,
        ),
      ),
      readBoundedFile(
        lastFramePath,
        Math.min(
          options.maxFrameBytes ?? MAX_VIDEO_STICKER_FRAME_BYTES,
          MAX_VIDEO_STICKER_FRAME_BYTES,
        ),
      ),
    ]);
    return {
      status: "ok",
      frames: [
        { buffer: first, mimeType: "image/png", position: "first" },
        { buffer: last, mimeType: "image/png", position: "last" },
      ],
    };
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (timeoutController.signal.aborted) return { status: "unavailable", reason: "timeout" };
    if (error instanceof BoundedProcessError) {
      if (error.code === "dependency_missing") {
        return { status: "unavailable", reason: "dependency_missing" };
      }
      if (error.code === "output_too_large") {
        return { status: "unavailable", reason: "output_too_large" };
      }
      if (error.code === "timeout") return { status: "unavailable", reason: "timeout" };
      return { status: "unavailable", reason: "extraction_failed" };
    }
    return { status: "unavailable", reason: "extraction_failed" };
  } finally {
    clearTimeout(timeout);
    if (workingDirectory) {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function frameExtractionArgs(inputPath: string, outputPath: string, frameNumber: number): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-vf",
    `select=eq(n\\,${frameNumber})`,
    "-frames:v",
    "1",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-f",
    "image2",
    "-vcodec",
    "png",
    "-y",
    outputPath,
  ];
}

function validateProbeMetadata(
  stdout: Buffer,
): { status: "ok" } | { status: "unavailable"; reason: "invalid_video" | "unsupported_video" } {
  let result: ProbeResult;
  try {
    result = JSON.parse(stdout.toString("utf8")) as ProbeResult;
  } catch {
    return { status: "unavailable", reason: "invalid_video" };
  }
  const video =
    result.streams?.find((stream) => stream.codec_type === "video") ?? result.streams?.[0];
  const streamDuration = Number(video?.duration);
  const formatDuration = Number(result.format?.duration);
  const duration = Number.isFinite(streamDuration) ? streamDuration : formatDuration;
  const averageFrameRate = parseFrameRate(video?.avg_frame_rate);
  const formatNames = result.format?.format_name?.split(",") ?? [];
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    return { status: "unavailable", reason: "invalid_video" };
  }
  if (
    video.codec_name !== "vp9" ||
    result.streams?.some((stream) => stream.codec_type === "audio") ||
    !formatNames.some((name) => name === "webm" || name === "matroska") ||
    !Number.isInteger(video.width) ||
    !Number.isInteger(video.height) ||
    video.width! < 1 ||
    video.height! < 1 ||
    video.width! > MAX_VIDEO_STICKER_DIMENSION ||
    video.height! > MAX_VIDEO_STICKER_DIMENSION ||
    duration > MAX_VIDEO_STICKER_DURATION_SECONDS ||
    !Number.isFinite(averageFrameRate) ||
    averageFrameRate <= 0 ||
    averageFrameRate > 30.5
  ) {
    return { status: "unavailable", reason: "unsupported_video" };
  }
  return { status: "ok" };
}

function validateFrameCount(
  stdout: Buffer,
): { status: "ok"; frameCount: number } | { status: "unavailable"; reason: "invalid_video" } {
  let result: ProbeResult;
  try {
    result = JSON.parse(stdout.toString("utf8")) as ProbeResult;
  } catch {
    return { status: "unavailable", reason: "invalid_video" };
  }
  const frameCount = Number(result.streams?.[0]?.nb_read_frames);
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 120) {
    return { status: "unavailable", reason: "invalid_video" };
  }
  return { status: "ok", frameCount };
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return Number.NaN;
  const [numerator, denominator = "1"] = value.split("/");
  const numeratorValue = Number(numerator);
  const denominatorValue = Number(denominator);
  if (
    !Number.isFinite(numeratorValue) ||
    !Number.isFinite(denominatorValue) ||
    denominatorValue === 0
  ) {
    return Number.NaN;
  }
  return numeratorValue / denominatorValue;
}

async function downloadTelegramFile(options: {
  api: Pick<Api, "getFile">;
  token: string;
  fileId: string;
  destination: string;
  maxBytes: number;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<"ok" | "too_large" | "download_failed"> {
  try {
    options.signal.throwIfAborted();
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(options.token)) return "download_failed";
    const file = await waitForAbortable(options.api.getFile(options.fileId), options.signal);
    options.signal.throwIfAborted();
    if (!file.file_path) return "download_failed";
    const pathSegments = file.file_path.split("/");
    if (pathSegments.some((part) => !part || part === "." || part === "..")) {
      return "download_failed";
    }
    const url = new URL(
      pathSegments.map((part) => encodeURIComponent(part)).join("/"),
      `https://api.telegram.org/file/bot${options.token}/`,
    );
    const response = await options.fetchImpl(url, { signal: options.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      options.signal.throwIfAborted();
      return "download_failed";
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      await response.body.cancel().catch(() => {});
      options.signal.throwIfAborted();
      return "too_large";
    }

    const reader = response.body.getReader();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let streamCompleted = false;
    let total = 0;
    try {
      handle = await open(options.destination, "wx", 0o600);
      while (true) {
        options.signal.throwIfAborted();
        const { done, value } = await waitForAbortable(reader.read(), options.signal);
        options.signal.throwIfAborted();
        if (done) {
          streamCompleted = true;
          break;
        }
        const buffer = Buffer.from(value);
        total += buffer.length;
        if (total > options.maxBytes) return "too_large";
        await handle.write(buffer);
      }
    } finally {
      try {
        if (!streamCompleted) await reader.cancel().catch(() => {});
      } finally {
        try {
          reader.releaseLock();
        } finally {
          await handle?.close();
        }
      }
    }
    return total > 0 ? "ok" : "download_failed";
  } catch {
    if (options.signal.aborted) throw options.signal.reason;
    return "download_failed";
  }
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function runBoundedProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(
        signal.reason instanceof Error ? signal.reason : new Error("Video processing aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new BoundedProcessError("Process stdout exceeded limit", "output_too_large"));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new BoundedProcessError("Process stderr exceeded limit", "output_too_large"));
      } else {
        stderr.push(chunk);
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? new BoundedProcessError(
              `Executable not found: ${basename(executable)}`,
              "dependency_missing",
            )
          : new BoundedProcessError("Media process failed to start", "process_failed"),
      );
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (code === 0) finish();
      else
        finish(
          new BoundedProcessError(
            `Media process exited with code ${String(code)} signal ${String(closeSignal)}`,
            "process_failed",
          ),
        );
    });
  });
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  await access(filePath, fsConstants.R_OK);
  const fileStat = await stat(filePath);
  if (fileStat.size < 1)
    throw new BoundedProcessError("Extracted frame is empty", "process_failed");
  if (fileStat.size > maxBytes) {
    throw new BoundedProcessError("Extracted frame exceeded limit", "output_too_large");
  }
  return readFile(filePath);
}
