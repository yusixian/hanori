import type {
  GenerationMaterialSelection,
  GenerationMaterialSnapshot,
} from "./generation-library.js";
import type { NsfwScores } from "./pixai.js";

export type ImagePurpose = "anime_illustration" | "general_image";

export type ImageProviderRoute = "mcp_pixai" | "mcp_openai" | "mcp_gemini" | "general_backend";

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

export type ImageDeliveryState = "pending" | "sending" | "failed" | "unknown" | "delivered";

/** Only a positively rejected send may be retried. Transport failures are ambiguous. */
export class ImageDeliveryError extends Error {
  constructor(
    readonly outcome: "not_sent" | "unknown",
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "ImageDeliveryError";
  }
}

export interface ImageGenerationRequestContext {
  messageId?: number;
  threadId?: number;
  traceId?: string;
  toolCallId?: string;
}

export interface ImageGenerationActor {
  requestContext?: ImageGenerationRequestContext;
  botId: string;
  chatId: number;
  userId: number;
  chatType: "private" | "group" | "supergroup";
  isBotAdmin: boolean;
  isDelegatedGroupAdmin: boolean;
  imageConfirmationPolicy?: "always" | "never";
}

export interface ImagePreset {
  key: string;
  label: string;
  description?: string;
  provider: ImageProviderRoute;
  autoApproved: boolean;
}

export interface ImageBackendConfig {
  backendId: ImageProviderRoute;
  enabled: boolean;
  defaultPresetKey?: string;
  allowedPresetKeys: string[];
}

export interface ImageRouteCapabilities {
  backendCapabilities?: Array<{
    backendId: ImageProviderRoute;
    presetsRequired: boolean;
    connection?: Record<string, unknown>;
    dynamicParameters?: string[];
  }>;
  availableBackends?: ImageProviderRoute[];
  defaultBackendId?: ImageProviderRoute;
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
  defaultBackendId?: ImageProviderRoute;
  backends?: ImageBackendConfig[];
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

export interface ImageDynamicParameters {
  model?: string;
  size?: string;
  quality?: "auto" | "low" | "medium" | "high";
  aspectRatio?: string;
  imageSize?: string;
}
export const IMAGE_DYNAMIC_PARAMETER_PATTERNS = {
  size: /^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/,
  aspectRatio: /^[1-9]\d{0,3}:[1-9]\d{0,3}$/,
  imageSize: /^[1-9]\d?K$/,
};
export function parseImageDynamicParameters(value: unknown): ImageDynamicParameters {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid image parameters");
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    if (typeof field !== "string") throw new Error("Invalid image parameters");
    const text = key === "model" ? field.trim() : field;
    const valid =
      key === "model"
        ? text.length > 0 && text.length <= 100
        : key === "quality"
          ? ["auto", "low", "medium", "high"].includes(text)
          : Object.hasOwn(IMAGE_DYNAMIC_PARAMETER_PATTERNS, key) &&
            IMAGE_DYNAMIC_PARAMETER_PATTERNS[
              key as keyof typeof IMAGE_DYNAMIC_PARAMETER_PATTERNS
            ].test(text);
    if (!valid) throw new Error("Invalid image parameters");
    result[key] = text;
  }
  return result as ImageDynamicParameters;
}

export interface CreateImageRequest {
  /** Host-supplied correlation, never a model input. */
  toolCallId?: string;
  parameters?: ImageDynamicParameters;
  backendId?: ImageProviderRoute;
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
  nsfw?: ImageSafetyResult;
}

export interface ImageSafetyResult {
  status: "checked" | "failed" | "unavailable";
  isNsfw: boolean;
  scores: NsfwScores | null;
}

/** Stable, provider-neutral parameters kept locally for task inspection and reproduction. */
export interface ImageGenerationRequestSnapshot {
  routingIntent?: CreateImageRequest["routingIntent"];
  requestContext?: ImageGenerationRequestContext;
  imageSize?: string;
  size?: string;
  quality?: string;
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
  providerOperationId?: string;
  requestContext?: ImageGenerationRequestContext;
  deliveryState?: ImageDeliveryState;
  deliveryTarget?: { chatId: number; threadId?: number };
  deliveryMessageIds?: number[];
  deliveryErrorCode?: string;
  cancellationState?: "requested" | "rejected" | "confirmed" | "unknown";
  approval: ImageApprovalState;
  confirmationPreview?: Pick<
    ImageGenerationRequestSnapshot,
    "size" | "aspectRatio" | "quality" | "modelId"
  > & { prompt: string; negativePrompt?: string };
  confirmationVersion?: number;
  confirmationSeed?: number;
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
      /** Local task retained even when provider preparation or submission was rejected. */
      generation?: ImageGenerationView;
    };

export type ImageCancellationResult =
  | { ok: true; generation: ImageGenerationView }
  | {
      ok: false;
      reason: "not_found" | "not_allowed" | "terminal" | "provider_rejected" | "provider_error";
      generation?: ImageGenerationView;
      message?: string;
    };

export type ImageDeliveryRetryResult =
  | { ok: true; generation: ImageGenerationView }
  | {
      ok: false;
      reason: "not_found" | "not_ready" | "delivery_unknown" | "already_delivered";
      generation?: ImageGenerationView;
    };

export interface ImageGenerationPort {
  editConfirmation?(
    actor: ImageGenerationActor,
    generationId: string,
    patch: { seed: number },
  ): Promise<ImageGenerationView | null>;
  discardConfirmationEdit?(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageGenerationView | null>;
  editConfirmationPrompt?(
    actor: ImageGenerationActor,
    generationId: string,
    prompt: string,
  ): Promise<ImageGenerationView | null>;
  recordConfirmationMessage?(
    actor: ImageGenerationActor,
    generationId: string,
    messageId: number,
  ): Promise<boolean>;
  findConfirmationByMessage?(
    actor: ImageGenerationActor,
    messageId: number,
  ): Promise<ImageGenerationView | null>;
  confirm?(
    actor: ImageGenerationActor,
    generationId: string,
    expectedVersion?: number,
  ): Promise<ImageGenerationAdmission>;
  cancelConfirmation?(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageCancellationResult>;
  retryDelivery?(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageDeliveryRetryResult>;
  listRoutes(
    actor: ImageGenerationActor,
    options?: { includePresets?: boolean },
  ): Promise<ImageRouteCapabilities[]>;
  create(
    actor: ImageGenerationActor,
    request: CreateImageRequest,
  ): Promise<ImageGenerationAdmission>;
  get(
    actor: ImageGenerationActor,
    generationId: string,
    options?: { confirmationPreview?: boolean },
  ): Promise<ImageGenerationView | null>;
  findByDeliveryMessage(
    actor: ImageGenerationActor,
    telegramMessageId: number,
  ): Promise<ImageGenerationReplyContext | null>;
  listPresets(
    actor: ImageGenerationActor,
    purpose?: ImagePurpose,
    backendId?: ImageProviderRoute,
  ): Promise<ImagePreset[]>;
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
