import type { TranscriptDocument } from "./media-transcript.js";

export type MediaJobStatus =
  | "pending_confirmation"
  | "expired"
  | "queued"
  | "downloading"
  | "converting"
  | "transcribing"
  | "completed"
  | "failed"
  | "cancelled";
export type MediaJobStage = "downloading" | "converting" | "transcribing";
export interface MediaJobActor {
  botId: string;
  chatId: number;
  userId: number;
  isAdmin: boolean;
  threadId?: number;
}
export interface MediaJobConfirmation {
  provider: string;
  model: string;
  currency: "CNY" | "USD";
  estimatedCost: number;
  maxCost: number;
  freeQuota: string;
  expiresAt: string;
}
export interface MediaJobView {
  id: string;
  sourceUrl: string;
  title: string;
  threadId?: number;
  confirmation?: MediaJobConfirmation;
  cancelRequested?: boolean;
  part: number;
  durationSeconds: number;
  status: MediaJobStatus;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  language: string | null;
  source: "asr";
  notification: "pending" | "delivering" | "sent" | "failed";
}
export interface MediaTranscriptionPort {
  /** High-cost work is separate from search. Actor is bound by the host, never model input. */
  create(
    actor: MediaJobActor,
    input: { sourceUrl: string; forceAsr?: boolean },
    signal?: AbortSignal,
  ): Promise<MediaJobView>;
  /** Only a trusted administrator callback may call this; never a model tool. */
  confirm(actor: MediaJobActor, id: string): Promise<MediaJobView>;
  get(actor: MediaJobActor, id: string): Promise<MediaJobView>;
  cancel(actor: MediaJobActor, id: string): Promise<MediaJobView>;
  read(actor: MediaJobActor, id: string): Promise<TranscriptDocument>;
}
