import type { Database } from "@cos-tool-bot/database";
import { bots, engagementSamples } from "@cos-tool-bot/database";
import type {
  EngagementContextMessage,
  EngagementLabel,
  EngagementPolicy,
  EngagementSample,
} from "@cos-tool-bot/shared";
import { and, count, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Logger } from "pino";
import { redactDiagnostic } from "./run-redaction.js";

export const ENGAGEMENT_CONTEXT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const ENGAGEMENT_INPUT_PRICE_USD_PER_MILLION = 0.042;
export const ENGAGEMENT_PRICING_SOURCE = "typesafe-official-pricing-manual";
export const ENGAGEMENT_PRICING_SOURCE_URL = "https://docs.typesafe.ai/models";
export const ENGAGEMENT_PRICING_OBSERVED_AT = new Date("2026-09-21T00:00:00.000Z");

const MAX_STORED_CONTEXT_MESSAGES = 50;
const MAX_STORED_CONTEXT_TEXT = 6_000;
const MAX_STORED_MESSAGE_TEXT = 2_000;
const MAX_STORED_PRIVACY_USERS_PER_MESSAGE = 50;
const LABELED_CREDENTIAL =
  /\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|cookie|credential)\b(\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const TELEGRAM_BOT_TOKEN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;

export interface EngagementSampleFilters {
  chatId?: number;
  mode?: "off" | "shadow" | "active";
  choice?: "continue" | "join" | "silent";
  engagement?: "answer" | "silent";
  actualTrigger?: string;
  actualOutcome?: "answer" | "silent";
  errorCategory?: string;
  label?: EngagementLabel;
}

export interface EngagementSampleListInput extends EngagementSampleFilters {
  botId: string;
  page: number;
  pageSize: number;
}

function bounded(value: string | undefined | null, maxLength: number): string | null {
  if (!value) return null;
  return value.slice(0, maxLength);
}

function safePolicy(policy: EngagementPolicy): EngagementPolicy {
  return {
    mode: policy.mode,
    style: policy.style,
    preferences: policy.preferences.slice(0, 1_000),
    keywordDirect: policy.keywordDirect,
    cooldownSeconds: policy.cooldownSeconds,
    confidenceThreshold: policy.confidenceThreshold,
    contextMessages: policy.contextMessages,
    timeoutMs: policy.timeoutMs,
  };
}

function safeProbabilities(probabilities: Record<string, number> | null) {
  if (!probabilities) return null;
  return Object.fromEntries(
    Object.entries(probabilities)
      .filter(([key, value]) => key.length > 0 && key.length <= 50 && Number.isFinite(value))
      .slice(0, 10),
  );
}

export function sanitizeEngagementContext(
  context: readonly EngagementContextMessage[],
  secrets: readonly string[] = [],
): EngagementContextMessage[] {
  const retained: EngagementContextMessage[] = [];
  let remaining = MAX_STORED_CONTEXT_TEXT;
  for (const message of context.slice(-MAX_STORED_CONTEXT_MESSAGES).reverse()) {
    if (remaining <= 0) break;
    const privacyUserIds =
      message.privacyUserIds === undefined
        ? undefined
        : [
            ...new Set(
              message.privacyUserIds.filter((userId) => Number.isSafeInteger(userId) && userId > 0),
            ),
          ];
    // Never retain text with only a partial contributor set: doing so would let a
    // contributor outside the stored prefix survive a later privacy-forget purge.
    if (
      privacyUserIds !== undefined &&
      privacyUserIds.length > MAX_STORED_PRIVACY_USERS_PER_MESSAGE
    ) {
      continue;
    }
    const labeled = message.text
      .replace(
        LABELED_CREDENTIAL,
        (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`,
      )
      .replace(TELEGRAM_BOT_TOKEN, "[REDACTED]");
    const redacted = redactDiagnostic(labeled, [...secrets]);
    const text = (typeof redacted === "string" ? redacted : "")
      .slice(0, Math.min(MAX_STORED_MESSAGE_TEXT, remaining))
      .trim();
    if (!text) continue;
    retained.push({
      messageId: message.messageId,
      userId: message.userId,
      text,
      timestamp: message.timestamp,
      ...(message.isBot === undefined ? {} : { isBot: message.isBot }),
      ...(message.privacyCapturedAt === undefined
        ? {}
        : { privacyCapturedAt: message.privacyCapturedAt }),
      ...(privacyUserIds === undefined ? {} : { privacyUserIds }),
    });
    remaining -= text.length;
  }
  return retained.reverse();
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type EngagementSampleRow = typeof engagementSamples.$inferSelect;

export function projectEngagementSampleRow(row: EngagementSampleRow, now: Date) {
  const expired = row.contextExpiresAt.getTime() <= now.getTime();
  return {
    ...row,
    context: expired ? null : row.context,
    contextExpiresAt: row.contextExpiresAt.toISOString(),
    contextPurgedAt: row.contextPurgedAt?.toISOString() ?? null,
    pricingObservedAt: row.pricingObservedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export class EngagementSampleService {
  constructor(
    private readonly db: Database,
    private readonly now = () => new Date(),
  ) {}

  async persist(
    botId: string,
    sample: EngagementSample,
    secrets: readonly string[] = [],
  ): Promise<void> {
    const now = this.now();
    const inputTokens =
      sample.inputTokens !== null &&
      Number.isSafeInteger(sample.inputTokens) &&
      sample.inputTokens >= 0
        ? sample.inputTokens
        : null;
    const estimatedCostUsd =
      inputTokens === null
        ? null
        : sample.estimatedCostUsd !== null &&
            Number.isFinite(sample.estimatedCostUsd) &&
            sample.estimatedCostUsd >= 0
          ? sample.estimatedCostUsd
          : (inputTokens / 1_000_000) * ENGAGEMENT_INPUT_PRICE_USD_PER_MILLION;

    await this.db.insert(engagementSamples).values({
      botId,
      chatId: sample.chatId,
      messageId: sample.messageId,
      source: sample.probabilities !== null ? "jev" : sample.errorCategory ? "jev_error" : "local",
      mode: sample.mode,
      style: sample.style,
      choice: sample.choice,
      engagement: sample.engagement,
      confidence:
        sample.confidence !== null && Number.isFinite(sample.confidence)
          ? Math.max(0, Math.min(1, sample.confidence))
          : null,
      probabilities: safeProbabilities(sample.probabilities),
      reasonCode: bounded(sample.reasonCode, 100) ?? "unknown",
      actualTrigger: bounded(sample.actualTrigger, 100),
      model: bounded(sample.model, 100) ?? "unknown",
      configVersion: bounded(sample.configVersion, 100) ?? "unknown",
      configSnapshot: safePolicy(sample.configSnapshot),
      latencyMs: Math.max(0, Math.round(sample.latencyMs)),
      inputTokens,
      estimatedCostUsd,
      inputPriceUsdPerMillion: ENGAGEMENT_INPUT_PRICE_USD_PER_MILLION,
      pricingSource: ENGAGEMENT_PRICING_SOURCE,
      pricingSourceUrl: ENGAGEMENT_PRICING_SOURCE_URL,
      pricingObservedAt: ENGAGEMENT_PRICING_OBSERVED_AT,
      context: sanitizeEngagementContext(sample.context, secrets),
      contextExpiresAt: new Date(now.getTime() + ENGAGEMENT_CONTEXT_RETENTION_MS),
      errorCategory: bounded(sample.errorCategory, 100),
      createdAt: now,
    });
  }

  async list(input: EngagementSampleListInput) {
    const now = this.now();
    const [bot] = await this.db
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.id, input.botId))
      .limit(1);
    if (!bot) return null;
    await this.cleanupExpiredContext(now);
    const where = and(...this.conditions(input));
    const offset = (input.page - 1) * input.pageSize;
    const [rows, [metrics]] = await Promise.all([
      this.db
        .select()
        .from(engagementSamples)
        .where(where)
        .orderBy(desc(engagementSamples.createdAt), desc(engagementSamples.id))
        .limit(input.pageSize)
        .offset(offset),
      this.db
        .select({
          total: count(),
          labeledCount:
            sql<number>`(count(*) filter (where ${engagementSamples.label} is not null))::int`.mapWith(
              Number,
            ),
          evaluatedCount:
            sql<number>`(count(*) filter (where ${engagementSamples.source} = 'jev' and ${engagementSamples.label} in ('answer', 'silent')))::int`.mapWith(
              Number,
            ),
          labelAnswerCount:
            sql<number>`(count(*) filter (where ${engagementSamples.source} = 'jev' and ${engagementSamples.label} = 'answer'))::int`.mapWith(
              Number,
            ),
          labelSilentCount:
            sql<number>`(count(*) filter (where ${engagementSamples.source} = 'jev' and ${engagementSamples.label} = 'silent'))::int`.mapWith(
              Number,
            ),
          falsePositiveCount:
            sql<number>`(count(*) filter (where ${engagementSamples.source} = 'jev' and ${engagementSamples.engagement} = 'answer' and ${engagementSamples.label} = 'silent'))::int`.mapWith(
              Number,
            ),
          falseNegativeCount:
            sql<number>`(count(*) filter (where ${engagementSamples.source} = 'jev' and ${engagementSamples.engagement} = 'silent' and ${engagementSamples.label} = 'answer'))::int`.mapWith(
              Number,
            ),
          latencyP50Ms: sql<
            number | null
          >`percentile_cont(0.5) within group (order by ${engagementSamples.latencyMs}) filter (where ${engagementSamples.source} <> 'local')`.mapWith(
            Number,
          ),
          latencyP95Ms: sql<
            number | null
          >`percentile_cont(0.95) within group (order by ${engagementSamples.latencyMs}) filter (where ${engagementSamples.source} <> 'local')`.mapWith(
            Number,
          ),
          classifierCostUsd:
            sql<number>`coalesce(sum(${engagementSamples.estimatedCostUsd}) filter (where ${engagementSamples.source} <> 'local'), 0)::double precision`.mapWith(
              Number,
            ),
          classifierCostKnownCount:
            sql<number>`(count(${engagementSamples.estimatedCostUsd}) filter (where ${engagementSamples.source} <> 'local'))::int`.mapWith(
              Number,
            ),
          classifierCostUnknownCount:
            sql<number>`(count(*) filter (where ${engagementSamples.source} <> 'local' and ${engagementSamples.estimatedCostUsd} is null))::int`.mapWith(
              Number,
            ),
          inputTokens:
            sql<number>`coalesce(sum(${engagementSamples.inputTokens}) filter (where ${engagementSamples.source} <> 'local'), 0)::double precision`.mapWith(
              Number,
            ),
        })
        .from(engagementSamples)
        .where(where),
    ]);

    const total = toNumber(metrics?.total);
    const labeledCount = toNumber(metrics?.labeledCount);
    const evaluatedCount = toNumber(metrics?.evaluatedCount);
    const labelAnswerCount = toNumber(metrics?.labelAnswerCount);
    const labelSilentCount = toNumber(metrics?.labelSilentCount);
    const falsePositiveCount = toNumber(metrics?.falsePositiveCount);
    const falseNegativeCount = toNumber(metrics?.falseNegativeCount);
    return {
      items: rows.map((row) => projectEngagementSampleRow(row, now)),
      total,
      page: input.page,
      pageSize: input.pageSize,
      metrics: {
        total,
        labeledCount,
        evaluatedCount,
        labelAnswerCount,
        labelSilentCount,
        falsePositiveCount,
        falseNegativeCount,
        falsePositiveRate: labelSilentCount === 0 ? null : falsePositiveCount / labelSilentCount,
        falseNegativeRate: labelAnswerCount === 0 ? null : falseNegativeCount / labelAnswerCount,
        latencyP50Ms: nullableNumber(metrics?.latencyP50Ms),
        latencyP95Ms: nullableNumber(metrics?.latencyP95Ms),
        classifierCostUsd: toNumber(metrics?.classifierCostUsd),
        classifierCostKnownCount: toNumber(metrics?.classifierCostKnownCount),
        classifierCostUnknownCount: toNumber(metrics?.classifierCostUnknownCount),
        inputTokens: toNumber(metrics?.inputTokens),
        actorCostStatus: "unpriced" as const,
        actorCostReason: "Token usage records do not contain model pricing",
        actorUsagePath: `/api/usage/summary?botId=${encodeURIComponent(input.botId)}`,
      },
    };
  }

  async updateLabel(botId: string, sampleId: number, label: EngagementLabel) {
    const [row] = await this.db
      .update(engagementSamples)
      .set({ label })
      .where(and(eq(engagementSamples.botId, botId), eq(engagementSamples.id, sampleId)))
      .returning();
    return row ? projectEngagementSampleRow(row, this.now()) : null;
  }

  async cleanupExpiredContext(now = this.now()): Promise<void> {
    await this.db
      .update(engagementSamples)
      .set({ context: null, contextPurgedAt: now })
      .where(
        and(lte(engagementSamples.contextExpiresAt, now), isNotNull(engagementSamples.context)),
      );
  }

  private conditions(input: EngagementSampleFilters & { botId: string }): SQL[] {
    const conditions: SQL[] = [eq(engagementSamples.botId, input.botId)];
    if (input.chatId !== undefined) conditions.push(eq(engagementSamples.chatId, input.chatId));
    if (input.mode) conditions.push(eq(engagementSamples.mode, input.mode));
    if (input.choice) conditions.push(eq(engagementSamples.choice, input.choice));
    if (input.engagement) conditions.push(eq(engagementSamples.engagement, input.engagement));
    if (input.actualOutcome)
      conditions.push(
        input.actualOutcome === "answer"
          ? isNotNull(engagementSamples.actualTrigger)
          : isNull(engagementSamples.actualTrigger),
      );
    if (input.actualTrigger)
      conditions.push(eq(engagementSamples.actualTrigger, input.actualTrigger));
    if (input.errorCategory)
      conditions.push(eq(engagementSamples.errorCategory, input.errorCategory));
    if (input.label) conditions.push(eq(engagementSamples.label, input.label));
    return conditions;
  }
}

export class EngagementSampleCleaner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cleanupInFlight: Promise<void> | null = null;

  constructor(
    private readonly service: Pick<EngagementSampleService, "cleanupExpiredContext">,
    private readonly logger: Logger,
    private readonly intervalMs = 60 * 60 * 1_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getHandle(): ReturnType<typeof setInterval> | null {
    return this.timer;
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    const cleanup = this.service
      .cleanupExpiredContext()
      .catch((error) => {
        this.logger.error(error, "Engagement sample context cleanup failed");
      })
      .finally(() => {
        if (this.cleanupInFlight === cleanup) this.cleanupInFlight = null;
      });
    this.cleanupInFlight = cleanup;
    return cleanup;
  }
}
