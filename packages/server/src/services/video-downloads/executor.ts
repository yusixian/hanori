import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createBilibiliClient } from "../media/bilibili.js";
import { downloadMediaFile } from "../media/http.js";
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
    const client = createBilibiliClient({ cookie: config.cookie });
    const video = await client.getVideo(row.sourceUrl, signal);
    const part = video.parts.find((part) => part.part === video.selectedPart);
    if (
      video.bvid !== row.bvid ||
      video.selectedPart !== row.part ||
      part?.durationSeconds !== row.durationSeconds
    )
      throw new VideoDownloadError("source_changed");
    const media = await client.getVideoMedia(video.reference, signal, config.limits);
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
      const downloadedVideo = await download(media.video, "video.mp4");
      const downloadedAudio = await download(media.audio, "audio.m4a");
      await onStage("merging");
      const converted = await this.converter.muxVideo(
        row.id,
        {
          videoSha256: downloadedVideo.sha256,
          audioSha256: downloadedAudio.sha256,
          maxDurationSeconds: config.limits.maxDurationSeconds,
          maxBytes: config.limits.maxBytes,
        },
        combined,
      );
      combined.throwIfAborted();
      if (Math.abs(converted.durationSeconds - row.durationSeconds) > 2)
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
      return await lease.commit("output.mp4", {
        ttlMs: config.limits.cacheTtlMs,
        maxFileBytes: config.limits.maxBytes,
      });
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
