import type { Database } from "@cos-tool-bot/database";
import type { ImageGenerationActor } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ImageGenerationService,
  normalizeImageOperationState,
  projectPixaiPreset,
} from "./image-generation-service.js";

const BOT_ID = "00000000-0000-4000-8000-000000000017";
const ACTOR: ImageGenerationActor = {
  botId: BOT_ID,
  chatId: -100,
  userId: 42,
  chatType: "supergroup",
  isBotAdmin: true,
  isDelegatedGroupAdmin: false,
};

function query<T>(limitRows: T[], awaitedRows: unknown[] = limitRows) {
  const builder = Promise.resolve(awaitedRows) as Promise<unknown[]> & {
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  };
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn((_condition?: unknown) => builder);
  builder.orderBy = vi.fn((_order?: unknown) => builder);
  builder.limit = vi.fn(async () => limitRows);
  return builder;
}

function mutation(row: Record<string, unknown>, values: Record<string, unknown>) {
  Object.assign(row, values);
  const mutationPromise = Promise.resolve() as Promise<void> & {
    returning: ReturnType<typeof vi.fn>;
  };
  mutationPromise.returning = vi.fn(async () => [{ id: row.id }]);
  return mutationPromise;
}

function createDependencies() {
  const usageGovernor = {
    reserve: vi.fn().mockResolvedValue({
      allowed: true,
      reservationId: "99e9ca86-72ca-48c2-8606-a7ebfe501ea2",
      reservedUnits: 1,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    }),
    settle: vi.fn().mockResolvedValue("settled"),
    refund: vi.fn().mockResolvedValue("refunded"),
  };
  const pixai = {
    listPresets: vi
      .fn()
      .mockResolvedValue([{ key: "anime-default", label: "Anime", approvalRequired: false }]),
    waitForGeneration: vi.fn(),
    startGeneration: vi.fn(),
    getGenerationDetails: vi.fn(),
  };
  return {
    usageGovernor,
    pixai,
    artifacts: { readInline: vi.fn(), download: vi.fn() },
    logger: { warn: vi.fn() },
  };
}

function generationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "8e75c468-746b-4b9b-850d-17e29d669a3a",
    botId: BOT_ID,
    chatId: -100,
    userId: 42,
    provider: "mcp_pixai",
    purpose: "anime_illustration",
    presetKey: "anime-default",
    idempotencyKey: "request-key",
    providerOperationId: "operation-1",
    state: "cancel_rejected",
    providerState: "running",
    approvalState: "not_required",
    prompt: "draw a cat",
    negativePrompt: null,
    seed: null,
    providerMetadata: null,
    artifacts: [],
    localFiles: [],
    deliveryMessageIds: [],
    usageReservationId: "99e9ca86-72ca-48c2-8606-a7ebfe501ea2",
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    updatedAt: new Date("2026-08-31T00:00:00.000Z"),
    completedAt: null,
    deliveryClaimedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

describe("ImageGenerationService failure accounting", () => {
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
