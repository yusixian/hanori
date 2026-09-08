import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "@cos-tool-bot/database";
import {
  imageGenerationConfigs,
  imageGenerationEvents,
  imageGenerations,
} from "@cos-tool-bot/database";
import {
  DEFAULT_IMAGE_ROUTE_COPY,
  getDataDir,
  type CreateImageRequest,
  type ImageArtifact,
  type ImageCancellationResult,
  type ImageGenerationActor,
  type ImageGenerationAdmission,
  type ImageGenerationPort,
  type ImageGenerationReplyContext,
  type ImageGenerationRequestSnapshot,
  type ImageGenerationState,
  type ImageGenerationView,
  type ImageGovernanceConfig,
  type ImagePreset,
  type ImageProviderRoute,
  type ImageRouteCapabilities,
} from "@cos-tool-bot/shared";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { PixaiMcpAdapter, PixaiGenerationOperation } from "./pixai-mcp-adapter.js";
import type { PixaiMcpArtifactData, PixaiMcpArtifactReader } from "./pixai-mcp-artifacts.js";
import { UsageGovernor } from "./usage-governor.js";

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
    userId: number;
    prompt: string;
    presetKey?: string;
    requestSnapshot?: ImageGenerationRequestSnapshot;
    localFiles: string[];
  }): Promise<number[]>;
}

export interface ImageGenerationServiceOptions {
  db: Database;
  usageGovernor: UsageGovernor;
  pixai: PixaiMcpAdapter;
  artifacts: PixaiMcpArtifactReader;
  logger: Logger;
  delivery?: ImageGenerationDelivery;
  generalBackend?: GeneralImageBackend;
  isGroupEnabled?: (botId: string, chatId: number) => Promise<boolean>;
}

export const DEFAULT_IMAGE_GOVERNANCE_CONFIG: ImageGovernanceConfig = {
  timezone: "Asia/Shanghai",
  generalRouteMode: "off",
  privateChatUserIds: [],
  routes: [
    {
      purpose: "anime_illustration",
      enabled: true,
      ...DEFAULT_IMAGE_ROUTE_COPY.anime_illustration,
      allowedPresetKeys: [],
    },
    {
      purpose: "general_image",
      enabled: false,
      ...DEFAULT_IMAGE_ROUTE_COPY.general_image,
      allowedPresetKeys: [],
    },
  ],
};

export class ImageGenerationService implements ImageGenerationPort {
  private readonly db: Database;
  private readonly usageGovernor: UsageGovernor;
  private readonly pixai: PixaiMcpAdapter;
  private readonly artifacts: PixaiMcpArtifactReader;
  private readonly logger: Logger;
  private readonly delivery?: ImageGenerationDelivery;
  private readonly generalBackend?: GeneralImageBackend;
  private readonly isGroupEnabled: (botId: string, chatId: number) => Promise<boolean>;
  private readonly generalRuns = new Map<string, AbortController>();
  private readonly advancing = new Set<string>();

  constructor(options: ImageGenerationServiceOptions) {
    this.db = options.db;
    this.usageGovernor = options.usageGovernor;
    this.pixai = options.pixai;
    this.artifacts = options.artifacts;
    this.logger = options.logger;
    this.delivery = options.delivery;
    this.generalBackend = options.generalBackend;
    this.isGroupEnabled = options.isGroupEnabled ?? (async () => false);
  }

  async listRoutes(
    actor: ImageGenerationActor,
    options?: { includePresets?: boolean },
  ): Promise<ImageRouteCapabilities[]> {
    const config = await this.getConfig(actor.botId);
    const generalRouteEnabled = config.routes.some(
      (route) => route.purpose === "general_image" && route.enabled,
    );
    const generalBackendConfigured =
      generalRouteEnabled && config.generalRouteMode !== "off"
        ? await this.isGeneralBackendConfigured(actor.botId)
        : false;
    const presets =
      options?.includePresets === false
        ? []
        : await this.listPresetsForConfig(config, generalBackendConfigured);
    return config.routes.map((route) => ({
      ...route,
      provider: providerForPurpose(route.purpose),
      enabled:
        route.enabled &&
        (route.purpose !== "general_image" ||
          (config.generalRouteMode !== "off" && generalBackendConfigured)),
      presets: presets.filter((preset) => preset.provider === providerForPurpose(route.purpose)),
    }));
  }

  async listPresets(
    actor: ImageGenerationActor,
    purpose?: "anime_illustration" | "general_image",
  ): Promise<ImagePreset[]> {
    const config = await this.getConfig(actor.botId);
    const generalRouteEnabled = config.routes.some(
      (route) => route.purpose === "general_image" && route.enabled,
    );
    const generalBackendConfigured =
      generalRouteEnabled && config.generalRouteMode !== "off"
        ? await this.isGeneralBackendConfigured(actor.botId)
        : false;
    return this.listPresetsForConfig(config, generalBackendConfigured, purpose);
  }

  private async listPresetsForConfig(
    config: ImageGovernanceConfig,
    generalBackendConfigured: boolean,
    purpose?: "anime_illustration" | "general_image",
  ): Promise<ImagePreset[]> {
    const result: ImagePreset[] = [];
    if (!purpose || purpose === "anime_illustration") {
      const route = config.routes.find((candidate) => candidate.purpose === "anime_illustration");
      if (route?.enabled) {
        const raw = await this.pixai.listPresets().catch((error: unknown) => {
          this.logger.warn(
            { code: sanitizedProviderErrorCode(error) },
            "PixAI MCP preset discovery failed",
          );
          return [];
        });
        for (const item of raw) {
          const preset = projectPixaiPreset(item);
          if (!preset) continue;
          if (route.allowedPresetKeys.length > 0 && !route.allowedPresetKeys.includes(preset.key)) {
            continue;
          }
          result.push(preset);
        }
      }
    }
    if (
      (!purpose || purpose === "general_image") &&
      config.routes.some(
        (candidate) => candidate.purpose === "general_image" && candidate.enabled,
      ) &&
      config.generalRouteMode !== "off" &&
      generalBackendConfigured
    ) {
      result.push({
        key: "general-default",
        label: "General image",
        provider: "general_backend",
        autoApproved: true,
      });
    }
    return result;
  }

  async create(
    actor: ImageGenerationActor,
    request: CreateImageRequest,
  ): Promise<ImageGenerationAdmission> {
    const config = await this.getConfig(actor.botId);
    if (!(await this.canCreate(actor, config))) return { accepted: false, reason: "not_allowed" };
    const route = config.routes.find((candidate) => candidate.purpose === request.purpose);
    if (!route?.enabled) return { accepted: false, reason: "disabled" };
    let generalBackendConfigured = false;
    if (request.purpose === "general_image") {
      if (config.generalRouteMode === "off") {
        return { accepted: false, reason: "disabled" };
      }
      generalBackendConfigured = await this.isGeneralBackendConfigured(actor.botId);
      if (!generalBackendConfigured) {
        return { accepted: false, reason: "disabled" };
      }
      if (config.generalRouteMode === "explicit_only" && request.routingIntent !== "explicit") {
        return { accepted: false, reason: "not_allowed" };
      }
    }
    const prompt = request.prompt.trim();
    if (!prompt || prompt.length > 8_000) return { accepted: false, reason: "invalid_request" };

    const presets = await this.listPresetsForConfig(
      config,
      generalBackendConfigured,
      request.purpose,
    );
    if (request.purpose === "anime_illustration" && presets.length === 0) {
      return { accepted: false, reason: "provider_unavailable" };
    }
    const presetKey = request.presetKey ?? route.defaultPresetKey ?? presets[0]?.key;
    if (!presetKey || !presets.some((preset) => preset.key === presetKey)) {
      return { accepted: false, reason: "invalid_request", message: "Select an allowed preset" };
    }

    let usageReservationId: string | undefined;
    if (!actor.isBotAdmin) {
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
    const provider = providerForPurpose(request.purpose);
    const idempotencyKey = `cos-tool-bot:${actor.botId}:${id}`;
    const initialSnapshot: ImageGenerationRequestSnapshot = {
      presetKey,
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
        usageReservationId,
      });
    } catch {
      await this.refund(actor.botId, usageReservationId).catch(() => {});
      return { accepted: false, reason: "provider_unavailable" };
    }
    await this.recordEvent(actor.botId, id, "created", "preparing");

    if (provider === "general_backend") {
      void this.runGeneral(id);
      return { accepted: true, generation: (await this.getOwned(actor, id))! };
    }

    let prepared;
    try {
      prepared = await this.pixai.prepareGeneration({
        presetKey,
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
      return { accepted: false, reason: "provider_unavailable" };
    }
    if (prepared.approvalRequired && !actor.isBotAdmin && !actor.isDelegatedGroupAdmin) {
      await this.markFailed(id, "APPROVAL_REQUIRED", "This preset requires administrator approval");
      await this.refund(actor.botId, usageReservationId);
      return { accepted: false, reason: "approval_required" };
    }
    try {
      const requestSnapshot = extractImageGenerationRequestSnapshot(
        prepared.value,
        initialSnapshot,
      );
      await this.db
        .update(imageGenerations)
        .set({
          providerMetadata: { planId: prepared.planId },
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
      return { accepted: false, reason: "provider_unavailable" };
    }

    try {
      const operation = await this.pixai.startGeneration(prepared.planId, idempotencyKey);
      await this.persistStartedOperation(id, prepared.planId, operation, undefined, actor.botId);
      void this.advance(id);
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

  async findByDeliveryMessage(
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
    if (row.provider === "mcp_pixai" && row.providerOperationId) {
      providerDetails = await this.pixai
        .getGenerationDetails(row.providerOperationId)
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
      providerMetadata: row.providerMetadata ?? undefined,
      providerDetails,
      artifactOrdinal: artifactOrdinal >= 0 ? artifactOrdinal : undefined,
    };
  }

  async getAdminRequestSnapshot(
    botId: string,
    generationId: string,
  ): Promise<ImageGenerationRequestSnapshot | undefined> {
    const row = await this.getRow(generationId);
    if (!row || row.botId !== botId) return undefined;
    if (hasUsefulRequestSnapshot(row.requestSnapshot)) return row.requestSnapshot ?? undefined;
    if (row.provider !== "mcp_pixai" || !row.providerOperationId) {
      return row.requestSnapshot ?? undefined;
    }
    const details = await Promise.resolve()
      .then(() => this.pixai.getGenerationDetails(row.providerOperationId!))
      .catch(() => null);
    if (!details) return row.requestSnapshot ?? undefined;
    const snapshot = extractImageGenerationRequestSnapshot(details, row.requestSnapshot ?? {});
    await this.db
      .update(imageGenerations)
      .set({ requestSnapshot: snapshot, updatedAt: new Date() })
      .where(and(eq(imageGenerations.id, generationId), eq(imageGenerations.botId, botId)));
    return snapshot;
  }

  async deleteAdminGeneration(
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

  async cancel(
    actor: ImageGenerationActor,
    generationId: string,
  ): Promise<ImageCancellationResult> {
    const row = await this.getRow(generationId);
    if (!row || !canAccess(actor, row)) return { ok: false, reason: "not_found" };
    if (row.state === "cancel_requested") {
      return { ok: true, generation: toView(row) };
    }
    if (!PENDING_STATES.includes(row.state as ImageGenerationState)) {
      return { ok: false, reason: "terminal", generation: toView(row) };
    }
    if (row.provider === "mcp_pixai" && !row.providerOperationId) {
      const planId = getPersistedPlanId(row.providerMetadata);
      if (planId) {
        const [claimed] = await this.db
          .update(imageGenerations)
          .set({
            state: "cancel_requested",
            providerMetadata: { ...row.providerMetadata, planId, cancelRequested: true },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(imageGenerations.id, generationId),
              inArray(imageGenerations.state, PENDING_STATES),
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
        void this.advance(generationId);
        return { ok: true, generation: (await this.getOwned(actor, generationId))! };
      }
    }
    if (row.provider !== "mcp_pixai" || !row.providerOperationId) {
      this.generalRuns.get(generationId)?.abort(new Error("Image wait stopped by user"));
      const [claimed] = await this.db
        .update(imageGenerations)
        .set({ state: "waiting_stopped", updatedAt: new Date() })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            inArray(imageGenerations.state, PENDING_STATES),
          ),
        )
        .returning({ id: imageGenerations.id });
      if (!claimed) {
        const latest = await this.getOwned(actor, generationId);
        return latest
          ? { ok: false, reason: "terminal", generation: latest }
          : { ok: false, reason: "not_found" };
      }
      await this.recordEvent(row.botId, generationId, "cancel_resolved", "waiting_stopped");
      if (row.usageReservationId) await this.refund(row.botId, row.usageReservationId);
      return { ok: true, generation: (await this.getOwned(actor, generationId))! };
    }
    const [cancelClaim] = await this.db
      .update(imageGenerations)
      .set({
        state: "cancel_requested",
        providerMetadata: { ...row.providerMetadata, cancelRequested: true },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imageGenerations.id, generationId),
          inArray(imageGenerations.state, COMPLETABLE_STATES),
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
      const operation = await this.pixai.cancelGeneration(row.providerOperationId);
      const state = normalizeCancelState(operation);
      const [claimed] = await this.db
        .update(imageGenerations)
        .set({
          state,
          providerState: operation.state,
          providerMetadata: { ...row.providerMetadata, cancelRequested: false },
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
      return { ok: true, generation: (await this.getOwned(actor, generationId))! };
    } catch {
      await this.db
        .update(imageGenerations)
        .set({
          state: "cancel_rejected",
          providerMetadata: { ...row.providerMetadata, cancelRequested: false },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(imageGenerations.id, generationId),
            eq(imageGenerations.state, "cancel_requested"),
          ),
        );
      await this.recordEvent(row.botId, generationId, "cancel_resolved", "cancel_rejected");
      return {
        ok: false,
        reason: "provider_rejected",
        generation: (await this.getOwned(actor, generationId))!,
      };
    }
  }

  async recoverPending(): Promise<void> {
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
    if (this.advancing.has(id)) return;
    this.advancing.add(id);
    try {
      await this.advanceOnce(id);
    } finally {
      this.advancing.delete(id);
    }
  }

  private async advanceOnce(id: string): Promise<void> {
    const row = await this.getRow(id);
    if (!row) return;
    if (row.state === "succeeded" && row.localFiles.length > 0) {
      await this.settleImageUsage(row);
      await this.deliverCompleted(row);
      return;
    }
    if (row.provider === "general_backend") {
      // The compatible backend has no durable operation handle. An interrupted
      // in-flight request cannot be resumed safely after process restart.
      if (PENDING_STATES.includes(row.state as ImageGenerationState)) {
        await this.markFailed(
          id,
          "GENERAL_BACKEND_INTERRUPTED",
          "Image generation was interrupted",
        );
        await this.removeUntrackedGenerationFiles(row.botId, row.id);
        if (row.usageReservationId) await this.refund(row.botId, row.usageReservationId);
      }
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
        const operation = await this.pixai.startGeneration(planId, row.idempotencyKey);
        await this.persistStartedOperation(id, planId, operation, row.providerMetadata, row.botId);
        this.scheduleAdvance(id, 0);
      } catch {
        this.logger.warn({ generationId: id }, "Image operation start recovery deferred");
        this.scheduleAdvance(id, 15_000);
      }
      return;
    }
    if (hasPendingCancelIntent(row.providerMetadata)) {
      try {
        const operation = await this.pixai.cancelGeneration(row.providerOperationId);
        const state = normalizeCancelState(operation);
        const [claimed] = await this.db
          .update(imageGenerations)
          .set({
            state,
            providerState: operation.state,
            providerMetadata: { ...row.providerMetadata, cancelRequested: false },
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
            state: "cancel_rejected",
            providerMetadata: { ...row.providerMetadata, cancelRequested: false },
            updatedAt: new Date(),
          })
          .where(and(eq(imageGenerations.id, id), eq(imageGenerations.state, "cancel_requested")));
        await this.recordEvent(row.botId, id, "cancel_resolved", "cancel_rejected");
        this.scheduleAdvance(id, 15_000);
      }
      return;
    }
    try {
      const operation = await this.pixai.waitForGeneration(row.providerOperationId, 10_000);
      const state = normalizeImageOperationState(operation);
      const persistedState = state === "succeeded" ? "running" : state;
      const [observed] = await this.db
        .update(imageGenerations)
        .set({
          state: persistedState,
          providerState: operation.state,
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
      const result = await this.pixai.getGenerationResult(row.providerOperationId);
      const data: PixaiMcpArtifactData[] = result.images.map((image) =>
        this.artifacts.readInline(image),
      );
      for (const link of result.resourceLinks) data.push(await this.artifacts.download(link));
      await this.completeWithArtifacts(row, dedupeArtifacts(data));
    } catch {
      this.logger.warn({ generationId: id }, "Image operation recovery deferred");
      this.scheduleAdvance(id, 15_000);
    }
  }

  private scheduleAdvance(id: string, delayMs: number): void {
    const timer = setTimeout(() => void this.advance(id), delayMs);
    timer.unref?.();
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
        await this.markFailed(id, "GENERAL_BACKEND_FAILED", "General image generation failed");
        if (row.usageReservationId) await this.refund(row.botId, row.usageReservationId);
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
        });
      }
      const [claimed] = await this.db
        .update(imageGenerations)
        .set({
          state: "succeeded",
          artifacts,
          localFiles,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(imageGenerations.id, row.id), inArray(imageGenerations.state, COMPLETABLE_STATES)),
        )
        .returning({ id: imageGenerations.id });
      if (!claimed) {
        await Promise.allSettled(createdFiles.map((filename) => unlink(path.join(dir, filename))));
        return;
      }
      await this.recordEvent(row.botId, row.id, "artifacts_saved", "succeeded", undefined, {
        artifactCount: artifacts.length,
      });
    } catch (error) {
      await Promise.allSettled(createdFiles.map((filename) => unlink(path.join(dir, filename))));
      throw error;
    }
    if (row.usageReservationId) {
      await this.usageGovernor.settle({
        reservationId: row.usageReservationId,
        botId: row.botId,
        resource: "image",
      });
    }
    await this.deliverCompleted({ ...row, localFiles, state: "succeeded" });
  }

  private async deliverCompleted(row: GenerationRow): Promise<void> {
    if (!this.delivery || row.deliveredAt || row.localFiles.length === 0) return;
    const now = new Date();
    const staleBefore = new Date(now.getTime() - DELIVERY_CLAIM_LEASE_MS);
    if (row.deliveryClaimedAt && row.deliveryClaimedAt > staleBefore) {
      this.scheduleAdvance(
        row.id,
        Math.max(1_000, row.deliveryClaimedAt.getTime() + DELIVERY_CLAIM_LEASE_MS - now.getTime()),
      );
      return;
    }
    const [claimed] = await this.db
      .update(imageGenerations)
      .set({ deliveryClaimedAt: now, updatedAt: now })
      .where(
        and(
          eq(imageGenerations.id, row.id),
          eq(imageGenerations.state, "succeeded"),
          isNull(imageGenerations.deliveredAt),
          or(
            isNull(imageGenerations.deliveryClaimedAt),
            lt(imageGenerations.deliveryClaimedAt, staleBefore),
          ),
        ),
      )
      .returning({ id: imageGenerations.id });
    if (!claimed) return;
    await this.recordEvent(row.botId, row.id, "delivery_started", "succeeded");
    let messageIds: number[];
    try {
      messageIds = await this.delivery.deliver({
        generationId: row.id,
        botId: row.botId,
        chatId: row.chatId,
        userId: row.userId,
        prompt: row.prompt,
        presetKey: row.presetKey ?? undefined,
        requestSnapshot: row.requestSnapshot ?? undefined,
        localFiles: row.localFiles,
      });
    } catch (error) {
      await this.db
        .update(imageGenerations)
        .set({ deliveryClaimedAt: null, updatedAt: new Date() })
        .where(and(eq(imageGenerations.id, row.id), isNull(imageGenerations.deliveredAt)));
      await this.recordEvent(row.botId, row.id, "delivery_failed", "succeeded");
      throw error;
    }
    // Persisting Telegram's returned message ids is separate from sending. If this
    // write fails, retain the claim lease so recovery does not immediately duplicate
    // a message that Telegram already accepted.
    await this.db
      .update(imageGenerations)
      .set({ deliveryMessageIds: messageIds, deliveredAt: new Date(), updatedAt: new Date() })
      .where(and(eq(imageGenerations.id, row.id), isNull(imageGenerations.deliveredAt)));
    await this.recordEvent(row.botId, row.id, "delivered", "succeeded", undefined, {
      deliveryMessageCount: messageIds.length,
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
    existingMetadata?: Record<string, unknown> | null,
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
        providerMetadata: { ...existingMetadata, planId, ...sanitizedOperationMetadata(operation) },
        updatedAt: new Date(),
      })
      .where(and(eq(imageGenerations.id, id), inArray(imageGenerations.state, COMPLETABLE_STATES)));
    await this.db
      .update(imageGenerations)
      .set({
        providerOperationId: operation.operationId,
        providerState: operation.state,
        providerMetadata: {
          ...existingMetadata,
          planId,
          ...sanitizedOperationMetadata(operation),
          cancelRequested: true,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(imageGenerations.id, id), eq(imageGenerations.state, "cancel_requested")));
    if (botId) {
      await this.recordEvent(botId, id, "submitted", normalState, operation.state);
      void this.refreshRequestSnapshot(botId, id, operation.operationId);
    }
  }

  private async refreshRequestSnapshot(
    botId: string,
    id: string,
    operationId: string,
  ): Promise<void> {
    const details = await Promise.resolve()
      .then(() => this.pixai.getGenerationDetails(operationId))
      .catch(() => null);
    if (!details) return;
    const row = await this.getRow(id);
    if (!row || row.botId !== botId) return;
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
        providerState,
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
    modelId: firstString("modelId", "model_id") ?? fallback.modelId,
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

function toView(row: GenerationRow): ImageGenerationView {
  return {
    id: row.id,
    purpose: row.purpose as ImageGenerationView["purpose"],
    provider: row.provider as ImageGenerationView["provider"],
    presetKey: row.presetKey ?? undefined,
    state: row.state as ImageGenerationState,
    providerState: row.providerState ?? undefined,
    approval: row.approvalState as ImageGenerationView["approval"],
    artifacts: row.artifacts,
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
  return "cancel_requested";
}

function sanitizedOperationMetadata(operation: PixaiGenerationOperation): Record<string, unknown> {
  return {
    phase: operation.phase,
    terminal: operation.terminal,
    nextAction: operation.nextAction,
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
