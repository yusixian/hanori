import type { MediaJobActor } from "./media-jobs.js";

export type VideoDownloadStatus =
  | "queued"
  | "downloading"
  | "merging"
  | "sending"
  | "completed"
  | "failed"
  | "cancelled"
  | "delivery_unknown";

export interface VideoDownloadActor extends MediaJobActor {
  threadId?: number;
}

export interface VideoDownloadView {
  id: string;
  sourceUrl: string;
  title: string;
  durationSeconds: number;
  status: VideoDownloadStatus;
  error: string | null;
  bytes: number | null;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
  cacheExpiresAt: string | null;
}

export interface VideoDownloadPort {
  /** Explicit download requests only. Destination and identity are bound by the host. */
  create(
    actor: VideoDownloadActor,
    input: { sourceUrl: string },
    signal?: AbortSignal,
  ): Promise<VideoDownloadView>;
  get(actor: VideoDownloadActor, id: string): Promise<VideoDownloadView>;
  cancel(actor: VideoDownloadActor, id: string): Promise<VideoDownloadView>;
}
