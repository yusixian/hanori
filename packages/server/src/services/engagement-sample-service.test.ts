import type { Database } from "@cos-tool-bot/database";
import type { EngagementSample } from "@cos-tool-bot/shared";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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
  addressedConfidenceThreshold: 0.8,
  continueConfidenceThreshold: 0.8,
  continuationWindowSeconds: 120,
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
    participation: { choice: "join", confidence: 0.86 },
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
  it("preserves both independent decision distributions without normalizing them together", async () => {
    const values = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const service = new EngagementSampleService({
      insert: () => ({ values }),
    } as unknown as Database);
    const probabilities = { answer: 0.95, silent: 0.05, addressed: 0.1, continue: 0.5, join: 0.4 };
    await service.persist("00000000-0000-4000-8000-000000000001", sample({ probabilities }));
    expect(values.mock.calls[0]![0]).toMatchObject({
      probabilities,
      participation: { choice: "join", confidence: 0.86 },
      source: "jev",
    });
  });

  it("rejects malformed raw participation metadata instead of inferring or clamping it", async () => {
    const values = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const service = new EngagementSampleService({
      insert: () => ({ values }),
    } as unknown as Database);

    await service.persist(
      "00000000-0000-4000-8000-000000000001",
      sample({ participation: { choice: "join", confidence: 1.2 } }),
    );

    expect(values.mock.calls[0]![0]).toMatchObject({ participation: null });
  });

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

  it("applies unreviewed and inclusive time filters to full-result metrics", async () => {
    let selectCall = 0;
    let listWhere: SQL | undefined;
    let metricsWhere: SQL | undefined;
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: () => ({ where: () => ({ limit: async () => [{ id: "bot-a" }] }) }),
          };
        }
        if (selectCall === 2) {
          return {
            from: () => ({
              where: (expression: SQL) => {
                listWhere = expression;
                return {
                  orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
                };
              },
            }),
          };
        }
        return {
          from: () => ({
            where: async (expression: SQL) => {
              metricsWhere = expression;
              return [
                {
                  total: 8,
                  labeledCount: 0,
                  evaluatedCount: 3,
                  labelAnswerCount: 2,
                  labelSilentCount: 1,
                  falsePositiveCount: 1,
                  falseNegativeCount: 1,
                  latencyP50Ms: 50,
                  latencyP95Ms: 95,
                  classifierCostUsd: 0.2,
                  classifierCostKnownCount: 6,
                  classifierCostUnknownCount: 2,
                  errorCount: 4,
                  timeoutCount: 3,
                  inputTokens: 100,
                  twoStageSampleCount: 5,
                  twoStageLabeledCount: 2,
                  twoStageEvaluatedCount: 2,
                  twoStageLabelAnswerCount: 1,
                  twoStageLabelSilentCount: 1,
                  twoStageFalsePositiveCount: 0,
                  twoStageFalseNegativeCount: 1,
                  legacySampleCount: 3,
                  legacyLabeledCount: 1,
                  legacyEvaluatedCount: 1,
                  legacyLabelAnswerCount: 0,
                  legacyLabelSilentCount: 1,
                  legacyFalsePositiveCount: 1,
                  legacyFalseNegativeCount: 0,
                },
              ];
            },
          }),
        };
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as unknown as Database;
    const service = new EngagementSampleService(db);
    const createdFrom = new Date("2026-09-20T00:00:00.000Z");
    const createdTo = new Date("2026-09-21T00:00:00.000Z");

    const result = await service.list({
      botId: "bot-a",
      page: 1,
      pageSize: 20,
      label: "unreviewed",
      configVersion: "config-v1",
      decisionFormat: "two_stage",
      createdFrom,
      createdTo,
    });

    expect(result?.metrics).toMatchObject({ total: 8, errorCount: 4, timeoutCount: 3 });
    expect(result?.metrics.evaluationByFormat).toEqual({
      twoStage: {
        sampleCount: 5,
        labeledCount: 2,
        evaluatedCount: 2,
        labelAnswerCount: 1,
        labelSilentCount: 1,
        falsePositiveCount: 0,
        falseNegativeCount: 1,
        falsePositiveRate: 0,
        falseNegativeRate: 1,
      },
      legacy: {
        sampleCount: 3,
        labeledCount: 1,
        evaluatedCount: 1,
        labelAnswerCount: 0,
        labelSilentCount: 1,
        falsePositiveCount: 1,
        falseNegativeCount: 0,
        falsePositiveRate: 1,
        falseNegativeRate: null,
      },
    });
    const dialect = new PgDialect();
    const listQuery = dialect.sqlToQuery(listWhere!);
    const metricsQuery = dialect.sqlToQuery(metricsWhere!);
    expect(listQuery.sql).toContain('"engagement_samples"."label" is null');
    expect(listQuery.sql).toContain('"engagement_samples"."created_at" >=');
    expect(listQuery.sql).toContain('"engagement_samples"."created_at" <=');
    expect(listQuery.sql).toContain('"engagement_samples"."config_version" =');
    expect(listQuery.sql).toContain(
      `"engagement_samples"."probabilities" ->> 'answer' is not null`,
    );
    expect(listQuery.params).toEqual([
      "bot-a",
      "config-v1",
      createdFrom.toISOString(),
      createdTo.toISOString(),
    ]);
    expect(metricsQuery).toEqual(listQuery);
  });

  it("updates only rows that match both the bot scope and requested ids", async () => {
    let whereExpression: SQL | undefined;
    const returning = vi.fn(async () => [{ id: 3 }, { id: 8 }]);
    const where = vi.fn((expression: SQL) => {
      whereExpression = expression;
      return { returning };
    });
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Database;
    const service = new EngagementSampleService(db);

    const result = await service.updateLabels("bot-a", [3, 8, 99], null);

    expect(set).toHaveBeenCalledWith({ label: null });
    expect(result).toEqual({ ids: [3, 8], count: 2 });
    const compiled = new PgDialect().sqlToQuery(whereExpression!);
    expect(compiled.sql).toContain('"engagement_samples"."bot_id" = $1');
    expect(compiled.sql).toContain('"engagement_samples"."id" in ($2, $3, $4)');
    expect(compiled.params).toEqual(["bot-a", 3, 8, 99]);
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
    expect(projected.participation).toBeNull();
  });
});
