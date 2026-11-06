import { InFlightTasks } from "../utils/in-flight-tasks.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "@cos-tool-bot/database";
import type { NsfwChecker } from "@cos-tool-bot/bot";
import {
  imageGenerationConfigs,
  imageGenerationEvents,
  imageGenerations,
} from "@cos-tool-bot/database";
import {
  DEFAULT_IMAGE_ROUTE_COPY,
  ImageDeliveryError,
  type CreateImageRequest,
  type ImageArtifact,
  type ImageCancellationResult,
  type ImageGenerationActor,
  type ImageDeliveryRetryResult,
  type ImageGenerationAdmission,
  type ImageGenerationPort,
  type ImageGenerationReplyContext,
  type ImageGenerationRequestSnapshot,
  type ImageGenerationState,
  type ImageGenerationView,
  type ImageGovernanceConfig,
  type ImagePreset,
  type ImageProviderRoute,
  type ImagePurpose,
  parseImageDynamicParameters,
  type ImageRouteCapabilities,
  type ImageRouteConfig,
  type GenerationLibraryPort,
  type GenerationMaterialSnapshot,
} from "@cos-tool-bot/shared";
import { getDataDir } from "@cos-tool-bot/shared/file-validation";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Logger } from "pino";
import type { PixaiMcpAdapter, PixaiGenerationOperation } from "./pixai-mcp-adapter.js";
import type { PixaiMcpArtifactData, PixaiMcpArtifactReader } from "./pixai-mcp-artifacts.js";
import { UsageGovernor } from "./usage-governor.js";
import { recordGenerationAssetUses } from "./generation-asset-usage.js";
import { redactDiagnostic } from "./run-redaction.js";
import { GenerationLibraryError } from "./generation-library-service.js";

const PENDING_STATES: ImageGenerationState[] = [
  "preparing",
  "awaiting_approval",
  "queued",
  "running",
  "cancel_requested",
  "cancel_rejected",
];
const RECOVERABLE_STATES: ImageGenerationState[] = [...PENDING_STATES, "succeeded"];
const COMPLETABLE_STATES: ImageGenerationState[] = PENDING_STATES.filter(
  (state) => state !== "cancel_requested",
);
const DELETABLE_STATES: ImageGenerationState[] = [
  "succeeded",
  "failed",
  "waiting_stopped",
  "attention_required",
  "cancelled",
];
const DELIVERY_CLAIM_LEASE_MS = 15 * 60 * 1000;

export interface GeneralImageBackend {
  isConfigured?(botId: string): Promise<boolean>;
  create(input: {
    botId: string;
    prompt: string;
    presetKey?: string;
    negativePrompt?: string;
    seed?: number;
    signal?: AbortSignal;
  }): Promise<PixaiMcpArtifactData[]>;
}

export interface ImageGenerationDelivery {
  deliver(input: {
    generationId: string;
    botId: string;
    chatId: number;
    threadId?: number;
    userId: number;
    prompt: string;
    presetKey?: string;
    requestSnapshot?: ImageGenerationRequestSnapshot;
    localFiles: string[];
  }): Promise<number[]>;
}

export interface ImageGenerationServiceOptions {
  nsfwChecker?: NsfwChecker;
  generationLibrary?: GenerationLibraryPort;
  db: Database;
  usageGovernor: UsageGovernor;
  pixai: PixaiMcpAdapter;
  backends?: Partial<
    Record<
      ImageProviderRoute,
      { adapter: PixaiMcpAdapter; artifacts: PixaiMcpArtifactReader; endpoint?: string }
    >
  >;
  artifacts: PixaiMcpArtifactReader;
  logger: Logger;
  delivery?: ImageGenerationDelivery;
  generalBackend?: GeneralImageBackend;
  isGroupEnabled?: (botId: string, chatId: number) => Promise<boolean>;
}

interface CreateImageOptions {
  requestSnapshot?: ImageGenerationRequestSnapshot;
}

export const DEFAULT_IMAGE_GOVERNANCE_CONFIG: ImageGovernanceConfig = {
  timezone: "Asia/Shanghai",
  generalRouteMode: "off",
  privateChatUserIds: [],
  routes: [
    {
      purpose: "anime_illustration",
      defaultBackendId: "mcp_pixai",
      enabled: true,
      ...DEFAULT_IMAGE_ROUTE_COPY.anime_illustration,
      allowedPresetKeys: [],
    },
    {
      purpose: "general_image",
      defaultBackendId: "mcp_openai",
      enabled: false,
      ...DEFAULT_IMAGE_ROUTE_COPY.general_image,
      allowedPresetKeys: [],
    },
  ],
};

export class ImageGenerationService implements ImageGenerationPort {
  private readonly nsfwChecker?: NsfwChecker;
  private readonly db: Database;
  private readonly usageGovernor: UsageGovernor;
  private readonly backends: NonNullable<ImageGenerationServiceOptions["backends"]>;
  private readonly pixai: PixaiMcpAdapter;
  private readonly artifacts: PixaiMcpArtifactReader;
  private readonly logger: Logger;
  private readonly delivery?: ImageGenerationDelivery;
  private readonly generalBackend?: GeneralImageBackend;
  private readonly isGroupEnabled: (botId: string, chatId: number) => Promise<boolean>;
  private closing = false;
  private closeTask?: Promise<void>;
  private readonly tasks = new InFlightTasks();
  private readonly generalRuns = new Map<string, AbortController>();
  private readonly advancing = new Set<string>();
  private readonly scheduled = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; at: number }
  >();
  private readonly generationLibrary?: GenerationLibraryPort;

  constructor(options: ImageGenerationServiceOptions) {
    this.nsfwChecker = options.nsfwChecker;
    this.db = options.db;
    this.generationLibrary = options.generationLibrary;
    this.usageGovernor = options.usageGovernor;
    this.pixai = options.pixai;
    this.backends = options.backends ?? {};
    this.artifacts = options.artifacts;
    this.logger = options.logger;
    this.delivery = options.delivery;
    this.generalBackend = options.generalBackend;
    this.isGroupEnabled = options.isGroupEnabled ?? (async () => false);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    for (const { timer } of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    this.closeTask = this.tasks.drain();
    return this.closeTask;
  }

  private execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Image generation service is closing"));
    return this.tasks.track(operation());
  }

  private background(generationId: string, task: string, operation: () => Promise<void>): void {
    void this.tasks.track(operation()).catch(() => {
      this.logger.warn({ generationId, task }, "Image background task failed");
    });
  }

  listRoutes(
    actor: ImageGenerationActor,
    options?: { includePresets?: boolean },
  ): Promise<ImageRouteCapabilities[]> {
    return this.execute(() => this.listRoutesImpl(actor, options));
  }

  private async listRoutesImpl(
    actor: ImageGenerationActor,
    options?: { includePresets?: boolean },
  ): Promise<ImageRouteCapabilities[]> {
    const config = await this.getConfig(actor.botId);
    const general = await this.generalRouteAvailability(actor.botId, config);
    const result: ImageRouteCapabilities[] = [];
    for (const route of config.routes) {
      const availableBackends = this.routeBackends(route)
        .filter((binding) => binding.enabled && this.isMcpBackendAvailable(binding.backendId))
        .map((binding) => binding.backendId);
      if (
        route.enabled &&
        route.purpose === "general_image" &&
        general.legacyAvailable &&
        this.routeBackends(route).some(
          (binding) => binding.backendId === "general_backend" && binding.enabled,
        )
      )
        availableBackends.push("general_backend");
      const presets =
        options?.includePresets === false
          ? []
          : await this.listPresetsForConfig(
              config,
              general.available,
              route.purpose,
              undefined,
              general.legacyAvailable,
            );
      const backendCapabilities = await Promise.all(
        availableBackends
          .filter((backendId) => backendId === "mcp_openai" || backendId === "mcp_gemini")
          .map(async (backendId) => {
            const adapter = this.backend(backendId).adapter;
            const capabilities = await Promise.resolve()
              .then(() => adapter.getCapabilities?.())
              .catch(() => null);
            return {
              backendId,
              presetsRequired: capabilities?.["presetsRequired"] !== false,
              ...(capabilities?.["connection"] && typeof capabilities["connection"] === "object"
                ? { connection: capabilities["connection"] as Record<string, unknown> }
                : {}),
              ...(Array.isArray(capabilities?.["dynamicParameters"])
                ? { dynamicParameters: capabilities["dynamicParameters"] as string[] }
                : {}),
            };
          }),
      );
      result.push({
        ...route,
        backendCapabilities,
        provider: route.defaultBackendId ?? providerForPurpose(route.purpose),
        availableBackends,
        enabled:
          route.enabled &&
          availableBackends.length > 0 &&
          (route.purpose !== "general_image" || config.generalRouteMode !== "off"),
        presets,
      });
    }
    return result;
  }

  private routeBackends(route: ImageRouteConfig) {
    return (
      route.backends ??
      (route.purpose === "general_image" && !route.defaultBackendId
        ? ["general_backend"]
        : ["mcp_pixai", "mcp_openai", "mcp_gemini", "general_backend"]
      ).map((backendId) => ({
        backendId: backendId as ImageProviderRoute,
        enabled: backendId !== "general_backend" || route.purpose === "general_image",
        allowedPresetKeys:
          backendId === (route.defaultBackendId ?? providerForPurpose(route.purpose))
            ? route.allowedPresetKeys
            : [],
        defaultPresetKey:
          backendId === (route.defaultBackendId ?? providerForPurpose(route.purpose))
            ? route.defaultPresetKey
            : undefined,
      }))
    );
  }

  private isMcpBackendAvailable(provider: ImageProviderRoute) {
    return provider === "mcp_pixai" || Boolean(this.backends[provider]?.endpoint);
  }

  private backend(provider: string, metadata?: Record<string, unknown> | null) {
    const selected =
      this.backends[provider as ImageProviderRoute] ??
      (provider === "mcp_pixai"
        ? {
            adapter: this.pixai,
            artifacts: this.artifacts,
            endpoint: this.backends.mcp_pixai?.endpoint,
          }
        : undefined);
    if (
      !selected ||
      (typeof metadata?.endpoint === "string" && metadata.endpoint !== selected.endpoint)
    )
      throw new Error("Original image provider connection is unavailable");
    return selected;
  }

  listPresets(
    actor: ImageGenerationActor,
    purpose?: "anime_illustration" | "general_image",
    backendId?: ImageProviderRoute,
  ): Promise<ImagePreset[]> {
    return this.execute(() => this.listPresetsImpl(actor, purpose, backendId));
  }

  private async listPresetsImpl(
    actor: ImageGenerationActor,
    purpose?: "anime_illustration" | "general_image",
    backendId?: ImageProviderRoute,
  ): Promise<ImagePreset[]> {
    const config = await this.getConfig(actor.botId);
    const general =
      !purpose || purpose === "general_image"
        ? await this.generalRouteAvailability(actor.botId, config)
        : { available: false, legacyAvailable: false };
    return this.listPresetsForConfig(
      config,
      general.available,
      purpose,
      backendId,
      general.legacyAvailable,
    );
  }

  private async listPresetsForConfig(
    config: ImageGovernanceConfig,
    generalImageAvailable: boolean,
    purpose?: "anime_illustration" | "general_image",
    backendId?: ImageProviderRoute,
    legacyAvailable = false,
  ): Promise<ImagePreset[]> {
    const result: ImagePreset[] = [];
    for (const route of config.routes) {
      if (
        !route.enabled ||
        (purpose && purpose !== route.purpose) ||
        (route.purpose === "general_image" && !generalImageAvailable)
      )
        continue;
      for (const binding of this.routeBackends(route)) {
        if (!binding.enabled || (backendId && binding.backendId !== backendId)) continue;
        if (binding.backendId === "general_backend") {
          if (legacyAvailable && route.purpose === "general_image")
            result.push({
              key: "general-default",
              label: "General image",
              provider: "general_backend",
              autoApproved: true,
            });
          continue;
        }
        if (!this.isMcpBackendAvailable(binding.backendId)) continue;
        const raw = await this.backend(binding.backendId)
          .adapter.listPresets()
          .catch((error: unknown) => {
            this.logger.warn(
              { code: sanitizedProviderErrorCode(error), provider: binding.backendId },
              "Image MCP preset discovery failed",
            );
            return [];
          });
        for (const item of raw) {
          const preset = projectPixaiPreset(item);
          if (
            !preset ||
            (binding.allowedPresetKeys.length && !binding.allowedPresetKeys.includes(preset.key))
          )
            continue;
          result.push({ ...preset, provider: binding.backendId });
        }
      }
    }
    return result;
  }

  create(
    actor: ImageGenerationActor,
    request: CreateImageRequest,
  ): Promise<ImageGenerationAdmission> {
    return this.execute(() => this.createImpl(actor, request));
  }

  private async createImpl(
    actor: ImageGenerationActor,
    request: CreateImageRequest,
    options?: CreateImageOptions,
  ): Promise<ImageGenerationAdmission> {
    const requestContext = {
      ...actor.requestContext,
      ...(request.toolCallId ? { toolCallId: safeCorrelationId(request.toolCallId) } : {}),
    };
    const config = await this.getConfig(actor.botId);
    if (!(await this.canCreate(actor, config))) return { accepted: false, reason: "not_allowed" };
    const route = config.routes.find((candidate) => candidate.purpose === request.purpose);
    if (!route?.enabled) return { accepted: false, reason: "disabled" };
    const provider =
      request.backendId ?? route.defaultBackendId ?? providerForPurpose(request.purpose);
    const binding = this.routeBackends(route).find(
      (item) => item.backendId === provider && item.enabled,
    );
    if (!binding) return { accepted: false, reason: "provider_unavailable" };
    if (provider !== "general_backend" && !this.isMcpBackendAvailable(provider))
      return { accepted: false, reason: "provider_unavailable" };
    const nativeImages = provider === "mcp_openai" || provider === "mcp_gemini";
    const dynamic = (() => {
      try {
        return {
          success: true as const,
          data: parseImageDynamicParameters(request.parameters ?? {}),
        };
      } catch {
        return { success: false as const, data: undefined };
      }
    })();
    if (
      !dynamic.success ||
      (!nativeImages && request.parameters && Object.keys(request.parameters).length) ||
      (provider === "mcp_openai" && (dynamic.data?.aspectRatio || dynamic.data?.imageSize)) ||
      (provider === "mcp_gemini" && dynamic.data?.quality && dynamic.data.quality !== "auto")
    )
      return {
        accepted: false,
        reason: "invalid_request",
        message: "Unsupported dynamic image parameters",
      };
    if (
      (provider === "mcp_openai" || provider === "mcp_gemini") &&
      (request.negativePrompt || request.seed !== undefined)
    )
      return {
        accepted: false,
        reason: "invalid_request",
        message: "GPT and Gemini do not support negativePrompt or seed",
      };
    let generalImageAvailable = false;
    let legacyAvailable = false;
    if (request.purpose === "general_image") {
      const general = await this.generalRouteAvailability(actor.botId, config);
      generalImageAvailable = general.available;
      legacyAvailable = general.legacyAvailable;
      if (!generalImageAvailable) {
        return { accepted: false, reason: "disabled" };
      }
      if (config.generalRouteMode === "explicit_only" && request.routingIntent !== "explicit") {
        return { accepted: false, reason: "not_allowed" };
      }
    }
    let prompt = request.prompt.trim();
    if (!prompt || prompt.length > 8_000) return { accepted: false, reason: "invalid_request" };

    let materialSnapshot: GenerationMaterialSnapshot | undefined;
    if (!request.materials?.skipLibrary && this.generationLibrary) {
      try {
        const resolved = await this.generationLibrary.resolveMaterials(
          {
            botId: actor.botId,
            source: "telegram",
            telegramUserId: actor.userId,
            isAdmin: actor.isBotAdmin,
          },
          prompt,
          request.materials ?? {},
        );
        prompt = resolved.prompt;
        materialSnapshot = resolved.snapshot;
      } catch (error) {
        return {
          accepted: false,
          reason: "invalid_request",
          message:
            error instanceof GenerationLibraryError
              ? error.message
              : "Generation materials are unavailable. Retry, or explicitly skip the library.",
        };
      }
    } else if (request.materials && !request.materials.skipLibrary) {
      return {
        accepted: false,
        reason: "invalid_request",
        message: "Generation library is unavailable",
      };
    }
    if (!prompt || prompt.length > 8_000) return { accepted: false, reason: "invalid_request" };

    const presets = await this.listPresetsForConfig(
      config,
      generalImageAvailable,
      request.purpose,
      provider,
      legacyAvailable,
    );
    if (!nativeImages && presets.length === 0) {
      return { accepted: false, reason: "provider_unavailable" };
    }
    const presetKey =
      request.presetKey ??
      binding.defaultPresetKey ??
      (provider === (route.defaultBackendId ?? providerForPurpose(request.purpose))
        ? route.defaultPresetKey
        : undefined) ??
      (nativeImages ? undefined : presets[0]?.key);
    if (
      (presetKey && !presets.some((preset) => preset.key === presetKey)) ||
      (!nativeImages && !presetKey)
    ) {
      return { accepted: false, reason: "invalid_request", message: "Select an allowed preset" };
    }

    const requiresConfirmation = actor.imageConfirmationPolicy !== "never";

    // A model may repeat create_image with a new tool call id or spell out a default.
    // Deduplicate the resolved provider inputs, including the compiled material prompt.
    const requestKey =
      requestContext.messageId !== undefined
        ? `cos-tool-bot:${actor.botId}:${createHash("sha256")
            .update(
              JSON.stringify([
                actor.chatId,
                actor.userId,
                requestContext.messageId,
                request.purpose,
                provider,
                [
                  dynamic.data.model,
                  dynamic.data.size,
                  dynamic.data.quality,
                  dynamic.data.aspectRatio,
                  dynamic.data.imageSize,
                ],
                prompt,
                presetKey,
                request.negativePrompt || null,
                request.seed ?? null,
              ]),
            )
            .digest("hex")}`
        : undefined;
    if (requestKey) {
      const [existing] = await this.db
        .select()
        .from(imageGenerations)
        .where(
          and(
            eq(imageGenerations.botId, actor.botId),
            eq(imageGenerations.idempotencyKey, requestKey),
          ),
        )
        .limit(1);
      if (existing && canAccess(actor, existing))
        return { accepted: true, generation: toView(existing) };
    }

    let usageReservationId: string | undefined;
    if (!actor.isBotAdmin && !requiresConfirmation) {
      const reservation = await this.usageGovernor.reserve({
        botId: actor.botId,
        resource: "image",
        chatKind: actor.chatType === "private" ? "private" : "group",
        chatId: actor.chatId,
        userId: actor.userId,
        units: 1,
        reservationTtlMs: 24 * 60 * 60 * 1000,
      });
      if (!reservation.allowed) {
        return {
          accepted: false,
          reason: reservation.reason === "concurrency" ? "concurrency_limited" : "rate_limited",
          retryAfterSeconds: reservation.retryAt
            ? Math.max(1, Math.ceil((reservation.retryAt.getTime() - Date.now()) / 1_000))
            : undefined,
        };
      }
      usageReservationId = reservation.reservationId;
    }

    const id = randomUUID();
    const idempotencyKey = requestKey ?? `cos-tool-bot:${actor.botId}:${id}`;
    const endpoint = this.backends[provider]?.endpoint;
    const providerMetadata = { backendId: provider, ...(endpoint ? { endpoint } : {}) };
    const initialSnapshot: ImageGenerationRequestSnapshot = {
      ...options?.requestSnapshot,
      ...(presetKey ? { presetKey } : {}),
      ...dynamic.data,
      ...(dynamic.data.model ? { modelId: dynamic.data.model } : {}),
      ...(options?.requestSnapshot?.requestContext !== undefined ||
      Object.keys(requestContext).length
        ? {
            requestContext: {
              ...options?.requestSnapshot?.requestContext,
              ...requestContext,
            },
          }
        : {}),
      ...(materialSnapshot ? { materials: materialSnapshot } : {}),
    };
    try {
      await this.db.insert(imageGenerations).values({
        id,
        botId: actor.botId,
        chatId: actor.chatId,
        userId: actor.userId,
        provider,
        purpose: request.purpose,
        presetKey,
        idempotencyKey,
        prompt,
        negativePrompt: request.negativePrompt,
        seed: request.seed,
        requestSnapshot: initialSnapshot,
        providerMetadata,
        usageReservationId,
      });
    } catch {
      await this.refund(actor.botId, usageReservationId).catch(() => {});
      if (requestKey) {
        const [existing] = await this.db
          .select()
          .from(imageGenerations)
          .where(
            and(
              eq(imageGenerations.botId, actor.botId),
              eq(imageGenerations.idempotencyKey, requestKey),
            ),
          )
          .limit(1);
        if (existing && canAccess(actor, existing))
          return { accepted: true, generation: toView(existing) };
      }
      return { accepted: false, reason: "provider_unavailable" };
    }
    await this.recordEvent(actor.botId, id, "created", "preparing", undefined, {
      ...requestContext,
      chatId: actor.chatId,
    });

    if (requiresConfirmation) {
      await this.db
        .update(imageGenerations)
        .set({
          state: "awaiting_approval",
          approvalState: "required",
          providerMetadata: { ...providerMetadata, confirmationVersion: 1 },
          updatedAt: new Date(),
        })
        .where(eq(imageGenerations.id, id));
      await this.recordEvent(actor.botId, id, "state_changed", "awaiting_approval", undefined, {
        confirmationRequired: true,
      });
      return { accepted: true, generation: (await this.getOwned(actor, id))! };
    }

    if (provider === "general_backend") {
      this.background(id, "general", () => this.runGeneral(id));
      return { accepted: true, generation: (await this.getOwned(actor, id))! };
    }

    let prepared;
    try {
      prepared = await this.backend(provider, providerMetadata).adapter.prepareGeneration({
        ...(presetKey ? { presetKey } : {}),
        ...dynamic.data,
        prompt,
        ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
      });
    } catch {
      await this.markFailed(
        id,
        "PROVIDER_PREPARE_FAILED",
        "Image provider could not prepare the operation",
      );
      await this.refund(actor.botId, usageReservationId);
      return {
        accepted: false,
        reason: "provider_unavailable",
        generation: (await this.getOwned(actor, id)) ?? undefined,
      };
    }
    if (prepared.approvalRequired && !actor.isBotAdmin && !actor.isDelegatedGroupAdmin) {
      await this.markFailed(id, "APPROVAL_REQUIRED", "This preset requires administrator approval");
      await this.refund(actor.botId, usageReservationId);
      return {
        accepted: false,
        reason: "approval_required",
        generation: (await this.getOwned(actor, id)) ?? undefined,
      };
    }
    try {
      const requestSnapshot = extractImageGenerationRequestSnapshot(
        prepared.value,
        initialSnapshot,
      );
      await this.db
        .update(imageGenerations)
        .set({
          providerMetadata: mergeProviderMetadata({ planId: prepared.planId }),
          requestSnapshot,
          approvalState: prepared.approvalRequired ? "required" : "not_required",
          updatedAt: new Date(),
        })
        .where(eq(imageGenerations.id, id));
      await this.recordEvent(actor.botId, id, "planned", "preparing", undefined, {
        approvalRequired: prepared.approvalRequired,
      });
    } catch {
      await this.markFailed(id, "PLAN_PERSIST_FAILED", "Image plan could not be persisted").catch(
        () => {},
      );
      await this.refund(actor.botId, usageReservationId).catch(() => {});
      return {
        accepted: false,
        reason: "provider_unavailable",
        generation: (await this.getOwned(actor, id).catch(() => null)) ?? undefined,
      };
    }

    try {
      const operation = await this.backend(provider).adapter.startGeneration(
        prepared.planId,
        idempotencyKey,
      );
      await this.persistStartedOperation(id, prepared.planId, operation, actor.botId);
      this.background(id, "advance", () => this.advance(id));
      return { accepted: true, generation: (await this.getOwned(actor, id))! };
    } catch {
      // The provider may have accepted the idempotent start before the connection or
      // database failed. Keep the reservation and retry the same key during recovery.
      this.scheduleAdvance(id, 5_000);
      return { accepted: true, generation: (await this.getOwned(actor, id))! };
    }
  }

  async get(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageGenerationView | null> {
    return this.getOwned(actor, generationId);
  }

  confirm(actor: ImageGenerationActor, generationId: string): Promise<ImageGenerationAdmission> {
    return this.execute(async () => {
      const row = await this.getRow(generationId);
      if (!row || !canAccess(actor, row)) return { accepted: false, reason: "not_allowed" };
      if (row.state !== "awaiting_approval" || row.approvalState !== "required") {
        return {
          accepted: false,
          reason: "invalid_request",
          message: "Image confirmation is no longer pending",
          generation: toView(row),
        };
      }
      const snapshot = row.requestSnapshot ?? {};
      const draftSeed =
        typeof row.providerMetadata?.["confirmationDraftSeed"] === "number"
          ? row.providerMetadata["confirmationDraftSeed"]
          : row.seed;
      const draftPrompt =
        typeof row.providerMetadata?.["confirmationDraftPrompt"] === "string"
          ? row.providerMetadata["confirmationDraftPrompt"]
          : row.prompt;
      const claimed = await this.db
        .update(imageGenerations)
        .set({ state: "cancelled", approvalState: "approved", updatedAt: new Date() })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "awaiting_approval"),
          ),
        )
        .returning({ id: imageGenerations.id });
      if (!claimed.length)
        return {
          accepted: false,
          reason: "invalid_request",
          message: "Image confirmation was already handled",
        };
      const confirmedActor = { ...actor, imageConfirmationPolicy: "never" as const };
      const parameters = Object.fromEntries(
        Object.entries({
          model: snapshot.modelId,
          size: snapshot.size,
          quality: snapshot.quality,
          aspectRatio: snapshot.aspectRatio,
          imageSize: snapshot.imageSize,
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const result = await this.createImpl(
        {
          ...confirmedActor,
          ...(Object.keys(snapshot.requestContext ?? {}).length || actor.requestContext
            ? {
                requestContext: {
                  ...snapshot.requestContext,
                  ...actor.requestContext,
                },
              }
            : {}),
        },
        {
          purpose: row.purpose as ImagePurpose,
          backendId: row.provider as ImageProviderRoute,
          prompt: draftPrompt,
          ...(row.presetKey ? { presetKey: row.presetKey } : {}),
          ...(row.negativePrompt ? { negativePrompt: row.negativePrompt } : {}),
          ...(draftSeed === null || draftSeed === undefined ? {} : { seed: draftSeed }),
          ...(Object.keys(parameters).length ? { parameters } : {}),
        },
        { requestSnapshot: snapshot },
      );
      if (!result.accepted) await this.restoreConfirmation(generationId, row.botId);
      return result;
    });
  }

  private async restoreConfirmation(generationId: string, botId: string): Promise<void> {
    const [restored] = await this.db
      .update(imageGenerations)
      .set({ state: "awaiting_approval", approvalState: "required", updatedAt: new Date() })
      .where(
        and(
          eq(imageGenerations.id, generationId),
          eq(imageGenerations.state, "cancelled"),
          eq(imageGenerations.approvalState, "approved"),
        ),
      )
      .returning({ id: imageGenerations.id });
    if (restored)
      await this.recordEvent(botId, generationId, "state_changed", "awaiting_approval", undefined, {
        confirmation: "retryable",
      });
  }

  editConfirmation(
    actor: ImageGenerationActor,
    generationId: string,
    patch: { seed: number },
  ): Promise<ImageGenerationView | null> {
    return this.execute(async () => {
      const row = await this.getRow(generationId);
      if (!row || !canAccess(actor, row) || row.state !== "awaiting_approval") return null;
      if (!Number.isSafeInteger(patch.seed) || patch.seed < 0 || patch.seed > 4_294_967_295)
        return null;
      const version =
        typeof row.providerMetadata?.["confirmationVersion"] === "number"
          ? row.providerMetadata["confirmationVersion"] + 1
          : 2;
      const metadata = {
        ...row.providerMetadata,
        confirmationVersion: version,
        confirmationDraftSeed: patch.seed,
        confirmationState: "draft",
      };
      const [updated] = await this.db
        .update(imageGenerations)
        .set({ providerMetadata: metadata, updatedAt: new Date() })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "awaiting_approval"),
            sql`coalesce((${imageGenerations.providerMetadata}->>'confirmationVersion')::integer, 1) = ${version - 1}`,
          ),
        )
        .returning({ id: imageGenerations.id });
      return updated ? this.getOwned(actor, generationId) : null;
    });
  }

  discardConfirmationEdit(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageGenerationView | null> {
    return this.execute(async () => {
      const row = await this.getRow(generationId);
      if (!row || !canAccess(actor, row) || row.state !== "awaiting_approval") return null;
      const version =
        typeof row.providerMetadata?.["confirmationVersion"] === "number"
          ? row.providerMetadata["confirmationVersion"] + 1
          : 2;
      const metadata: Record<string, unknown> = {
        ...row.providerMetadata,
        confirmationVersion: version,
      };
      delete metadata.confirmationDraftSeed;
      delete metadata.confirmationState;
      const [updated] = await this.db
        .update(imageGenerations)
        .set({ providerMetadata: metadata, updatedAt: new Date() })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "awaiting_approval"),
          ),
        )
        .returning({ id: imageGenerations.id });
      return updated ? this.getOwned(actor, generationId) : null;
    });
  }

  editConfirmationPrompt(
    actor: ImageGenerationActor,
    generationId: string,
    prompt: string,
  ): Promise<ImageGenerationView | null> {
    return this.execute(async () => {
      const row = await this.getRow(generationId);
      if (!row || !canAccess(actor, row) || row.state !== "awaiting_approval") return null;
      const value = prompt.trim();
      if (!value || value.length > 8_000) return null;
      const version =
        typeof row.providerMetadata?.["confirmationVersion"] === "number"
          ? row.providerMetadata["confirmationVersion"] + 1
          : 2;
      const metadata = {
        ...row.providerMetadata,
        confirmationVersion: version,
        confirmationDraftPrompt: value,
        confirmationState: "draft",
      };
      const [updated] = await this.db
        .update(imageGenerations)
        .set({ providerMetadata: metadata, updatedAt: new Date() })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "awaiting_approval"),
            sql`coalesce((${imageGenerations.providerMetadata}->>'confirmationVersion')::integer, 1) = ${version - 1}`,
          ),
        )
        .returning({ id: imageGenerations.id });
      return updated ? this.getOwned(actor, generationId) : null;
    });
  }

  recordConfirmationMessage(
    actor: ImageGenerationActor,
    generationId: string,
    messageId: number,
  ): Promise<boolean> {
    return this.execute(async () => {
      const row = await this.getRow(generationId);
      if (!row || !canAccess(actor, row) || row.state !== "awaiting_approval") return false;
      const [updated] = await this.db
        .update(imageGenerations)
        .set({
          providerMetadata: { ...row.providerMetadata, confirmationMessageId: messageId },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "awaiting_approval"),
          ),
        )
        .returning({ id: imageGenerations.id });
      return Boolean(updated);
    });
  }

  findConfirmationByMessage(
    actor: ImageGenerationActor,
    messageId: number,
  ): Promise<ImageGenerationView | null> {
    return this.execute(async () => {
      const rows = await this.db
        .select()
        .from(imageGenerations)
        .where(
          and(
            eq(imageGenerations.botId, actor.botId),
            eq(imageGenerations.chatId, actor.chatId),
            eq(imageGenerations.state, "awaiting_approval"),
          ),
        )
        .limit(100);
      const row = rows.find(
        (candidate) => candidate.providerMetadata?.["confirmationMessageId"] === messageId,
      );
      return row && canAccess(actor, row) ? toView(row) : null;
    });
  }

  cancelConfirmation(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageCancellationResult> {
    return this.execute(async () => {
      const row = await this.getRow(generationId);
      return this.cancelConfirmationImpl(actor, generationId, row);
    });
  }

  private async cancelConfirmationImpl(
    actor: ImageGenerationActor,
    generationId: string,
    row: GenerationRow | null,
  ): Promise<ImageCancellationResult> {
    if (!row || !canAccess(actor, row)) return { ok: false, reason: "not_found" };
    if (row.state !== "awaiting_approval")
      return { ok: false, reason: "terminal", generation: toView(row) };
    const [cancelled] = await this.db
      .update(imageGenerations)
      .set({ state: "cancelled", approvalState: "rejected", updatedAt: new Date() })
      .where(
        and(eq(imageGenerations.id, generationId), eq(imageGenerations.state, "awaiting_approval")),
      )
      .returning({ id: imageGenerations.id });
    if (!cancelled)
      return {
        ok: false,
        reason: "terminal",
        generation: (await this.getOwned(actor, generationId))!,
      };
    await this.recordEvent(row.botId, generationId, "state_changed", "cancelled", undefined, {
      confirmation: "rejected",
    });
    return { ok: true, generation: (await this.getOwned(actor, generationId))! };
  }

  retryDelivery(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageDeliveryRetryResult> {
    return this.execute(() => this.retryDeliveryImpl(actor, generationId));
  }

  private async retryDeliveryImpl(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageDeliveryRetryResult> {
    const row = await this.getRow(generationId);
    if (!row || !canAccess(actor, row)) return { ok: false, reason: "not_found" };
    const generation = toView(row);
    if (generation.deliveryState === "delivered")
      return { ok: false, reason: "already_delivered", generation };
    if (generation.deliveryState === "unknown")
      return { ok: false, reason: "delivery_unknown", generation };
    if (
      row.state !== "succeeded" ||
      !row.localFiles.length ||
      row.deliveryClaimedAt ||
      row.providerMetadata?.["deliveryState"] !== "failed"
    )
      return { ok: false, reason: "not_ready", generation };
    this.scheduleAdvance(generationId, 0);
    return { ok: true, generation };
  }

  findByDeliveryMessage(
    actor: ImageGenerationActor,
    telegramMessageId: number,
  ): Promise<ImageGenerationReplyContext | null> {
    return this.execute(() => this.findByDeliveryMessageImpl(actor, telegramMessageId));
  }

  private async findByDeliveryMessageImpl(
    actor: ImageGenerationActor,
    telegramMessageId: number,
  ): Promise<ImageGenerationReplyContext | null> {
    const [row] = await this.db
      .select()
      .from(imageGenerations)
      .where(
        and(
          eq(imageGenerations.botId, actor.botId),
          eq(imageGenerations.chatId, actor.chatId),
          sql`${imageGenerations.deliveryMessageIds}::jsonb @> ${JSON.stringify([telegramMessageId])}::jsonb`,
        ),
      )
      .orderBy(desc(imageGenerations.deliveredAt))
      .limit(1);
    if (!row) return null;

    let providerDetails: Record<string, unknown> | undefined;
    if (row.provider !== "general_backend" && row.providerOperationId) {
      providerDetails = await Promise.resolve()
        .then(() =>
          this.backend(row.provider, row.providerMetadata).adapter.getGenerationDetails(
            row.providerOperationId!,
          ),
        )
        .catch((error: unknown) => {
          this.logger.warn(
            { code: sanitizedProviderErrorCode(error), generationId: row.id },
            "PixAI MCP generation detail lookup failed",
          );
          return undefined;
        });
    }

    const artifactOrdinal = row.deliveryMessageIds.indexOf(telegramMessageId);
    return {
      ...toView(row),
      creatorUserId: row.userId,
      prompt: row.prompt,
      negativePrompt: row.negativePrompt ?? undefined,
      seed: row.seed ?? undefined,
      providerOperationId: row.providerOperationId ?? undefined,
      providerMetadata: row.providerMetadata
        ? (redactDiagnostic(row.providerMetadata) as Record<string, unknown>)
        : undefined,
      providerDetails: providerDetails
        ? (redactDiagnostic(providerDetails) as Record<string, unknown>)
        : undefined,
      artifactOrdinal: artifactOrdinal >= 0 ? artifactOrdinal : undefined,
    };
  }

  getAdminRequestSnapshot(
    botId: string,
    generationId: string,
  ): Promise<ImageGenerationRequestSnapshot | undefined> {
    return this.execute(() => this.getAdminRequestSnapshotImpl(botId, generationId));
  }

  private async getAdminRequestSnapshotImpl(
    botId: string,
    generationId: string,
  ): Promise<ImageGenerationRequestSnapshot | undefined> {
    const row = await this.getRow(generationId);
    if (!row || row.botId !== botId) return undefined;
    if (hasUsefulRequestSnapshot(row.requestSnapshot)) return row.requestSnapshot ?? undefined;
    if (row.provider === "general_backend" || !row.providerOperationId) {
      return row.requestSnapshot ?? undefined;
    }
    const details = await Promise.resolve()
      .then(() =>
        this.backend(row.provider, row.providerMetadata).adapter.getGenerationDetails(
          row.providerOperationId!,
        ),
      )
      .catch(() => null);
    if (!details) return row.requestSnapshot ?? undefined;
    const snapshot = extractImageGenerationRequestSnapshot(details, row.requestSnapshot ?? {});
    await this.db
      .update(imageGenerations)
      .set({ requestSnapshot: snapshot, updatedAt: new Date() })
      .where(and(eq(imageGenerations.id, generationId), eq(imageGenerations.botId, botId)));
    return snapshot;
  }

  deleteAdminGeneration(
    botId: string,
    generationId: string,
  ): Promise<"deleted" | "not_found" | "not_terminal"> {
    return this.execute(() => this.deleteAdminGenerationImpl(botId, generationId));
  }

  private async deleteAdminGenerationImpl(
    botId: string,
    generationId: string,
  ): Promise<"deleted" | "not_found" | "not_terminal"> {
    const row = await this.getRow(generationId);
    if (!row || row.botId !== botId) return "not_found";
    if (!DELETABLE_STATES.includes(row.state as ImageGenerationState)) return "not_terminal";
    const [deleted] = await this.db
      .delete(imageGenerations)
      .where(and(eq(imageGenerations.id, generationId), eq(imageGenerations.botId, botId)))
      .returning({ id: imageGenerations.id, localFiles: imageGenerations.localFiles });
    if (!deleted) return "not_found";
    const dir = path.join(getDataDir(botId), "generations");
    await Promise.allSettled(
      deleted.localFiles
        .filter((filename) => path.basename(filename) === filename)
        .map((filename) => unlink(path.join(dir, filename))),
    );
    return "deleted";
  }

  cancel(actor: ImageGenerationActor, generationId: string): Promise<ImageCancellationResult> {
    return this.execute(() => this.cancelImpl(actor, generationId));
  }

  private async cancelImpl(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageCancellationResult> {
    const row = await this.getRow(generationId);
    if (!row || !canAccess(actor, row)) return { ok: false, reason: "not_found" };
    if (row.state === "awaiting_approval")
      return this.cancelConfirmationImpl(actor, generationId, row);
    if (
      row.state === "cancel_requested" ||
      row.providerMetadata?.["cancellationState"] === "requested"
    ) {
      return { ok: true, generation: toView(row) };
    }
    if (!PENDING_STATES.includes(row.state as ImageGenerationState)) {
      return { ok: false, reason: "terminal", generation: toView(row) };
    }
    if (row.providerMetadata?.["cancellationState"] === "unknown") {
      return {
        ok: false,
        reason: "provider_error",
        generation: toView(row),
        message: "Cancellation result is unknown; keep observing the original task",
      };
    }
    if (row.provider === "mcp_pixai" && !row.providerOperationId) {
      const planId = getPersistedPlanId(row.providerMetadata);
      if (planId) {
        const [claimed] = await this.db
          .update(imageGenerations)
          .set({
            state: "cancel_requested",
            providerMetadata: mergeProviderMetadata({
              planId,
              cancelRequested: true,
              cancelAttempted: false,
              cancellationState: "requested",
              cancellationPreviousState: row.state,
            }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(imageGenerations.id, generationId),
              inArray(imageGenerations.state, COMPLETABLE_STATES),
              sql`coalesce(${imageGenerations.providerMetadata}->>'cancellationState', '') not in ('requested', 'unknown')`,
            ),
          )
          .returning({ id: imageGenerations.id });
        if (!claimed) {
          const latest = await this.getOwned(actor, generationId);
          return latest
            ? { ok: false, reason: "terminal", generation: latest }
            : { ok: false, reason: "not_found" };
        }
        await this.recordEvent(row.botId, generationId, "cancel_requested", "cancel_requested");
        this.background(generationId, "advance", () => this.advance(generationId));
        return { ok: true, generation: (await this.getOwned(actor, generationId))! };
      }
    }
    if (row.provider === "general_backend" || !row.providerOperationId) {
      // Without a provider cancellation handle, aborting the local HTTP request
      // cannot prove cancellation and would lose a result still being generated.
      await this.db
        .update(imageGenerations)
        .set({
          providerMetadata: mergeProviderMetadata({ cancellationState: "rejected" }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            inArray(imageGenerations.state, PENDING_STATES),
          ),
        );
      await this.recordEvent(
        row.botId,
        generationId,
        "cancel_resolved",
        row.state as ImageGenerationState,
        undefined,
        { cancellationState: "rejected" },
      );
      return {
        ok: false,
        reason: "provider_rejected",
        generation: (await this.getOwned(actor, generationId))!,
        message: "Cancellation is unavailable; the original task remains tracked",
      };
    }
    const originalState = row.state;
    const [cancelClaim] = await this.db
      .update(imageGenerations)
      .set({
        state: "cancel_requested",
        providerMetadata: mergeProviderMetadata({
          cancelRequested: true,
          cancelAttempted: true,
          cancellationState: "requested",
          cancellationPreviousState: row.state,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imageGenerations.id, generationId),
          inArray(imageGenerations.state, COMPLETABLE_STATES),
          sql`coalesce(${imageGenerations.providerMetadata}->>'cancellationState', '') not in ('requested', 'unknown')`,
        ),
      )
      .returning({ id: imageGenerations.id });
    if (!cancelClaim) {
      const latest = await this.getOwned(actor, generationId);
      return latest
        ? { ok: false, reason: "terminal", generation: latest }
        : { ok: false, reason: "not_found" };
    }
    await this.recordEvent(row.botId, generationId, "cancel_requested", "cancel_requested");
    try {
      const operation = await this.backend(
        row.provider,
        row.providerMetadata,
      ).adapter.cancelGeneration(row.providerOperationId);
      const state = stateAfterCancellation(operation, row);
      const [claimed] = await this.db
        .update(imageGenerations)
        .set({
          state,
          providerState: operation.state,
          providerMetadata: mergeProviderMetadata({
            cancelRequested: false,
            cancellationState: cancellationState(operation),
          }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "cancel_requested"),
          ),
        )
        .returning({ id: imageGenerations.id });
      if (claimed && state === "cancelled" && row.usageReservationId) {
        await this.refund(row.botId, row.usageReservationId);
      }
      if (claimed) {
        await this.recordEvent(row.botId, generationId, "cancel_resolved", state, operation.state);
      }
      if (state !== "cancelled") this.scheduleAdvance(generationId, 0);
      const generation = (await this.getOwned(actor, generationId))!;
      return cancellationState(operation) === "rejected"
        ? { ok: false, reason: "provider_rejected", generation }
        : { ok: true, generation };
    } catch {
      await this.db
        .update(imageGenerations)
        .set({
          state: originalState,
          providerMetadata: mergeProviderMetadata({
            cancelRequested: false,
            cancellationState: "unknown",
          }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "cancel_requested"),
          ),
        );
      await this.recordEvent(
        row.botId,
        generationId,
        "cancel_resolved",
        originalState as ImageGenerationState,
        undefined,
        { cancellationState: "unknown" },
      );
      this.scheduleAdvance(generationId, 0);
      return {
        ok: false,
        reason: "provider_error",
        generation: (await this.getOwned(actor, generationId))!,
      };
    }
  }

  recoverPending(): Promise<void> {
    return this.execute(() => this.recoverPendingImpl());
  }

  private async recoverPendingImpl(): Promise<void> {
    const rows = await this.db
      .select({ id: imageGenerations.id })
      .from(imageGenerations)
      .where(inArray(imageGenerations.state, RECOVERABLE_STATES));
    await Promise.allSettled(rows.map((row) => this.advance(row.id)));
  }

  async getConfig(botId: string): Promise<ImageGovernanceConfig> {
    const [row] = await this.db
      .select({ config: imageGenerationConfigs.config })
      .from(imageGenerationConfigs)
      .where(eq(imageGenerationConfigs.botId, botId))
      .limit(1);
    if (!row) return structuredClone(DEFAULT_IMAGE_GOVERNANCE_CONFIG);
    return {
      ...row.config,
      privateChatUserIds: [...new Set(row.config.privateChatUserIds ?? [])],
    };
  }

  async setConfig(botId: string, config: ImageGovernanceConfig): Promise<void> {
    await this.db
      .insert(imageGenerationConfigs)
      .values({ botId, config })
      .onConflictDoUpdate({
        target: imageGenerationConfigs.botId,
        set: { config, updatedAt: new Date() },
      });
  }

  private async advance(id: string): Promise<void> {
    if (this.advancing.has(id)) {
      // A cancellation or recovery wake-up must survive an in-flight provider wait.
      this.scheduleAdvance(id, 1_000);
      return;
    }
    this.advancing.add(id);
    try {
      await this.advanceOnce(id);
    } catch {
      this.logger.warn({ generationId: id }, "Image operation recovery deferred");
      this.scheduleAdvance(id, 15_000);
    } finally {
      this.advancing.delete(id);
    }
  }

  private async advanceOnce(id: string): Promise<void> {
    const row = await this.getRow(id);
    if (!row) return;
    if (row.state === "awaiting_approval") return;
    if (row.state === "succeeded" && row.localFiles.length > 0) {
      await this.settleImageUsage(row);
      await this.deliverCompleted(row);
      return;
    }
    if (row.provider === "general_backend") {
      // The compatible backend has no durable operation handle. An interrupted
      // in-flight request cannot be resumed safely after process restart.
      if (PENDING_STATES.includes(row.state as ImageGenerationState)) {
        if (this.generalRuns.has(id)) return;
        await this.markUnknown(id, "GENERAL_BACKEND_INTERRUPTED");
        await this.removeUntrackedGenerationFiles(row.botId, row.id);
      }
      return;
    }
    try {
      this.backend(row.provider, row.providerMetadata);
    } catch {
      await this.db
        .update(imageGenerations)
        .set({
          state: "attention_required",
          errorCode: "ORIGINAL_CONNECTION_UNAVAILABLE",
          errorMessage: "Restore the original image provider endpoint before recovering this task",
          updatedAt: new Date(),
        })
        .where(eq(imageGenerations.id, id));
      return;
    }
    if (!row.providerOperationId) {
      const planId = getPersistedPlanId(row.providerMetadata);
      if (!planId) {
        await this.markFailed(
          id,
          "MISSING_PROVIDER_PLAN",
          "Image operation could not be recovered",
        );
        if (row.usageReservationId) await this.refund(row.botId, row.usageReservationId);
        return;
      }
      try {
        const operation = await this.backend(
          row.provider,
          row.providerMetadata,
        ).adapter.startGeneration(planId, row.idempotencyKey);
        await this.persistStartedOperation(id, planId, operation, row.botId);
        this.scheduleAdvance(id, 0);
      } catch {
        this.logger.warn({ generationId: id }, "Image operation start recovery deferred");
        this.scheduleAdvance(id, 15_000);
      }
      return;
    }
    if (hasPendingCancelIntent(row.providerMetadata)) {
      if (row.providerMetadata?.["cancelAttempted"] !== false) {
        // A missing legacy marker cannot prove that cancellation was never dispatched.
        // Restore observation after a crash without repeating a possibly accepted request.
        const [observed] = await this.db
          .update(imageGenerations)
          .set({
            state: previousGenerationState(row),
            providerMetadata: mergeProviderMetadata({
              cancelRequested: false,
              cancellationState: "unknown",
            }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(imageGenerations.id, id),
              eq(imageGenerations.state, "cancel_requested"),
              sql`${imageGenerations.providerMetadata}->>'cancelAttempted' is distinct from 'false'`,
            ),
          )
          .returning({ id: imageGenerations.id });
        if (!observed) return;
        await this.recordEvent(
          row.botId,
          id,
          "cancel_resolved",
          previousGenerationState(row),
          undefined,
          { cancellationState: "unknown" },
        );
        this.scheduleAdvance(id, 0);
        return;
      }
      // Only an explicitly unattempted intent may dispatch; persist the fence before the RPC.
      const [cancelClaim] = await this.db
        .update(imageGenerations)
        .set({
          providerMetadata: mergeProviderMetadata({ cancelAttempted: true }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imageGenerations.id, id),
            eq(imageGenerations.state, "cancel_requested"),
            sql`${imageGenerations.providerMetadata}->>'cancelRequested' = 'true'`,
            sql`${imageGenerations.providerMetadata}->>'cancelAttempted' = 'false'`,
          ),
        )
        .returning({ id: imageGenerations.id });
      if (!cancelClaim) {
        this.scheduleAdvance(id, 1_000);
        return;
      }
      try {
        const operation = await this.backend(
          row.provider,
          row.providerMetadata,
        ).adapter.cancelGeneration(row.providerOperationId);
        const state = stateAfterCancellation(operation, row);
        const [claimed] = await this.db
          .update(imageGenerations)
          .set({
            state,
            providerState: operation.state,
            providerMetadata: mergeProviderMetadata({
              cancelRequested: false,
              cancellationState: cancellationState(operation),
            }),
            updatedAt: new Date(),
          })
          .where(and(eq(imageGenerations.id, id), eq(imageGenerations.state, "cancel_requested")))
          .returning({ id: imageGenerations.id });
        if (!claimed) return;
        await this.recordEvent(row.botId, id, "cancel_resolved", state, operation.state);
        if (state === "cancelled" && row.usageReservationId) {
          await this.refund(row.botId, row.usageReservationId);
          return;
        }
        this.scheduleAdvance(id, 5_000);
      } catch {
        await this.db
          .update(imageGenerations)
          .set({
            state: previousGenerationState(row),
            providerMetadata: mergeProviderMetadata({
              cancelRequested: false,
              cancellationState: "unknown",
            }),
            updatedAt: new Date(),
          })
          .where(and(eq(imageGenerations.id, id), eq(imageGenerations.state, "cancel_requested")));
        await this.recordEvent(
          row.botId,
          id,
          "cancel_resolved",
          previousGenerationState(row),
          undefined,
          { cancellationState: "unknown" },
        );
        this.scheduleAdvance(id, 15_000);
      }
      return;
    }
    try {
      const operation = await this.backend(
        row.provider,
        row.providerMetadata,
      ).adapter.waitForGeneration(row.providerOperationId, 10_000);
      const state = normalizeImageOperationState(operation);
      const persistedState = state === "succeeded" ? "running" : state;
      const [observed] = await this.db
        .update(imageGenerations)
        .set({
          state: persistedState,
          providerState: operation.state,
          ...(state === "cancelled"
            ? { providerMetadata: mergeProviderMetadata({ cancellationState: "confirmed" }) }
            : {}),
          approvalState:
            row.approvalState === "required" && state !== "awaiting_approval"
              ? state === "failed"
                ? "rejected"
                : "approved"
              : row.approvalState,
          updatedAt: new Date(),
        })
        .where(
          and(eq(imageGenerations.id, id), inArray(imageGenerations.state, COMPLETABLE_STATES)),
        )
        .returning({ id: imageGenerations.id });
      if (!observed) return;
      if (row.state !== persistedState || row.providerState !== operation.state) {
        await this.recordEvent(row.botId, id, "state_changed", persistedState, operation.state);
      }
      if (state === "failed") {
        if (row.usageReservationId) await this.refund(row.botId, row.usageReservationId);
        return;
      }
      if (state === "cancelled") {
        if (row.usageReservationId) await this.refund(row.botId, row.usageReservationId);
        return;
      }
      if (state === "attention_required") return;
      if (state !== "succeeded") {
        this.scheduleAdvance(id, state === "awaiting_approval" ? 30_000 : 5_000);
        return;
      }
      const result = await this.backend(
        row.provider,
        row.providerMetadata,
      ).adapter.getGenerationResult(row.providerOperationId);
      const data: PixaiMcpArtifactData[] = result.images.map((image) =>
        this.backend(row.provider, row.providerMetadata).artifacts.readInline(image),
      );
      for (const link of result.resourceLinks)
        data.push(await this.backend(row.provider, row.providerMetadata).artifacts.download(link));
      await this.completeWithArtifacts(row, dedupeArtifacts(data));
    } catch {
      this.logger.warn({ generationId: id }, "Image operation recovery deferred");
      this.scheduleAdvance(id, 15_000);
    }
  }

  private scheduleAdvance(id: string, delayMs: number): void {
    if (this.closing) return;
    const at = Date.now() + delayMs;
    const existing = this.scheduled.get(id);
    if (existing && existing.at <= at) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.scheduled.delete(id);
      if (this.closing) return;
      this.background(id, "advance", () => this.advance(id));
    }, delayMs);
    timer.unref?.();
    this.scheduled.set(id, { timer, at });
  }

  private async runGeneral(id: string): Promise<void> {
    const row = await this.getRow(id);
    if (!row || !this.generalBackend) return;
    const controller = new AbortController();
    this.generalRuns.set(id, controller);
    try {
      const [claimed] = await this.db
        .update(imageGenerations)
        .set({ state: "running", updatedAt: new Date() })
        .where(and(eq(imageGenerations.id, id), eq(imageGenerations.state, "preparing")))
        .returning({ id: imageGenerations.id });
      if (!claimed) return;
      await this.recordEvent(row.botId, id, "state_changed", "running");
      const data = await this.generalBackend.create({
        botId: row.botId,
        prompt: row.prompt,
        presetKey: row.presetKey ?? undefined,
        negativePrompt: row.negativePrompt ?? undefined,
        seed: row.seed ?? undefined,
        signal: controller.signal,
      });
      const latest = await this.getRow(id);
      if (!latest || latest.state === "waiting_stopped") return;
      await this.completeWithArtifacts(row, dedupeArtifacts(data));
    } catch {
      const latest = await this.getRow(id);
      if (latest?.state === "succeeded") {
        this.scheduleAdvance(id, 15_000);
      } else if (latest?.state !== "waiting_stopped") {
        await this.markUnknown(id, "GENERAL_BACKEND_RESULT_UNKNOWN");
      }
    } finally {
      this.generalRuns.delete(id);
    }
  }

  private async completeWithArtifacts(
    row: Awaited<ReturnType<ImageGenerationService["getRow"]>> & {},
    data: PixaiMcpArtifactData[],
  ): Promise<void> {
    if (data.length === 0) throw new Error("No image artifacts");
    const dir = path.join(getDataDir(row.botId), "generations");
    const localFiles: string[] = [];
    const createdFiles: string[] = [];
    const artifacts: ImageArtifact[] = [];
    try {
      await mkdir(dir, { recursive: true });
      for (const [ordinal, artifact] of data.entries()) {
        const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
        const filename = `${row.id}-${ordinal + 1}.${extensionForMime(artifact.mimeType)}`;
        const filePath = path.join(dir, filename);
        try {
          await writeFile(filePath, artifact.bytes, { flag: "wx" });
          createdFiles.push(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await readFile(filePath);
          const existingSha256 = createHash("sha256").update(existing).digest("hex");
          if (existing.byteLength !== artifact.bytes.byteLength || existingSha256 !== sha256) {
            throw new Error(`Artifact file collision for ${filename}`);
          }
        }
        localFiles.push(filename);
        artifacts.push({
          ordinal,
          mimeType: artifact.mimeType,
          filename,
          byteSize: artifact.bytes.byteLength,
          sha256,
          nsfw: this.nsfwChecker
            ? await this.nsfwChecker.checkImageBytes(artifact.bytes)
            : { status: "unavailable", isNsfw: true, scores: null },
        });
      }
      const completedAt = new Date();
      const persistSuccess = async (db: Pick<Database, "update">) => {
        const [claimed] = await db
          .update(imageGenerations)
          .set({
            state: "succeeded",
            providerMetadata: mergeProviderMetadata({ deliveryState: "pending" }),
            artifacts,
            localFiles,
            completedAt,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(imageGenerations.id, row.id),
              inArray(imageGenerations.state, COMPLETABLE_STATES),
            ),
          )
          .returning({ id: imageGenerations.id });
        return claimed;
      };
      const assetIds = row.requestSnapshot?.materials?.assets.map((asset) => asset.id) ?? [];
      const claimed =
        assetIds.length > 0
          ? await this.db.transaction(async (tx) => {
              const result = await persistSuccess(tx);
              if (result)
                await recordGenerationAssetUses(tx, row.botId, row.id, assetIds, completedAt);
              return result;
            })
          : await persistSuccess(this.db);
      if (!claimed) {
        await Promise.allSettled(createdFiles.map((filename) => unlink(path.join(dir, filename))));
        return;
      }
    } catch (error) {
      await Promise.allSettled(createdFiles.map((filename) => unlink(path.join(dir, filename))));
      throw error;
    }
    // A diagnostic write must not remove files whose successful state already committed.
    await this.recordEvent(row.botId, row.id, "artifacts_saved", "succeeded", undefined, {
      artifactCount: artifacts.length,
    });
    if (row.usageReservationId) {
      await this.usageGovernor.settle({
        reservationId: row.usageReservationId,
        botId: row.botId,
        resource: "image",
      });
    }
    await this.deliverCompleted({
      ...row,
      artifacts,
      localFiles,
      state: "succeeded",
      providerMetadata: { ...row.providerMetadata, deliveryState: "pending" },
    });
  }

  private async deliverCompleted(row: GenerationRow): Promise<void> {
    if (!this.delivery || row.deliveredAt || row.localFiles.length === 0) return;
    if (row.providerMetadata?.["deliveryState"] === "unknown") return;
    const now = new Date();
    if (!row.providerMetadata?.["deliveryState"] && !row.deliveryClaimedAt) {
      // Old versions cleared claims even for ambiguous failures. No attempt marker
      // or missing diagnostic history can prove that a legacy image was not sent.
      await this.db
        .update(imageGenerations)
        .set({
          providerMetadata: mergeProviderMetadata({
            deliveryState: "unknown",
            deliveryErrorCode: "LEGACY_DELIVERY_UNVERIFIED",
          }),
          updatedAt: now,
        })
        .where(
          and(
            eq(imageGenerations.id, row.id),
            isNull(imageGenerations.deliveredAt),
            isNull(imageGenerations.deliveryClaimedAt),
            sql`${imageGenerations.providerMetadata}->>'deliveryState' is null`,
          ),
        );
      await this.recordEvent(row.botId, row.id, "delivery_failed", "succeeded", undefined, {
        deliveryState: "unknown",
        errorCode: "LEGACY_DELIVERY_UNVERIFIED",
      });
      return;
    }
    const retryAt = row.providerMetadata?.["deliveryRetryAt"];
    if (typeof retryAt === "number" && retryAt > now.getTime()) {
      this.scheduleAdvance(row.id, retryAt - now.getTime());
      return;
    }
    if (row.deliveryClaimedAt) {
      const remaining = row.deliveryClaimedAt.getTime() + DELIVERY_CLAIM_LEASE_MS - now.getTime();
      if (remaining > 0) this.scheduleAdvance(row.id, remaining + 1);
      else {
        await this.db
          .update(imageGenerations)
          .set({
            providerMetadata: mergeProviderMetadata({
              deliveryState: "unknown",
              deliveryErrorCode: "RECEIPT_MISSING",
            }),
            updatedAt: now,
          })
          .where(
            and(
              eq(imageGenerations.id, row.id),
              isNull(imageGenerations.deliveredAt),
              eq(imageGenerations.deliveryClaimedAt, row.deliveryClaimedAt),
            ),
          );
        await this.recordEvent(row.botId, row.id, "delivery_failed", "succeeded", undefined, {
          deliveryState: "unknown",
          errorCode: "RECEIPT_MISSING",
        });
      }
      return;
    }
    const [claimed] = await this.db
      .update(imageGenerations)
      .set({
        deliveryClaimedAt: now,
        providerMetadata: mergeProviderMetadata({
          deliveryState: "sending",
          deliveryErrorCode: null,
          deliveryRetryAt: null,
        }),
        updatedAt: now,
      })
      .where(
        and(
          eq(imageGenerations.id, row.id),
          eq(imageGenerations.state, "succeeded"),
          isNull(imageGenerations.deliveredAt),
          isNull(imageGenerations.deliveryClaimedAt),
          sql`coalesce(${imageGenerations.providerMetadata}->>'deliveryState', 'pending') not in ('unknown', 'delivered')`,
          sql`coalesce((${imageGenerations.providerMetadata}->>'deliveryRetryAt')::bigint, 0) <= ${now.getTime()}`,
        ),
      )
      .returning({ id: imageGenerations.id });
    if (!claimed) return;
    await this.recordEvent(row.botId, row.id, "delivery_started", "succeeded");
    let messageIds: number[];
    let sendAttempted = false;
    try {
      // Older pending deliveries have no safety metadata. Check only their saved files,
      // without creating another provider task or rewriting delivered history.
      if (
        this.nsfwChecker &&
        row.artifacts.some((artifact) => artifact.nsfw?.status !== "checked")
      ) {
        const artifacts = await Promise.all(
          row.artifacts.map(async (artifact) => ({
            ...artifact,
            nsfw:
              artifact.nsfw?.status === "checked"
                ? artifact.nsfw
                : await this.nsfwChecker!.checkImageBytes(
                    await readFile(
                      path.join(
                        getDataDir(row.botId),
                        "generations",
                        row.localFiles[artifact.ordinal]!,
                      ),
                    ),
                  ),
          })),
        );
        await this.db
          .update(imageGenerations)
          .set({ artifacts })
          .where(eq(imageGenerations.id, row.id));
      }
      sendAttempted = true;
      messageIds = await this.delivery.deliver({
        generationId: row.id,
        botId: row.botId,
        chatId: row.chatId,
        threadId: row.requestSnapshot?.requestContext?.threadId,
        userId: row.userId,
        prompt: row.prompt,
        presetKey: row.presetKey ?? undefined,
        requestSnapshot: row.requestSnapshot ?? undefined,
        localFiles: row.localFiles,
      });
      if (
        messageIds.length !== row.localFiles.length ||
        messageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      )
        throw new ImageDeliveryError("unknown", "INVALID_TELEGRAM_RECEIPT");
    } catch (error) {
      const knownUnsent =
        !sendAttempted || (error instanceof ImageDeliveryError && error.outcome === "not_sent");
      const deliveryState = knownUnsent ? "failed" : "unknown";
      const retrySeconds =
        error instanceof ImageDeliveryError ? error.retryAfterSeconds : undefined;
      const retryDelay =
        knownUnsent &&
        typeof retrySeconds === "number" &&
        Number.isFinite(retrySeconds) &&
        retrySeconds >= 0 &&
        retrySeconds <= 86_400
          ? Math.max(1_000, retrySeconds * 1_000)
          : undefined;
      const errorCode =
        error instanceof ImageDeliveryError
          ? sanitizedProviderErrorCode(error)
          : sendAttempted
            ? "TELEGRAM_RESULT_UNKNOWN"
            : "DELIVERY_PREPARATION_FAILED";
      await this.db
        .update(imageGenerations)
        .set({
          deliveryClaimedAt: knownUnsent ? null : now,
          providerMetadata: mergeProviderMetadata({
            deliveryState,
            deliveryErrorCode: errorCode,
            deliveryRetryAt: retryDelay === undefined ? null : Date.now() + retryDelay,
          }),
          updatedAt: new Date(),
        })
        .where(and(eq(imageGenerations.id, row.id), isNull(imageGenerations.deliveredAt)));
      await this.recordEvent(row.botId, row.id, "delivery_failed", "succeeded", undefined, {
        deliveryState,
        errorCode,
      });
      if (retryDelay !== undefined) this.scheduleAdvance(row.id, retryDelay);
      return;
    }
    // Persisting Telegram's returned message ids is separate from sending. If this
    // write fails, retain the claim permanently until recovery marks it unknown.
    // A lost receipt must never cause an automatic resend.
    await this.db
      .update(imageGenerations)
      .set({
        deliveryMessageIds: messageIds,
        deliveredAt: new Date(),
        providerMetadata: mergeProviderMetadata({
          deliveryState: "delivered",
          deliveryErrorCode: null,
          deliveryRetryAt: null,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(imageGenerations.id, row.id), isNull(imageGenerations.deliveredAt)));
    await this.recordEvent(row.botId, row.id, "delivered", "succeeded", undefined, {
      deliveryMessageCount: messageIds.length,
      deliveryMessageIds: messageIds,
      chatId: row.chatId,
      threadId: row.requestSnapshot?.requestContext?.threadId,
    });
  }

  private async canCreate(
    actor: ImageGenerationActor,
    config: ImageGovernanceConfig,
  ): Promise<boolean> {
    if (actor.isBotAdmin || actor.isDelegatedGroupAdmin) return true;
    if (actor.chatType === "private") return config.privateChatUserIds.includes(actor.userId);
    return this.isGroupEnabled(actor.botId, actor.chatId);
  }

  private async generalRouteAvailability(
    botId: string,
    config: ImageGovernanceConfig,
  ): Promise<{ available: boolean; legacyAvailable: boolean }> {
    const route = config.routes.find((route) => route.purpose === "general_image");
    if (!route?.enabled || config.generalRouteMode === "off")
      return { available: false, legacyAvailable: false };
    const bindings = this.routeBackends(route).filter((binding) => binding.enabled);
    const legacyAvailable =
      bindings.some((binding) => binding.backendId === "general_backend") &&
      (await this.isGeneralBackendConfigured(botId));
    return {
      available:
        legacyAvailable ||
        bindings.some(
          (binding) =>
            binding.backendId !== "general_backend" &&
            this.isMcpBackendAvailable(binding.backendId),
        ),
      legacyAvailable,
    };
  }

  private async isGeneralBackendConfigured(botId: string): Promise<boolean> {
    if (!this.generalBackend) return false;
    if (!this.generalBackend.isConfigured) return true;
    try {
      return await this.generalBackend.isConfigured(botId);
    } catch {
      return false;
    }
  }

  private async getOwned(
    actor: ImageGenerationActor,
    id: string,
  ): Promise<ImageGenerationView | null> {
    const row = await this.getRow(id);
    return row && canAccess(actor, row) ? toView(row) : null;
  }

  private async getRow(id: string) {
    const [row] = await this.db
      .select()
      .from(imageGenerations)
      .where(eq(imageGenerations.id, id))
      .limit(1);
    return row ?? null;
  }

  private async markUnknown(id: string, errorCode: string): Promise<void> {
    const [row] = await this.db
      .update(imageGenerations)
      .set({
        state: "attention_required",
        errorCode,
        errorMessage: "Provider result is unknown; inspect the original task before retrying",
        updatedAt: new Date(),
      })
      .where(and(eq(imageGenerations.id, id), inArray(imageGenerations.state, COMPLETABLE_STATES)))
      .returning({ botId: imageGenerations.botId });
    if (row)
      await this.recordEvent(row.botId, id, "state_changed", "attention_required", undefined, {
        errorCode,
      });
  }

  private async markFailed(id: string, errorCode: string, errorMessage: string): Promise<void> {
    const [failed] = await this.db
      .update(imageGenerations)
      .set({
        state: "failed",
        errorCode,
        errorMessage,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(imageGenerations.id, id), inArray(imageGenerations.state, COMPLETABLE_STATES)))
      .returning({ botId: imageGenerations.botId });
    if (failed) {
      await this.recordEvent(failed.botId, id, "failed", "failed", undefined, { errorCode });
    }
  }

  private async removeUntrackedGenerationFiles(botId: string, generationId: string): Promise<void> {
    const dir = path.join(getDataDir(botId), "generations");
    const filenames = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const prefix = `${generationId}-`;
    await Promise.allSettled(
      filenames
        .filter((filename) => filename.startsWith(prefix))
        .map((filename) => unlink(path.join(dir, filename))),
    );
  }

  private async refund(botId: string, reservationId: string | undefined): Promise<void> {
    if (!reservationId) return;
    await this.usageGovernor.refund({ reservationId, botId, resource: "image" });
  }

  private async settleImageUsage(row: GenerationRow): Promise<void> {
    if (!row.usageReservationId) return;
    await this.usageGovernor.settle({
      reservationId: row.usageReservationId,
      botId: row.botId,
      resource: "image",
    });
  }

  private async persistStartedOperation(
    id: string,
    planId: string,
    operation: PixaiGenerationOperation,
    botId?: string,
  ): Promise<void> {
    const observedState = normalizeImageOperationState(operation);
    const normalState = observedState === "succeeded" ? "running" : observedState;
    await this.db
      .update(imageGenerations)
      .set({
        providerOperationId: operation.operationId,
        state: normalState,
        providerState: operation.state,
        providerMetadata: mergeProviderMetadata({
          planId,
          ...sanitizedOperationMetadata(operation),
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(imageGenerations.id, id), inArray(imageGenerations.state, COMPLETABLE_STATES)));
    await this.db
      .update(imageGenerations)
      .set({
        providerOperationId: operation.operationId,
        providerState: operation.state,
        providerMetadata: mergeProviderMetadata({
          planId,
          ...sanitizedOperationMetadata(operation),
          cancelRequested: true,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(imageGenerations.id, id), eq(imageGenerations.state, "cancel_requested")));
    if (botId) {
      await this.recordEvent(botId, id, "submitted", normalState, operation.state, {
        providerOperationId: safeCorrelationId(operation.operationId),
      });
      this.background(id, "snapshot", () =>
        this.refreshRequestSnapshot(botId, id, operation.operationId),
      );
    }
  }

  private async refreshRequestSnapshot(
    botId: string,
    id: string,
    operationId: string,
  ): Promise<void> {
    const row = await this.getRow(id);
    if (!row || row.botId !== botId) return;
    const details = await Promise.resolve()
      .then(() =>
        this.backend(row.provider, row.providerMetadata).adapter.getGenerationDetails(operationId),
      )
      .catch(() => null);
    if (!details) return;
    const snapshot = extractImageGenerationRequestSnapshot(details, row.requestSnapshot ?? {});
    await this.db
      .update(imageGenerations)
      .set({ requestSnapshot: snapshot, updatedAt: new Date() })
      .where(and(eq(imageGenerations.id, id), eq(imageGenerations.botId, botId)));
  }

  private async recordEvent(
    botId: string,
    generationId: string,
    kind: typeof imageGenerationEvents.$inferInsert.kind,
    state?: ImageGenerationState,
    providerState?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(imageGenerationEvents).values({
        botId,
        generationId,
        kind,
        state,
        providerState: safeCorrelationId(providerState),
        metadata,
      });
    } catch (error) {
      this.logger.warn(
        { generationId, kind, code: sanitizedProviderErrorCode(error) },
        "Image generation event persistence failed",
      );
    }
  }
}

function sanitizedProviderErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }
  return "UNKNOWN_PROVIDER_ERROR";
}

type GenerationRow = NonNullable<Awaited<ReturnType<ImageGenerationService["getRow"]>>>;

function canAccess(actor: ImageGenerationActor, row: GenerationRow): boolean {
  if (actor.botId !== row.botId) return false;
  if (actor.isBotAdmin) return true;
  if (actor.userId === row.userId) return true;
  return actor.isDelegatedGroupAdmin && actor.chatId === row.chatId;
}

export function extractImageGenerationRequestSnapshot(
  value: unknown,
  fallback: ImageGenerationRequestSnapshot = {},
): ImageGenerationRequestSnapshot {
  const candidates = collectSnapshotCandidates(value);
  const firstString = (...keys: string[]) => readSnapshotValue(candidates, keys, "string");
  const firstNumber = (...keys: string[]) => readSnapshotValue(candidates, keys, "number");
  const firstBoolean = (...keys: string[]) => readSnapshotValue(candidates, keys, "boolean");
  return compactSnapshot({
    ...fallback,
    presetKey: firstString("presetKey", "preset_key") ?? fallback.presetKey,
    modelId: firstString("modelId", "model_id", "model") ?? fallback.modelId,
    modelVersionId:
      firstString("modelVersionId", "model_version_id", "modelVersion") ?? fallback.modelVersionId,
    width: firstNumber("width") ?? fallback.width,
    height: firstNumber("height") ?? fallback.height,
    aspectRatio: firstString("aspectRatio", "aspect_ratio") ?? fallback.aspectRatio,
    batchSize: firstNumber("batchSize", "batch_size") ?? fallback.batchSize,
    samplingSteps:
      firstNumber("steps", "samplingSteps", "sampling_steps") ?? fallback.samplingSteps,
    cfgScale: firstNumber("cfgScale", "cfg_scale") ?? fallback.cfgScale,
    sampler: firstString("sampler", "samplingMethod", "sampling_method") ?? fallback.sampler,
    promptHelper: firstBoolean("promptHelper", "prompt_helper") ?? fallback.promptHelper,
  });
}

function hasUsefulRequestSnapshot(
  value: ImageGenerationRequestSnapshot | null | undefined,
): boolean {
  if (!value) return false;
  return Object.entries(value).some(([key, item]) => key !== "presetKey" && item !== undefined);
}

function collectSnapshotCandidates(value: unknown): Record<string, unknown>[] {
  if (!isPlainRecord(value)) return [];
  const candidates: Record<string, unknown>[] = [];
  const queue: Array<{ value: Record<string, unknown>; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    candidates.push(current.value);
    if (current.depth >= 5) continue;
    for (const nested of Object.values(current.value)) {
      if (isPlainRecord(nested)) queue.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return candidates;
}

function readSnapshotValue<T extends "string" | "number" | "boolean">(
  candidates: Record<string, unknown>[],
  keys: string[],
  expectedType: T,
): T extends "string"
  ? string | undefined
  : T extends "number"
    ? number | undefined
    : boolean | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const item = candidate[key];
      if (typeof item === expectedType) {
        if (expectedType !== "number" || Number.isFinite(item)) return item as never;
      }
    }
  }
  return undefined as never;
}

function compactSnapshot(value: ImageGenerationRequestSnapshot): ImageGenerationRequestSnapshot {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as ImageGenerationRequestSnapshot;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeProviderMetadata(values: Record<string, unknown>): SQL {
  return sql`coalesce(${imageGenerations.providerMetadata}::jsonb, '{}'::jsonb) || ${JSON.stringify(values)}::jsonb`;
}

function deliveryState(row: GenerationRow): NonNullable<ImageGenerationView["deliveryState"]> {
  if (row.deliveredAt)
    return row.deliveryMessageIds.length &&
      row.deliveryMessageIds.every((id) => Number.isSafeInteger(id) && id > 0)
      ? "delivered"
      : "unknown";
  if (
    row.providerMetadata?.["deliveryState"] === "unknown" ||
    row.providerMetadata?.["deliveryState"] === "delivered"
  )
    return "unknown";
  if (row.deliveryClaimedAt)
    return row.deliveryClaimedAt.getTime() + DELIVERY_CLAIM_LEASE_MS <= Date.now()
      ? "unknown"
      : "sending";
  if (row.providerMetadata?.["deliveryState"] === "failed") return "failed";
  if (row.state === "succeeded" && !row.providerMetadata?.["deliveryState"]) return "unknown";
  return "pending";
}

function toView(row: GenerationRow): ImageGenerationView {
  return {
    id: row.id,
    purpose: row.purpose as ImageGenerationView["purpose"],
    provider: row.provider as ImageGenerationView["provider"],
    presetKey: row.presetKey ?? undefined,
    state: row.state as ImageGenerationState,
    providerState: safeCorrelationId(row.providerState),
    providerOperationId: safeCorrelationId(row.providerOperationId),
    confirmationVersion:
      typeof row.providerMetadata?.["confirmationVersion"] === "number"
        ? row.providerMetadata["confirmationVersion"]
        : undefined,
    confirmationSeed:
      typeof row.providerMetadata?.["confirmationDraftSeed"] === "number"
        ? row.providerMetadata["confirmationDraftSeed"]
        : (row.seed ?? undefined),
    requestContext: row.requestSnapshot?.requestContext,
    deliveryState: deliveryState(row),
    deliveryTarget: { chatId: row.chatId, threadId: row.requestSnapshot?.requestContext?.threadId },
    deliveryMessageIds: row.deliveryMessageIds,
    deliveryErrorCode: safeCorrelationId(row.providerMetadata?.["deliveryErrorCode"]),
    cancellationState: ["requested", "rejected", "confirmed", "unknown"].includes(
      String(row.providerMetadata?.["cancellationState"]),
    )
      ? (row.providerMetadata!["cancellationState"] as ImageGenerationView["cancellationState"])
      : undefined,
    approval: row.approvalState as ImageGenerationView["approval"],
    artifacts: row.artifacts.map(
      ({ filename: _filename, sha256: _sha256, ...artifact }) => artifact,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString(),
    message: row.errorMessage ?? undefined,
  };
}

function providerForPurpose(purpose: "anime_illustration" | "general_image"): ImageProviderRoute {
  return purpose === "anime_illustration" ? "mcp_pixai" : "general_backend";
}

export function projectPixaiPreset(value: unknown): ImagePreset | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const key = typeof record["key"] === "string" ? record["key"] : record["presetKey"];
  if (typeof key !== "string" || !key) return null;
  const autoApproval =
    typeof record["autoApproval"] === "object" &&
    record["autoApproval"] !== null &&
    !Array.isArray(record["autoApproval"])
      ? (record["autoApproval"] as Record<string, unknown>)
      : undefined;
  return {
    key,
    label:
      typeof record["name"] === "string"
        ? record["name"]
        : typeof record["label"] === "string"
          ? record["label"]
          : key,
    description: typeof record["description"] === "string" ? record["description"] : undefined,
    provider: "mcp_pixai",
    autoApproved:
      autoApproval?.["eligible"] === true ||
      record["autoApproved"] === true ||
      record["approvalRequired"] === false,
  };
}

export function normalizeImageOperationState(
  operation: PixaiGenerationOperation,
): ImageGenerationState {
  const state = operation.state?.toLowerCase();
  const nextAction = readNextActionType(operation);
  if (nextAction === "get_result") return "succeeded";
  if (state === "cancelled" || state === "canceled") return "cancelled";
  if (state === "failed" || state === "error" || state === "rejected") return "failed";
  if (
    nextAction === "review_in_panel" ||
    state === "attention_required" ||
    state === "submission_unknown"
  ) {
    return "attention_required";
  }
  if (nextAction === "approve_in_panel" || operation.phase === "approval") {
    return "awaiting_approval";
  }
  if (state === "completed" || state === "succeeded" || state === "success") return "succeeded";
  if (state === "queued" || state === "pending") return "queued";
  if (operation.terminal === true) return "attention_required";
  return "running";
}

function normalizeCancelState(operation: PixaiGenerationOperation): ImageGenerationState {
  const state = operation.state?.toLowerCase();
  if (state === "cancelled" || state === "canceled") return "cancelled";
  if (state === "cancel_rejected" || operation.phase === "cancel_rejected")
    return "cancel_rejected";
  const observed = normalizeImageOperationState(operation);
  return observed === "succeeded" ? "running" : observed;
}

function previousGenerationState(row: GenerationRow): ImageGenerationState {
  const previous = row.providerMetadata?.["cancellationPreviousState"];
  if (PENDING_STATES.includes(previous as ImageGenerationState) && previous !== "cancel_requested")
    return previous as ImageGenerationState;
  if (
    PENDING_STATES.includes(row.state as ImageGenerationState) &&
    row.state !== "cancel_requested"
  )
    return row.state as ImageGenerationState;
  return normalizeImageOperationState({
    operationId: row.providerOperationId ?? "",
    state: row.providerState ?? "running",
    value: {},
  });
}

function stateAfterCancellation(
  operation: PixaiGenerationOperation,
  row: GenerationRow,
): ImageGenerationState {
  const state = normalizeCancelState(operation);
  return state === "cancel_rejected" ? previousGenerationState(row) : state;
}

function cancellationState(
  operation: PixaiGenerationOperation,
): "requested" | "confirmed" | "rejected" {
  const state = normalizeCancelState(operation);
  return state === "cancelled"
    ? "confirmed"
    : state === "cancel_rejected"
      ? "rejected"
      : "requested";
}

function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function sanitizedOperationMetadata(operation: PixaiGenerationOperation): Record<string, unknown> {
  return {
    phase: safeCorrelationId(operation.phase),
    terminal: operation.terminal,
    nextAction: operation.nextAction
      ? { type: safeCorrelationId(operation.nextAction["type"]) }
      : undefined,
  };
}

function getPersistedPlanId(metadata: Record<string, unknown> | null): string | undefined {
  const planId = metadata?.["planId"];
  return typeof planId === "string" && planId ? planId : undefined;
}

function hasPendingCancelIntent(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.["cancelRequested"] === true;
}

function readNextActionType(operation: PixaiGenerationOperation): string | undefined {
  const value = operation.nextAction?.["type"];
  return typeof value === "string" ? value : undefined;
}

function dedupeArtifacts(data: PixaiMcpArtifactData[]): PixaiMcpArtifactData[] {
  const seen = new Set<string>();
  return data.filter((artifact) => {
    const hash = createHash("sha256").update(artifact.bytes).digest("hex");
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}
