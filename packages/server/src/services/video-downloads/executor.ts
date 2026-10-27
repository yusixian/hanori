import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createBilibiliClient } from "../media/bilibili.js";
import { downloadMediaFile } from "../media/http.js";
import { inspectWithYtdlp, downloadWithYtdlp } from "../media/ytdlp-universal.js";
import type { IsolatedAudioConverter } from "../media/isolated-converter.js";
import { requireStoppedWorker } from "../media-jobs/executor.js";
import { VideoDownloadCache, type VideoDownloadLease } from "./cache.js";
import {
  VIDEO_DOWNLOAD_TEMP_OVERHEAD_BYTES,
  VideoDownloadError,
  type VideoDownloadConfiguration,
  type VideoDownloadStage,
} from "./contracts.js";
import type { VideoDownloadRow } from "./service.js";

export class VideoDownloadExecutor {
  private readonly leases = new Map<string, VideoDownloadLease>();
  constructor(
    private readonly cache: VideoDownloadCache,
    private readonly converter: IsolatedAudioConverter | undefined,
    private readonly workerGid = process.getgid?.() ?? 1000,
    private readonly workerSocket = "",
  ) {}

  async inspect(sourceUrl: string, config: VideoDownloadConfiguration, signal: AbortSignal) {
    if (!this.converter) throw new VideoDownloadError("worker_unavailable");
    await this.converter.health();
    if (config.provider === "ytdlp") {
      const video = await inspectWithYtdlp(sourceUrl, config.cookies, signal);
      if (["is_live", "is_upcoming", "post_live"].includes(video.liveStatus ?? ""))
        throw new VideoDownloadError("live_not_supported");
      const durationSeconds =
        video.durationSeconds === null ? null : Math.ceil(video.durationSeconds);
      if (
        durationSeconds !== null &&
        (durationSeconds < 1 || durationSeconds > config.limits.maxDurationSeconds)
      )
        throw new VideoDownloadError("duration_limit");
      return {
        canonicalUrl: video.url,
        bvid: JSON.stringify([video.extractor, video.id]),
        part: 1,
        title: video.title,
        durationSeconds,
      };
    }
    const client = createBilibiliClient({ cookie: config.cookie });
    const video = await client.getVideo(sourceUrl, signal);
    const durationSeconds = video.parts.find(
      (part) => part.part === video.selectedPart,
    )!.durationSeconds;
    if (durationSeconds > config.limits.maxDurationSeconds)
      throw new VideoDownloadError("duration_limit");
    return {
      canonicalUrl: video.url,
      bvid: video.bvid,
      part: video.selectedPart,
      title: video.title,
      durationSeconds,
    };
  }

  async download(
    row: VideoDownloadRow,
    config: VideoDownloadConfiguration,
    options: {
      signal: AbortSignal;
      onStage(stage: VideoDownloadStage): Promise<void>;
    },
  ) {
    if (!this.converter) throw new VideoDownloadError("worker_unavailable");
    const { signal, onStage } = options;
    const media = await (async () => {
      if (row.provider === "ytdlp") return undefined;
      const client = createBilibiliClient({ cookie: config.cookie });
      const video = await client.getVideo(row.sourceUrl, signal);
      const part = video.parts.find((part) => part.part === video.selectedPart);
      if (
        video.bvid !== row.bvid ||
        video.selectedPart !== row.part ||
        part?.durationSeconds !== row.durationSeconds
      )
        throw new VideoDownloadError("source_changed");
      return client.getVideoMedia(video.reference, signal, config.limits);
    })();
    signal.throwIfAborted();
    const lease = await this.cache.reserve({
      id: row.id,
      reservedBytes: config.limits.maxBytes * 2 + VIDEO_DOWNLOAD_TEMP_OVERHEAD_BYTES,
      maxCacheBytes: config.limits.maxCacheBytes,
      minFreeDiskBytes: config.limits.minFreeDiskBytes,
    });
    this.leases.set(row.id, lease);
    // The worker traverses only this shared subtree and reads immutable inputs by group.
    for (const directory of [
      dirname(dirname(lease.filePath("video.mp4"))),
      dirname(lease.filePath("video.mp4")),
    ]) {
      await chown(directory, process.getuid?.() ?? 0, this.workerGid);
      await chmod(directory, 0o750);
    }
    await chmod(dirname(lease.filePath("video.mp4")), 0o770);
    const watch = new AbortController();
    const combined = AbortSignal.any([signal, watch.signal]);
    let checking = false;
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void lease
        .checkSpace()
        .catch((error: unknown) => watch.abort(error))
        .finally(() => {
          checking = false;
        });
    }, 1000);
    monitor.unref();
    try {
      await onStage("downloading");
      let used = 0;
      const download = async (
        source: { url: string; allowedHosts: string[] },
        name: "video.mp4" | "audio.m4a",
      ) => {
        const result = await downloadMediaFile(
          source.url,
          {
            allowedHosts: source.allowedHosts,
            referer: "https://www.bilibili.com/",
            maxRedirects: 0,
            mimeTypes:
              name === "video.mp4"
                ? ["video/mp4", "application/octet-stream"]
                : ["audio/mp4", "application/octet-stream"],
            maxBytes: config.limits.maxBytes - used,
            signal: combined,
            onProgress: () => lease.checkSpace(),
          },
          lease.filePath(name),
        );
        used += result.bytes;
        const file = await open(
          lease.filePath(name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== result.bytes)
            throw new VideoDownloadError("invalid_video");
          await file.chown(process.getuid?.() ?? 0, this.workerGid);
          await file.chmod(0o440);
        } finally {
          await file.close();
        }
        return result;
      };
      let downloadedVideo: { sha256: string };
      let downloadedAudio: { sha256: string } | undefined;
      if (media) {
        downloadedVideo = await download(media.video, "video.mp4");
        downloadedAudio = await download(media.audio, "audio.m4a");
      } else {
        const identity: unknown = JSON.parse(row.bvid);
        if (
          !Array.isArray(identity) ||
          identity.length !== 2 ||
          !identity.every((item) => typeof item === "string")
        )
          throw new VideoDownloadError("invalid_source");
        const result = await downloadWithYtdlp(
          {
            url: row.sourceUrl,
            expectedExtractor: identity[0]!,
            expectedId: identity[1]!,
            directory: dirname(lease.filePath("video.mp4")),
            maxBytes: config.limits.maxBytes,
            maxSeconds: config.limits.maxDurationSeconds,
          },
          config.cookies,
          combined,
        );
        if (
          row.durationSeconds !== null &&
          (result.durationSeconds === null ||
            Math.ceil(result.durationSeconds) !== row.durationSeconds)
        )
          throw new VideoDownloadError("source_changed");
        const verify = async (name: "video.mp4" | "audio.m4a") => {
          const file = await open(
            lease.filePath(name),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const stat = await file.stat();
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              stat.size < 1 ||
              stat.size > config.limits.maxBytes
            )
              throw new VideoDownloadError("invalid_video");
            const hash = createHash("sha256");
            for await (const chunk of file.createReadStream({ autoClose: false, signal: combined }))
              hash.update(chunk);
            await file.chown(process.getuid?.() ?? 0, this.workerGid);
            await file.chmod(0o440);
            used += stat.size;
            return { sha256: hash.digest("hex") };
          } finally {
            await file.close();
          }
        };
        downloadedVideo = await verify("video.mp4");
        if (result.separateAudio) downloadedAudio = await verify("audio.m4a");
        if (used !== result.bytes || used > config.limits.maxBytes)
          throw new VideoDownloadError("invalid_video");
      }
      await onStage("merging");
      const converted = await this.converter.muxVideo(
        row.id,
        {
          videoSha256: downloadedVideo.sha256,
          ...(downloadedAudio ? { audioSha256: downloadedAudio.sha256 } : {}),
          ...(row.provider === "ytdlp" ? { generic: true as const } : {}),
          maxDurationSeconds: config.limits.maxDurationSeconds,
          maxBytes: config.limits.maxBytes,
        },
        combined,
      );
      combined.throwIfAborted();
      if (
        row.durationSeconds !== null &&
        Math.abs(converted.durationSeconds - row.durationSeconds) > 2
      )
        throw new VideoDownloadError("source_changed");
      const output = await open(
        lease.filePath("output.mp4"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await output.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== converted.bytes)
          throw new VideoDownloadError("invalid_video");
        const hash = createHash("sha256");
        for await (const chunk of output.createReadStream({ autoClose: false, signal: combined }))
          hash.update(chunk);
        if (hash.digest("hex") !== converted.sha256) throw new VideoDownloadError("invalid_video");
      } finally {
        await output.close();
      }
      combined.throwIfAborted();
      const committed = await lease.commit("output.mp4", {
        ttlMs: config.limits.cacheTtlMs,
        maxFileBytes: config.limits.maxBytes,
      });
      return { ...committed, durationSeconds: Math.ceil(converted.durationSeconds) };
    } finally {
      clearInterval(monitor);
    }
  }

  async cleanup(id: string, retain = false) {
    if (this.converter) await this.converter.cancel(id);
    else await requireStoppedWorker(this.workerSocket);
    const lease = this.leases.get(id);
    if (lease) {
      await lease.release({ retain });
      this.leases.delete(id);
    } else if (!retain) await this.cache.remove(id);
  }

  sweep() {
    return this.cache.sweep();
  }
}
