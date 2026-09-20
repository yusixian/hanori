import type { Database } from "@cos-tool-bot/database";
import type { EngagementSample } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ENGAGEMENT_INPUT_PRICE_USD_PER_MILLION,
  ENGAGEMENT_PRICING_SOURCE_URL,
  EngagementSampleService,
  projectEngagementSampleRow,
  sanitizeEngagementContext,
} from "./engagement-sample-service.js";

const POLICY = {
  mode: "shadow" as const,
  style: "natural" as const,
  preferences: "join art discussions",
  keywordDirect: false,
  cooldownSeconds: 60,
  confidenceThreshold: 0.8,
  contextMessages: 20,
  timeoutMs: 1_000,
};

function sample(overrides: Partial<EngagementSample> = {}): EngagementSample {
  return {
    chatId: -100,
    messageId: 42,
    mode: "shadow",
    style: "natural",
    choice: "join",
    engagement: "answer",
    confidence: 0.9,
    probabilities: { continue: 0.05, join: 0.9, silent: 0.05 },
    reasonCode: "model_choice",
    actualTrigger: null,
    model: "jev-1.13.0",
    configVersion: "config-v1",
    configSnapshot: POLICY,
    latencyMs: 123,
    inputTokens: 1_000,
    estimatedCostUsd: null,
    context: [
      {
        messageId: 42,
        userId: 7,
        text: "Authorization: Bearer abc.def",
        timestamp: 1,
        privacyUserIds: [7, 8, 7],
      },
    ],
    ...overrides,
  };
}

describe("EngagementSampleService persistence", () => {
  it("stores a redacted bounded context and immutable pricing snapshot without credentials", async () => {
    const values = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const db = { insert: () => ({ values }) } as unknown as Database;
    const now = new Date("2026-09-21T12:00:00.000Z");
    const service = new EngagementSampleService(db, () => now);
    const configSnapshot = { ...POLICY, apiKey: "must-not-persist" } as typeof POLICY;

    await service.persist("00000000-0000-4000-8000-000000000001", sample({ configSnapshot }));

    const stored = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.source).toBe("jev");
    expect(stored.estimatedCostUsd).toBe(
      (1_000 / 1_000_000) * ENGAGEMENT_INPUT_PRICE_USD_PER_MILLION,
    );
    expect(stored.inputPriceUsdPerMillion).toBe(ENGAGEMENT_INPUT_PRICE_USD_PER_MILLION);
    expect(stored.pricingSourceUrl).toBe(ENGAGEMENT_PRICING_SOURCE_URL);
    expect(stored.contextExpiresAt).toEqual(new Date("2026-09-28T12:00:00.000Z"));
    expect(stored.context).toEqual([expect.objectContaining({ privacyUserIds: [7, 8] })]);
    expect(JSON.stringify(stored)).not.toContain("abc.def");
    expect(JSON.stringify(stored.configSnapshot)).not.toContain("must-not-persist");
  });

  it("marks deterministic bypass samples as local so metrics can exclude them", async () => {
    const values = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const service = new EngagementSampleService({
      insert: () => ({ values }),
    } as unknown as Database);

    await service.persist(
      "00000000-0000-4000-8000-000000000001",
      sample({ probabilities: null, confidence: null, inputTokens: 0, estimatedCostUsd: 0 }),
    );

    expect(values.mock.calls[0]![0]).toMatchObject({ source: "local" });
  });

  it("does not query samples outside a missing bot scope", async () => {
    const limit = vi.fn(async () => []);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      update: vi.fn(),
    } as unknown as Database;
    const service = new EngagementSampleService(db);

    const result = await service.list({ botId: "missing", page: 1, pageSize: 20 });

    expect(result).toBeNull();
    expect(limit).toHaveBeenCalledOnce();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("engagement context retention", () => {
  it("keeps only the newest bounded context while redacting bearer credentials", () => {
    const knownSecret = "known-provider-secret";
    const context = Array.from({ length: 60 }, (_, index) => ({
      messageId: index + 1,
      userId: 7,
      text:
        index === 59
          ? `api_key=plain-secret token: another-secret 123456789:abcdefghijklmnopqrstuvwxyzABCDEFG known=${knownSecret}`
          : "x".repeat(500),
      timestamp: index,
    }));

    const sanitized = sanitizeEngagementContext(context, [knownSecret]);

    expect(sanitized.at(-1)?.messageId).toBe(60);
    expect(sanitized.length).toBeLessThanOrEqual(50);
    expect(sanitized.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(
      6_000,
    );
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("plain-secret");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFG");
    expect(serialized).not.toContain(knownSecret);
  });

  it("preserves complete contributor provenance and drops text when it cannot", () => {
    const fiftyContributors = Array.from({ length: 50 }, (_, index) => index + 1);
    const fiftyOneContributors = Array.from({ length: 51 }, (_, index) => index + 101);

    const sanitized = sanitizeEngagementContext([
      {
        messageId: 1,
        userId: 1,
        text: "safe to retain",
        timestamp: 200,
        privacyCapturedAt: 100,
        privacyUserIds: [...fiftyContributors, 1],
      },
      {
        messageId: 2,
        userId: 101,
        text: "must be dropped as a whole",
        timestamp: 201,
        privacyCapturedAt: 101,
        privacyUserIds: fiftyOneContributors,
      },
    ]);

    expect(sanitized).toEqual([
      expect.objectContaining({
        messageId: 1,
        privacyCapturedAt: 100,
        privacyUserIds: fiftyContributors,
      }),
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("must be dropped as a whole");
  });

  it("hides expired plaintext on read even before the cleanup sweep commits", () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    const projected = projectEngagementSampleRow(
      {
        id: 1,
        context: sample().context,
        contextExpiresAt: new Date("2026-09-21T11:59:59.000Z"),
        contextPurgedAt: null,
        pricingObservedAt: new Date("2026-09-21T00:00:00.000Z"),
        createdAt: new Date("2026-09-20T00:00:00.000Z"),
      } as never,
      now,
    );

    expect(projected.context).toBeNull();
  });
});
