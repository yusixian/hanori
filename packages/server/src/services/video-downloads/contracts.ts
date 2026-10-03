import type { VideoDownloadStatus } from "@cos-tool-bot/shared";

export interface VideoDownloadConfiguration {
  revision: number;
  installationRevision: number;
  cookie?: string;
  limits: {
    maxDurationSeconds: number;
    maxBytes: number;
    cacheTtlMs: number;
    maxCacheBytes: number;
    minFreeDiskBytes: number;
    dailyJobs: number;
  };
}

export interface InspectedVideoDownload {
  canonicalUrl: string;
  bvid: string;
  part: number;
  title: string;
  durationSeconds: number;
}

export class VideoDownloadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VideoDownloadError";
  }
}

export type VideoDownloadStage = Extract<VideoDownloadStatus, "downloading" | "merging">;

/** Telegram's hosted Bot API accepts at most 50 MB for sendVideo. */
export const TELEGRAM_VIDEO_MAX_BYTES = 50_000_000;
export const VIDEO_DOWNLOAD_TEMP_OVERHEAD_BYTES = 1_048_576;
