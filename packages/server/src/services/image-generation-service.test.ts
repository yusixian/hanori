import type { Database } from "@cos-tool-bot/database";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_GOVERNANCE_CONFIG,
  extractImageGenerationRequestSnapshot,
  ImageGenerationService,
  normalizeImageOperationState,
  projectPixaiPreset,
} from "./image-generation-service.js";
import {
  ACTOR,
  BOT_ID,
  createDependencies,
  generationRow,
  query,
} from "./image-generation-service-test-fakes.js";

describe("extractImageGenerationRequestSnapshot", () => {
  it("preserves trusted material snapshots instead of replacing them with provider metadata", () => {
    const materials = {
      originalPrompt: "draw",
      safetyMode: "safe" as const,
      characters: [],
      assets: [{ id: 1, name: "style", content: "watercolor", version: "v1" }],
    };
    expect(
      extractImageGenerationRequestSnapshot(
        { materials: { assets: [] }, width: 1024 },
        { materials },
      ),
    ).toEqual({ materials, width: 1024 });
  });
  it("extracts stable parameters from nested MCP request details", () => {
    expect(
      extractImageGenerationRequestSnapshot({
        generation: {
          providerRequest: {
            body: {
              modelVersionId: "model-version-1",
              width: 1536,
              height: 912,
              batchSize: 2,
              samplingSteps: 28,
              cfgScale: 6.5,
              sampler: "Euler a",
              promptHelper: false,
            },
          },
        },
      }),
    ).toEqual({
      modelVersionId: "model-version-1",
      width: 1536,
      height: 912,
      batchSize: 2,
      samplingSteps: 28,
      cfgScale: 6.5,
      sampler: "Euler a",
      promptHelper: false,
    });
  });

  it("keeps the local fallback when MCP details omit a field", () => {
    expect(
      extractImageGenerationRequestSnapshot(
        { request: { width: 1024 } },
        {
          presetKey: "wallpaper",
          height: 768,
        },
      ),
    ).toEqual({ presetKey: "wallpaper", width: 1024, height: 768 });
  });
});

describe("generation library admission", () => {
  it("fails before reserving or submitting when material resolution fails", async () => {
    const deps = createDependencies();
    const insert = vi.fn();
    const resolveMaterials = vi.fn().mockRejectedValue(new Error("private character"));
    const service = new ImageGenerationService({
      db: { select: () => query([]), insert } as unknown as Database,
      ...deps,
      generationLibrary: { resolveMaterials },
    } as unknown as ConstructorParameters<typeof ImageGenerationService>[0]);
    await expect(
      service.create(ACTOR, {
        purpose: "anime_illustration",
        prompt: "draw",
        materials: { characterIds: [1] },
      }),
    ).resolves.toMatchObject({ accepted: false, reason: "invalid_request" });
    expect(resolveMaterials).toHaveBeenCalledWith(
      { botId: BOT_ID, source: "telegram", telegramUserId: 42, isAdmin: true },
      "draw",
      { characterIds: [1] },
    );
    expect(insert).not.toHaveBeenCalled();
    expect(deps.usageGovernor.reserve).not.toHaveBeenCalled();
  });

  it("allows an explicit library bypass and persists the ordinary prompt", async () => {
    const deps = createDependencies();
    const values = vi.fn().mockRejectedValue(new Error("stop after admission"));
    const resolveMaterials = vi.fn().mockRejectedValue(new Error("unavailable"));
    const service = new ImageGenerationService({
      db: { select: () => query([]), insert: () => ({ values }) } as unknown as Database,
      ...deps,
      generationLibrary: { resolveMaterials },
    } as unknown as ConstructorParameters<typeof ImageGenerationService>[0]);
    await service.create(ACTOR, {
      purpose: "anime_illustration",
      prompt: "draw",
      materials: { skipLibrary: true },
    });
    expect(resolveMaterials).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "draw", requestSnapshot: { presetKey: "anime-default" } }),
    );
  });

  it("stores the compiled prompt and immutable material snapshot before provider submission", async () => {
    const deps = createDependencies();
    const values = vi.fn().mockRejectedValue(new Error("stop after admission"));
    const snapshot = {
      originalPrompt: "draw",
      safetyMode: "safe",
      characters: [],
      assets: [{ id: 1, name: "style", content: "watercolor", version: "v1" }],
    };
    const resolveMaterials = vi.fn().mockResolvedValue({ prompt: "draw\nwatercolor", snapshot });
    const service = new ImageGenerationService({
      db: { select: () => query([]), insert: () => ({ values }) } as unknown as Database,
      ...deps,
      generationLibrary: { resolveMaterials },
    } as unknown as ConstructorParameters<typeof ImageGenerationService>[0]);
    await service.create(ACTOR, { purpose: "anime_illustration", prompt: "draw" });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "draw\nwatercolor",
        requestSnapshot: { presetKey: "anime-default", materials: snapshot },
      }),
    );
  });
});

function mutation(row: Record<string, unknown>, values: Record<string, unknown>) {
  Object.assign(row, values);
  const mutationPromise = Promise.resolve() as Promise<void> & {
    returning: ReturnType<typeof vi.fn>;
  };
  mutationPromise.returning = vi.fn(async () => [{ id: row.id }]);
  return mutationPromise;
}

function generalImageConfig() {
  const config = structuredClone(DEFAULT_IMAGE_GOVERNANCE_CONFIG);
  config.generalRouteMode = "semantic_auto";
  const route = config.routes.find((candidate) => candidate.purpose === "general_image")!;
  route.enabled = true;
  return config;
}

describe("ImageGenerationService failure accounting", () => {
  it("marks an unconfigured general backend unavailable without discovering presets", async () => {
    const dependencies = createDependencies();
    const config = generalImageConfig();
    const generalBackend = { isConfigured: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const db = { select: vi.fn(() => query([{ config }])) } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      generalBackend,
      logger: dependencies.logger as never,
    });

    await expect(service.listRoutes(ACTOR, { includePresets: false })).resolves.toEqual([
      expect.objectContaining({ purpose: "anime_illustration", enabled: true, presets: [] }),
      expect.objectContaining({ purpose: "general_image", enabled: false, presets: [] }),
    ]);
    expect(generalBackend.isConfigured).toHaveBeenCalledWith(BOT_ID);
    expect(dependencies.pixai.listPresets).not.toHaveBeenCalled();
  });

  it("only lists the general preset when its route and backend are available", async () => {
    const dependencies = createDependencies();
    const config = generalImageConfig();
    const generalBackend = { isConfigured: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const db = { select: vi.fn(() => query([{ config }])) } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      generalBackend,
      logger: dependencies.logger as never,
    });

    await expect(service.listPresets(ACTOR, "general_image")).resolves.toEqual([]);
    generalBackend.isConfigured.mockResolvedValue(true);
    await expect(service.listPresets(ACTOR, "general_image")).resolves.toEqual([
      expect.objectContaining({ key: "general-default", provider: "general_backend" }),
    ]);

    config.routes.find((candidate) => candidate.purpose === "general_image")!.enabled = false;
    generalBackend.isConfigured.mockClear();
    await expect(service.listPresets(ACTOR, "general_image")).resolves.toEqual([]);
    expect(generalBackend.isConfigured).not.toHaveBeenCalled();
  });

  it("rejects general image creation when the Bot backend is not configured", async () => {
    const dependencies = createDependencies();
    const config = generalImageConfig();
    const generalBackend = { isConfigured: vi.fn().mockResolvedValue(false), create: vi.fn() };
    const db = { select: vi.fn(() => query([{ config }])) } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      generalBackend,
      logger: dependencies.logger as never,
    });

    await expect(
      service.create(ACTOR, {
        purpose: "general_image",
        routingIntent: "explicit",
        prompt: "a lighthouse",
      }),
    ).resolves.toEqual({ accepted: false, reason: "disabled" });
    expect(dependencies.usageGovernor.reserve).not.toHaveBeenCalled();
    expect(generalBackend.create).not.toHaveBeenCalled();
  });

  it("denies private-chat image generation for an ordinary user by default", async () => {
    const dependencies = createDependencies();
    const db = { select: vi.fn(() => query([])) } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await expect(
      service.create(
        { ...ACTOR, chatId: 42, chatType: "private", isBotAdmin: false },
        {
          purpose: "anime_illustration",
          routingIntent: "semantic",
          prompt: "draw a cat",
        },
      ),
    ).resolves.toEqual({ accepted: false, reason: "not_allowed" });

    expect(dependencies.pixai.listPresets).not.toHaveBeenCalled();
    expect(dependencies.usageGovernor.reserve).not.toHaveBeenCalled();
  });

  it("admits an explicitly authorized private-chat user to the normal quota path", async () => {
    const dependencies = createDependencies();
    const config = { ...DEFAULT_IMAGE_GOVERNANCE_CONFIG, privateChatUserIds: [42] };
    const db = {
      select: vi.fn(() => query([{ config }])),
      insert: vi.fn(() => ({
        values: vi.fn().mockRejectedValue(new Error("database unavailable")),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await expect(
      service.create(
        { ...ACTOR, chatId: 42, chatType: "private", isBotAdmin: false },
        {
          purpose: "anime_illustration",
          routingIntent: "semantic",
          prompt: "draw a cat",
        },
      ),
    ).resolves.toEqual({ accepted: false, reason: "provider_unavailable" });

    expect(dependencies.usageGovernor.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: BOT_ID,
        resource: "image",
        chatKind: "private",
        chatId: 42,
        userId: 42,
      }),
    );
  });

  it("treats saved governance configs from before private grants as an empty allowlist", async () => {
    const dependencies = createDependencies();
    const legacyConfig = { ...DEFAULT_IMAGE_GOVERNANCE_CONFIG } as Record<string, unknown>;
    delete legacyConfig.privateChatUserIds;
    const db = {
      select: vi.fn(() => query([{ config: legacyConfig }])),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await expect(service.getConfig(BOT_ID)).resolves.toMatchObject({ privateChatUserIds: [] });
  });

  it("restores full generation provenance for any user in the delivery chat", async () => {
    const dependencies = createDependencies();
    const row = generationRow({
      userId: 7,
      prompt: "hakurei_reimu, shrine",
      negativePrompt: "low quality",
      seed: 42,
      deliveryMessageIds: [7389, 7390],
      providerMetadata: { planId: "plan-1" },
      deliveredAt: new Date("2026-09-01T01:00:00.000Z"),
    });
    dependencies.pixai.getGenerationDetails.mockResolvedValue({
      requestBody: { samplingSteps: 28 },
    });
    const db = { select: vi.fn(() => query([row])) } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });
    const viewer = { ...ACTOR, userId: 99, isBotAdmin: false };

    await expect(service.findByDeliveryMessage(viewer, 7390)).resolves.toMatchObject({
      creatorUserId: 7,
      prompt: "hakurei_reimu, shrine",
      negativePrompt: "low quality",
      seed: 42,
      providerOperationId: "operation-1",
      artifactOrdinal: 1,
      providerDetails: { requestBody: { samplingSteps: 28 } },
    });
    expect(dependencies.pixai.getGenerationDetails).toHaveBeenCalledWith("operation-1");
  });

  it("reports a sanitized MCP capability failure before reserving image usage", async () => {
    const dependencies = createDependencies();
    dependencies.pixai.listPresets.mockRejectedValue(
      Object.assign(new Error("secret upstream detail"), { code: "AUTHORIZATION_REQUIRED" }),
    );
    const db = {
      select: vi.fn(() => query([])),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
      isGroupEnabled: async () => true,
    });

    await expect(
      service.create(
        { ...ACTOR, isBotAdmin: false },
        {
          purpose: "anime_illustration",
          routingIntent: "semantic",
          prompt: "draw a cat",
        },
      ),
    ).resolves.toEqual({ accepted: false, reason: "provider_unavailable" });

    expect(dependencies.usageGovernor.reserve).not.toHaveBeenCalled();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      { code: "AUTHORIZATION_REQUIRED" },
      "PixAI MCP preset discovery failed",
    );
  });

  it("refunds the image reservation when the durable generation insert fails", async () => {
    const dependencies = createDependencies();
    const db = {
      select: vi.fn((projection?: Record<string, unknown>) =>
        query(projection && "config" in projection ? [] : []),
      ),
      insert: vi.fn(() => ({
        values: vi.fn().mockRejectedValue(new Error("database unavailable")),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
      isGroupEnabled: async () => true,
    });

    await expect(
      service.create(
        { ...ACTOR, isBotAdmin: false },
        {
          purpose: "anime_illustration",
          routingIntent: "semantic",
          prompt: "draw a cat",
        },
      ),
    ).resolves.toEqual({ accepted: false, reason: "provider_unavailable" });

    expect(dependencies.usageGovernor.refund).toHaveBeenCalledWith({
      reservationId: "99e9ca86-72ca-48c2-8606-a7ebfe501ea2",
      botId: BOT_ID,
      resource: "image",
    });
  });

  it("lets Bot administrators bypass image usage limits", async () => {
    const dependencies = createDependencies();
    const db = {
      select: vi.fn(() => query([])),
      insert: vi.fn(() => ({
        values: vi.fn().mockRejectedValue(new Error("database unavailable")),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await expect(
      service.create(ACTOR, {
        purpose: "anime_illustration",
        routingIntent: "semantic",
        prompt: "draw a cat",
      }),
    ).resolves.toEqual({ accepted: false, reason: "provider_unavailable" });

    expect(dependencies.usageGovernor.reserve).not.toHaveBeenCalled();
    expect(dependencies.usageGovernor.refund).not.toHaveBeenCalled();
  });

  it("keeps cancel_rejected operations in recovery and refunds when recovery confirms failure", async () => {
    const dependencies = createDependencies();
    const row = generationRow();
    const recoveryWhere = vi.fn();
    dependencies.pixai.waitForGeneration.mockResolvedValue({
      operationId: "operation-1",
      state: "failed",
      terminal: true,
    });
    const db = {
      select: vi.fn((projection?: Record<string, unknown>) => {
        if (projection && "id" in projection) {
          const builder = query([{ id: row.id }]);
          builder.where = vi.fn((condition?: unknown) => {
            recoveryWhere(condition);
            return builder;
          });
          return builder;
        }
        return query([row]);
      }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => mutation(row, values)),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await service.recoverPending();

    expect(recoveryWhere).toHaveBeenCalledOnce();
    expect(deepContains(recoveryWhere.mock.calls[0]?.[0], "cancel_rejected")).toBe(true);
    expect(dependencies.pixai.waitForGeneration).toHaveBeenCalledWith("operation-1", 10_000);
    expect(dependencies.usageGovernor.refund).toHaveBeenCalledWith({
      reservationId: row.usageReservationId,
      botId: BOT_ID,
      resource: "image",
    });
  });

  it("stops a general-backend wait locally and refunds its reservation", async () => {
    const dependencies = createDependencies();
    const row = generationRow({
      provider: "general_backend",
      providerOperationId: null,
      purpose: "general_image",
      state: "running",
    });
    const db = {
      select: vi.fn(() => query([row])),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => mutation(row, values)),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await expect(service.cancel(ACTOR, row.id)).resolves.toMatchObject({
      ok: true,
      generation: { state: "waiting_stopped" },
    });
    expect(dependencies.usageGovernor.refund).toHaveBeenCalledWith({
      reservationId: row.usageReservationId,
      botId: BOT_ID,
      resource: "image",
    });
  });

  it("recovers a prepared MCP operation with the original idempotency key", async () => {
    const dependencies = createDependencies();
    const row = generationRow({
      providerOperationId: null,
      state: "preparing",
      providerMetadata: { planId: "plan-1" },
    });
    dependencies.pixai.startGeneration.mockResolvedValue({
      operationId: "operation-recovered",
      state: "queued",
    });
    const db = {
      select: vi.fn((projection?: Record<string, unknown>) =>
        projection && "id" in projection ? query([{ id: row.id }]) : query([row]),
      ),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => mutation(row, values)),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await service.recoverPending();

    expect(dependencies.pixai.startGeneration).toHaveBeenCalledWith("plan-1", "request-key");
    expect(row).toMatchObject({
      providerOperationId: "operation-recovered",
      state: "queued",
    });
    expect(dependencies.usageGovernor.refund).not.toHaveBeenCalled();
  });

  it("fails and refunds an interrupted general-backend request during restart recovery", async () => {
    const dependencies = createDependencies();
    const row = generationRow({
      provider: "general_backend",
      providerOperationId: null,
      purpose: "general_image",
      state: "running",
    });
    const db = {
      select: vi.fn((projection?: Record<string, unknown>) =>
        projection && "id" in projection ? query([{ id: row.id }]) : query([row]),
      ),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => mutation(row, values)),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await service.recoverPending();

    expect(row).toMatchObject({ state: "failed", errorCode: "GENERAL_BACKEND_INTERRUPTED" });
    expect(dependencies.usageGovernor.refund).toHaveBeenCalledWith({
      reservationId: row.usageReservationId,
      botId: BOT_ID,
      resource: "image",
    });
  });

  it("keeps a durable cancel intent when an accepted MCP start has not been persisted yet", async () => {
    const dependencies = createDependencies();
    const row = generationRow({
      providerOperationId: null,
      state: "preparing",
      providerMetadata: { planId: "plan-1" },
    });
    dependencies.pixai.startGeneration.mockRejectedValue(new Error("connection lost"));
    const db = {
      select: vi.fn(() => query([row])),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => mutation(row, values)),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await expect(service.cancel(ACTOR, row.id)).resolves.toMatchObject({
      ok: true,
      generation: { state: "cancel_requested" },
    });

    expect(row.providerMetadata).toMatchObject({ planId: "plan-1", cancelRequested: true });
    expect(dependencies.usageGovernor.refund).not.toHaveBeenCalled();
  });

  it("preserves a concurrent cancel claim while persisting an accepted MCP operation", async () => {
    const dependencies = createDependencies();
    const metadata = { planId: "plan-1", cancelRequested: true };
    const row = generationRow({
      providerOperationId: null,
      state: "cancel_requested",
      providerMetadata: metadata,
    });
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn((condition: unknown) => {
            if (row.state === "cancel_requested" && deepContains(condition, "cancel_requested")) {
              Object.assign(row, values);
            }
            return Promise.resolve();
          }),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      logger: dependencies.logger as never,
    });

    await (
      service as unknown as {
        persistStartedOperation: (
          id: string,
          planId: string,
          operation: { operationId: string; state: string },
          metadata: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).persistStartedOperation(
      row.id,
      "plan-1",
      { operationId: "operation-after-cancel", state: "queued" },
      metadata,
    );

    expect(row).toMatchObject({
      state: "cancel_requested",
      providerOperationId: "operation-after-cancel",
      providerMetadata: { planId: "plan-1", cancelRequested: true },
    });
  });

  it("does not start a general backend after cancellation wins the preparing claim", async () => {
    const dependencies = createDependencies();
    const row = generationRow({
      provider: "general_backend",
      providerOperationId: null,
      purpose: "general_image",
      state: "waiting_stopped",
    });
    const generalBackend = { create: vi.fn() };
    const db = {
      select: vi.fn(() => query([row])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      generalBackend,
      logger: dependencies.logger as never,
    });

    await (
      service as unknown as {
        runGeneral: (id: string) => Promise<void>;
      }
    ).runGeneral(row.id);

    expect(generalBackend.create).not.toHaveBeenCalled();
    expect(row.state).toBe("waiting_stopped");
  });

  it("does not settle or deliver when cancellation wins the terminal state claim", async () => {
    const dependencies = createDependencies();
    const delivery = { deliver: vi.fn() };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
        })),
      })),
    } as unknown as Database;
    const service = new ImageGenerationService({
      db,
      usageGovernor: dependencies.usageGovernor as never,
      pixai: dependencies.pixai as never,
      artifacts: dependencies.artifacts as never,
      delivery,
      logger: dependencies.logger as never,
    });

    await (
      service as unknown as {
        completeWithArtifacts: (
          row: ReturnType<typeof generationRow>,
          data: Array<{ bytes: Uint8Array; mimeType: string; source: "inline" }>,
        ) => Promise<void>;
      }
    ).completeWithArtifacts(generationRow({ state: "waiting_stopped" }), [
      { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png", source: "inline" },
    ]);

    expect(dependencies.usageGovernor.settle).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
  });
});

describe("normalizeImageOperationState", () => {
  it.each([
    [
      "partial result",
      { state: "partial_failure", nextAction: { type: "get_result" } },
      "succeeded",
    ],
    [
      "approval",
      { state: "awaiting_approval", nextAction: { type: "approve_in_panel" } },
      "awaiting_approval",
    ],
    [
      "unknown submission",
      { state: "submission_unknown", nextAction: { type: "review_in_panel" } },
      "attention_required",
    ],
    ["rejected", { state: "rejected", terminal: true, nextAction: { type: "none" } }, "failed"],
  ] as const)("maps %s using the MCP experience contract", (_label, operation, expected) => {
    expect(
      normalizeImageOperationState({
        operationId: "operation-1",
        value: {},
        ...operation,
      }),
    ).toBe(expected);
  });
});

describe("projectPixaiPreset", () => {
  it("projects the current MCP preset name and nested auto-approval eligibility", () => {
    expect(
      projectPixaiPreset({
        key: "daily-anime",
        name: "Daily anime",
        description: "Trusted daily preset",
        autoApproval: { enabled: true, eligible: true, remainingUses: 3 },
      }),
    ).toEqual({
      key: "daily-anime",
      label: "Daily anime",
      description: "Trusted daily preset",
      provider: "mcp_pixai",
      autoApproved: true,
    });
  });
});

function deepContains(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => deepContains(child, expected, seen));
}
