import type { ImageGenerationRequestSnapshot, NsfwScores } from "@cos-tool-bot/shared";

export type GenerationSource = "unified" | "legacy";
export type GenerationStatusGroup = "active" | "succeeded" | "failed" | "cancelled" | "attention";

export interface GenerationListItem {
  source: GenerationSource;
  legacy: boolean;
  id: string;
  provider: string;
  state: string;
  statusGroup: GenerationStatusGroup;
  prompt: string;
  presetKey: string | null;
  requestSnapshot: ImageGenerationRequestSnapshot | null;
  localFiles: string[];
  filesPurgedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  nsfwScores: NsfwScores[] | null;
}

export interface GenerationEvent {
  id: string | number;
  kind: string;
  state: string | null;
  providerState: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface GenerationDetail extends GenerationListItem {
  negativePrompt: string | null;
  seed: number | null;
  purpose: string;
  approvalState: string | null;
  providerOperationId: string | null;
  providerState: string | null;
  artifacts: Array<{
    ordinal: number;
    mimeType: string;
    filename?: string;
    byteSize?: number;
    sha256?: string;
  }>;
  errorCode: string | null;
  deliveredAt: string | null;
  updatedAt: string;
  technical: Record<string, unknown>;
  events: GenerationEvent[];
}

export interface GenerationListResponse {
  ok: true;
  data: GenerationListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GenerationDetailResponse {
  ok: true;
  data: GenerationDetail;
}

export function generationFileUrl(botId: string, file: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/files-raw/${file
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

const UNIFIED_DELETABLE_STATES = new Set([
  "succeeded",
  "failed",
  "waiting_stopped",
  "attention_required",
  "cancelled",
]);

export function isGenerationDeletable(item: Pick<GenerationListItem, "legacy" | "state">) {
  return item.legacy
    ? item.state === "completed" || item.state === "failed"
    : UNIFIED_DELETABLE_STATES.has(item.state);
}
