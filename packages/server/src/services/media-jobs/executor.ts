import { constants } from "node:fs";
import { inspectConvertedWav } from "../media/wav.js";
import { createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isAbsolute } from "node:path";
import { createConnection } from "node:net";
import type { MediaJobStage } from "@cos-tool-bot/shared";
import { createBilibiliClient } from "../media/bilibili.js";
import { downloadMediaFile } from "../media/http.js";
import { createAsrClient, readAsrWav } from "../media/asr.js";
import { IsolatedAudioConverter } from "../media/isolated-converter.js";
import type { InspectedMediaResource, MediaJobConfiguration, MediaJobRow } from "./contracts.js";

export class MediaExecutorError extends Error {
  constructor(
    readonly code:
      | "authentication_required"
      | "source_changed"
      | "invalid_audio"
      | "worker_unavailable",
  ) {
    super(code);
    this.name = "MediaExecutorError";
  }
}

/** Disabled deployments may clean abandoned files only after the fixed worker socket is offline. */
async function requireStoppedWorker(socketPath: string) {
  if (!isAbsolute(socketPath)) throw new MediaExecutorError("worker_unavailable");
  await new Promise<void>((resolveStopped, reject) => {
    const socket = createConnection(socketPath);
    const fail = () => {
      socket.destroy();
      reject(new MediaExecutorError("worker_unavailable"));
    };
    socket.setTimeout(1000, fail);
    socket.once("connect", fail);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolveStopped();
      else reject(new MediaExecutorError("worker_unavailable"));
    });
  });
}

export class MediaJobExecutor {
  private readonly directory: string;
  constructor(
    directory: string,
    private readonly converter?: IsolatedAudioConverter,
    private readonly workerGid = process.getgid?.() ?? 1000,
    private readonly workerSocket = "",
  ) {
    this.directory = resolve(directory);
  }

  async inspect(
    sourceUrl: string,
    configuration: MediaJobConfiguration,
    signal: AbortSignal,
  ): Promise<InspectedMediaResource> {
    if (!this.converter) throw new MediaExecutorError("worker_unavailable");
    await this.converter.health();
    signal.throwIfAborted();
    const client = createBilibiliClient({ cookie: configuration.cookie });
    const video = await client.getVideo(sourceUrl, signal);
    const subtitles = await client.listSubtitles(video.reference, signal);
    if (subtitles.status === "login_required" || subtitles.status === "authentication_unconfirmed")
      throw new MediaExecutorError("authentication_required");
    return {
      canonicalUrl: video.url,
      bvid: video.bvid,
      part: video.selectedPart,
      title: video.title,
      durationSeconds: video.parts.find((part) => part.part === video.selectedPart)!
        .durationSeconds,
      hasSubtitles: subtitles.status === "available",
    };
  }

  private jobPath(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new MediaExecutorError("invalid_audio");
    return join(this.directory, id);
  }

  private artifactId(jobId: string, attempt: number) {
    this.jobPath(jobId);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2)
      throw new MediaExecutorError("invalid_audio");
    const hex = createHash("sha256").update(`${jobId}:${attempt}`).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async cleanup(jobId: string, attempt: number): Promise<void> {
    if (attempt === 0) return;
    const id = this.artifactId(jobId, attempt);
    if (this.converter) await this.converter.cancel(id);
    else await requireStoppedWorker(this.workerSocket);
    await rm(this.jobPath(id), { recursive: true, force: true });
  }

  async execute(
    job: MediaJobRow,
    configuration: MediaJobConfiguration,
    options: { signal: AbortSignal; onStage(stage: MediaJobStage): Promise<void> },
  ) {
    if (!this.converter) throw new MediaExecutorError("worker_unavailable");
    const { signal, onStage } = options;
    const artifactId = this.artifactId(job.id, job.attempt);
    await this.cleanup(job.id, job.attempt);
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o755 });
    const root = await lstat(this.directory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      (root.mode & 0o022) !== 0
    )
      throw new MediaExecutorError("invalid_audio");
    const directory = this.jobPath(artifactId);
    await mkdir(directory, { mode: 0o770 });
    await chown(directory, process.getuid?.() ?? 0, this.workerGid);
    await chmod(directory, 0o770);
    await onStage("downloading");
    const client = createBilibiliClient({ cookie: configuration.cookie });
    const video = await client.getVideo(job.sourceUrl, signal);
    const selected = video.parts.find((part) => part.part === video.selectedPart);
    if (
      video.bvid !== job.bvid ||
      video.selectedPart !== job.part ||
      selected?.durationSeconds !== job.durationSeconds
    )
      throw new MediaExecutorError("source_changed");
    const audio = await client.getAudio(
      video.reference,
      signal,
      configuration.limits.maxDurationSeconds,
    );
    const downloaded = await downloadMediaFile(
      audio.url,
      {
        allowedHosts: audio.allowedHosts,
        referer: "https://www.bilibili.com/",
        maxRedirects: 0,
        mimeTypes: ["audio/mp4", "application/octet-stream"],
        maxBytes: 64 * 1024 * 1024,
        timeoutMs: 120_000,
        signal,
      },
      join(directory, "input.m4a"),
    );
    signal.throwIfAborted();
    const input = await open(
      join(directory, "input.m4a"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== downloaded.bytes)
        throw new MediaExecutorError("invalid_audio");
      await input.chown(process.getuid?.() ?? 0, this.workerGid);
      await input.chmod(0o440);
    } finally {
      await input.close();
    }
    await onStage("converting");
    const converted = await this.converter.convert(
      artifactId,
      downloaded.sha256,
      configuration.limits.maxDurationSeconds,
      signal,
    );
    signal.throwIfAborted();
    const outputPath = join(directory, "output.wav");
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.())
      throw new MediaExecutorError("invalid_audio");
    const bytes = await readAsrWav(outputPath, signal);
    const verified = inspectConvertedWav(bytes, configuration.limits.maxDurationSeconds);
    if (
      bytes.length !== converted.bytes ||
      Math.abs(verified.durationSeconds - job.durationSeconds) > 2 ||
      Math.abs(verified.durationSeconds - converted.durationSeconds) > 0.1 ||
      createHash("sha256").update(bytes).digest("hex") !== converted.sha256
    )
      throw new MediaExecutorError("invalid_audio");
    signal.throwIfAborted();
    // Persist this stage before issuing a billable request; recovery never blindly resubmits it.
    await onStage("transcribing");
    return createAsrClient(configuration.asr).transcribeBytes(bytes, signal);
  }
}
