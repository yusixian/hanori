import type {
  GenerationMaterialSelection,
  GenerationMaterialSnapshot,
} from "./generation-library.js";

export type ImagePurpose = "anime_illustration" | "general_image";

export type ImageProviderRoute = "mcp_pixai" | "general_backend";

export type GeneralImageRouteMode = "off" | "explicit_only" | "semantic_auto";

export type ImageGenerationState =
  | "preparing"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "waiting_stopped"
  | "cancel_rejected"
  | "cancel_requested"
  | "attention_required"
  | "cancelled";

export type ImageApprovalState = "not_required" | "required" | "approved" | "rejected";

export interface ImageGenerationActor {
  botId: string;
  chatId: number;
  userId: number;
  chatType: "private" | "group" | "supergroup";
  isBotAdmin: boolean;
  isDelegatedGroupAdmin: boolean;
}

export interface ImagePreset {
  key: string;
  label: string;
  description?: string;
  provider: ImageProviderRoute;
  autoApproved: boolean;
}

export interface ImageRouteCapabilities {
  purpose: ImagePurpose;
  provider: ImageProviderRoute;
  enabled: boolean;
  label: string;
  useWhen: string;
  avoidWhen: string;
  examples: string[];
  presets: ImagePreset[];
  defaultPresetKey?: string;
}

export interface ImageRouteConfig {
  purpose: ImagePurpose;
  enabled: boolean;
  label: string;
  useWhen: string;
  avoidWhen: string;
  examples: string[];
  allowedPresetKeys: string[];
  defaultPresetKey?: string;
}

export interface ImageGovernanceConfig {
  timezone: string;
  generalRouteMode: GeneralImageRouteMode;
  privateChatUserIds: number[];
  routes: ImageRouteConfig[];
}

export interface CreateImageRequest {
  materials?: GenerationMaterialSelection;
  purpose: ImagePurpose;
  prompt: string;
  routingIntent?: "explicit" | "semantic";
  presetKey?: string;
  negativePrompt?: string;
  seed?: number;
}

export interface ImageArtifact {
  ordinal: number;
  mimeType: string;
  filename?: string;
  byteSize?: number;
  sha256?: string;
}

/** Stable, provider-neutral parameters kept locally for task inspection and reproduction. */
export interface ImageGenerationRequestSnapshot {
  materials?: GenerationMaterialSnapshot;
  presetKey?: string;
  modelId?: string;
  modelVersionId?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  batchSize?: number;
  samplingSteps?: number;
  cfgScale?: number;
  sampler?: string;
  promptHelper?: boolean;
}

export type ImageGenerationEventKind =
  | "created"
  | "planned"
  | "submitted"
  | "state_changed"
  | "artifacts_saved"
  | "delivery_started"
  | "delivered"
  | "delivery_failed"
  | "cancel_requested"
  | "cancel_resolved"
  | "failed";

export interface ImageGenerationView {
  id: string;
  purpose: ImagePurpose;
  provider: ImageProviderRoute;
  presetKey?: string;
  state: ImageGenerationState;
  providerState?: string;
  approval: ImageApprovalState;
  artifacts: ImageArtifact[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  deliveredAt?: string;
  retryAfterSeconds?: number;
  message?: string;
}

/** Full generation provenance restored when a Telegram delivery message is replied to. */
export interface ImageGenerationReplyContext extends ImageGenerationView {
  creatorUserId: number;
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  providerOperationId?: string;
  providerMetadata?: Record<string, unknown>;
  providerDetails?: Record<string, unknown>;
  artifactOrdinal?: number;
}

export type ImageGenerationAdmission =
  | { accepted: true; generation: ImageGenerationView }
  | {
      accepted: false;
      reason:
        | "disabled"
        | "not_allowed"
        | "approval_required"
        | "rate_limited"
        | "budget_exhausted"
        | "concurrency_limited"
        | "provider_unavailable"
        | "invalid_request";
      retryAfterSeconds?: number;
      message?: string;
    };

export type ImageCancellationResult =
  | { ok: true; generation: ImageGenerationView }
  | {
      ok: false;
      reason: "not_found" | "not_allowed" | "terminal" | "provider_rejected" | "provider_error";
      generation?: ImageGenerationView;
      message?: string;
    };

export interface ImageGenerationPort {
  listRoutes(
    actor: ImageGenerationActor,
    options?: { includePresets?: boolean },
  ): Promise<ImageRouteCapabilities[]>;
  create(
    actor: ImageGenerationActor,
    request: CreateImageRequest,
  ): Promise<ImageGenerationAdmission>;
  get(actor: ImageGenerationActor, generationId: string): Promise<ImageGenerationView | null>;
  findByDeliveryMessage(
    actor: ImageGenerationActor,
    telegramMessageId: number,
  ): Promise<ImageGenerationReplyContext | null>;
  listPresets(actor: ImageGenerationActor, purpose?: ImagePurpose): Promise<ImagePreset[]>;
  cancel(actor: ImageGenerationActor, generationId: string): Promise<ImageCancellationResult>;
}

export const DEFAULT_IMAGE_ROUTE_COPY: Readonly<
  Record<ImagePurpose, Pick<ImageRouteCapabilities, "label" | "useWhen" | "avoidWhen" | "examples">>
> = {
  anime_illustration: {
    label: "Anime illustration",
    useWhen: "Anime, manga, character art, or stylized illustration is requested.",
    avoidWhen: "The request explicitly requires a general-purpose or photorealistic image backend.",
    examples: ["anime portrait", "manga scene", "stylized character illustration"],
  },
  general_image: {
    label: "General image",
    useWhen: "The request explicitly asks for the configured general-purpose image backend.",
    avoidWhen: "The request is ambiguous or primarily anime/illustration oriented.",
    examples: ["photorealistic product shot", "general-purpose editorial image"],
  },
};
