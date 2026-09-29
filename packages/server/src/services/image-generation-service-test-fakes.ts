import type { ImageGenerationActor } from "@cos-tool-bot/shared";
import { vi, type Mock } from "vitest";

export const BOT_ID = "00000000-0000-4000-8000-000000000017";
export const ACTOR: ImageGenerationActor = {
  botId: BOT_ID,
  chatId: -100,
  userId: 42,
  chatType: "supergroup",
  isBotAdmin: true,
  isDelegatedGroupAdmin: false,
};

export function query<T>(limitRows: T[], awaitedRows: unknown[] = limitRows) {
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

export function createDependencies(): {
  usageGovernor: Record<"reserve" | "settle" | "refund", Mock>;
  pixai: Record<
    "listPresets" | "waitForGeneration" | "startGeneration" | "getGenerationDetails",
    Mock
  >;
  artifacts: Record<"readInline" | "download", Mock>;
  logger: Record<"warn", Mock>;
} {
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

export function generationRow(overrides: Record<string, unknown> = {}) {
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
