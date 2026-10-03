import { randomUUID } from "node:crypto";
import { mediaTranscriptionJobs as jobs, type Database } from "@cos-tool-bot/database";
import {
  parseBilibiliResource,
  pageTranscript,
  type MediaJobActor,
  type MediaJobStage,
  type MediaJobView,
  type MediaTranscriptionPort,
  type TranscriptDocument,
} from "@cos-tool-bot/shared";
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { MediaJobConfiguration, MediaJobDependencies, MediaJobRow } from "./contracts.js";

export class MediaJobError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "not_found"
      | "configuration_required"
      | "subtitles_available"
      | "duration_limit"
      | "quota_exceeded"
      | "not_ready"
      | "job_failed"
      | "invalid_source"
      | "interrupted"
      | "interrupted_transcription"
      | "provider_cancellation_unavailable"
      | "expired",
  ) {
    super(code);
    this.name = "MediaJobError";
  }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const running = ["downloading", "converting", "transcribing"] as const;
const terminal = new Set(["completed", "failed", "cancelled", "expired"]);
const progress = { downloading: 10, converting: 40, transcribing: 70 } as const;
const leaseMs = 90_000;
const retentionMs = 24 * 60 * 60 * 1000;
const confirmationMs = 15 * 60 * 1000;

function authorize(actor: MediaJobActor) {
  if (
    !actor.isAdmin ||
    !uuid.test(actor.botId) ||
    !Number.isSafeInteger(actor.chatId) ||
    actor.chatId === 0 ||
    !Number.isSafeInteger(actor.userId) ||
    actor.userId < 1 ||
    (actor.threadId !== undefined && (!Number.isSafeInteger(actor.threadId) || actor.threadId < 1))
  )
    throw new MediaJobError("forbidden");
}
function validConfiguration(value: MediaJobConfiguration | null): value is MediaJobConfiguration {
  if (
    !value ||
    !value.asr ||
    !value.limits ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.installationRevision) ||
    value.installationRevision < 1
  )
    return false;
  const limits = value.limits;
  return (
    typeof value.asr.model === "string" &&
    value.asr.model.trim().length > 0 &&
    value.asr.model.length <= 200 &&
    typeof value.asr.apiKey === "string" &&
    (value.asr.provider === "tencent"
      ? Boolean(value.asr.secretId?.trim() && value.asr.secretKey?.trim())
      : value.asr.apiKey.length > 0) &&
    typeof value.asr.baseUrl === "string" &&
    value.asr.baseUrl.length > 0 &&
    Number.isSafeInteger(limits.maxDurationSeconds) &&
    limits.maxDurationSeconds >= 1 &&
    Number.isSafeInteger(limits.dailyJobs) &&
    limits.dailyJobs >= 1 &&
    Number.isSafeInteger(limits.dailyMinutes) &&
    limits.dailyMinutes >= 1 &&
    Number.isFinite(limits.costPerMinute) &&
    limits.costPerMinute >= 0 &&
    (limits.costPerMinute > 0 || value.asr.provider === "groq") &&
    Number.isFinite(limits.maxDailyCost) &&
    limits.maxDailyCost > 0 &&
    [
      limits.maxPerJobCost,
      limits.maxMonthlyCost,
      limits.botMaxMonthlyCost,
      limits.accountDailyCost,
      limits.accountMonthlyCost,
    ].every((limit) => limit === undefined || (Number.isFinite(limit) && limit >= 0)) &&
    [limits.monthlyMinutes, limits.botMonthlyMinutes, limits.accountMonthlyMinutes].every(
      (limit) => limit === undefined || (Number.isSafeInteger(limit) && limit >= 1),
    )
  );
}
function matches(row: MediaJobRow, config: MediaJobConfiguration) {
  return (
    row.configRevision === config.revision &&
    row.installationRevision === config.installationRevision &&
    row.providerModel === config.asr.model &&
    row.providerAccount === (config.providerAccount ?? "legacy") &&
    row.providerRevision === (config.providerRevision ?? 1)
  );
}
function view(row: MediaJobRow): MediaJobView {
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    title: row.title,
    ...(row.threadId === null ? {} : { threadId: row.threadId }),
    ...(row.confirmation ? { confirmation: row.confirmation } : {}),
    cancelRequested: row.cancelRequested,
    part: row.part,
    durationSeconds: row.durationSeconds,
    status: row.status,
    progress: row.progress,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    language: row.result?.language ?? null,
    source: "asr",
    notification: row.notification,
  };
}
function normalizedResult(value: TranscriptDocument): TranscriptDocument {
  if (value?.source !== "asr") throw new MediaJobError("job_failed");
  try {
    pageTranscript(value, { limit: 1 });
    const result: TranscriptDocument = {
      language: value.language ?? null,
      source: "asr",
      track: value.track ?? "original",
      cues: value.cues.map((cue) => ({
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        ...(cue.uncertain === undefined ? {} : { uncertain: cue.uncertain }),
        ...(cue.timingInferred === undefined ? {} : { timingInferred: cue.timingInferred }),
      })),
    };
    if (JSON.stringify(result).length > 500_000) throw new MediaJobError("job_failed");
    return result;
  } catch {
    throw new MediaJobError("job_failed");
  }
}
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const signal =
    timeoutMs === undefined ? parent : AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation(signal);
      })
      .then((value) => {
        if (signal.aborted) abort();
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Durable reservations precede execution; transcribing leases are never retried automatically. */
export class MediaJobService implements MediaTranscriptionPort {
  private readonly shutdown = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private active: { row: MediaJobRow; controller: AbortController } | undefined;
  private started = false;
  private stopped = false;
  private nextSweep = 0;
  constructor(
    private readonly db: Database,
    private readonly deps: MediaJobDependencies,
  ) {}

  private async configuration(botId: string, providerAccount?: string) {
    let config: MediaJobConfiguration | null;
    try {
      config = await this.deps.configuration(botId, providerAccount);
    } catch {
      throw new MediaJobError("configuration_required");
    }
    if (!validConfiguration(config)) throw new MediaJobError("configuration_required");
    return config;
  }
  private async owned(actor: MediaJobActor, id: string) {
    authorize(actor);
    if (!uuid.test(id)) throw new MediaJobError("not_found");
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.botId, actor.botId),
          eq(jobs.chatId, actor.chatId),
          eq(jobs.userId, actor.userId),
        ),
      );
    if (!row) throw new MediaJobError("not_found");
    if (row.threadId !== (actor.threadId ?? null)) throw new MediaJobError("not_found");
    return row;
  }
  private async authorizeAdmin(actor: MediaJobActor) {
    authorize(actor);
    if (this.deps.authorize && !(await this.deps.authorize(actor)))
      throw new MediaJobError("forbidden");
  }
  private async preferredConfiguration(botId: string, durationSeconds = 0) {
    if (!this.deps.configurations) return this.configuration(botId);
    const candidates = (await this.deps.configurations(botId)).filter(validConfiguration);
    if (!candidates.length) return this.configuration(botId);
    const now = new Date();
    for (const candidate of candidates) {
      const allowance = candidate.freeAllowanceMinutes ?? 0;
      if (allowance <= 0 || candidate.freeAllowancePeriod === "none") continue;
      const since = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          candidate.freeAllowancePeriod === "day" ? now.getUTCDate() : 1,
        ),
      );
      const [usage] = await this.db
        .select({
          seconds: sql<number>`coalesce(sum(${jobs.durationSeconds}),0)::double precision`,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.providerAccount, candidate.providerAccount ?? "legacy"),
            sql`coalesce(${jobs.confirmedAt},${jobs.createdAt}) >= ${since.toISOString()}::timestamp`,
            inArray(jobs.status, [
              "pending_confirmation",
              "queued",
              ...running,
              "completed",
              "failed",
            ]),
          ),
        );
      // This is only our ledger: the confirmation still discloses unknown external account usage.
      if ((usage?.seconds ?? 0) + durationSeconds <= allowance * 60) return candidate;
    }
    return candidates[0]!;
  }
  async create(
    actor: MediaJobActor,
    input: { sourceUrl: string; forceAsr?: boolean },
    callerSignal?: AbortSignal,
  ): Promise<MediaJobView> {
    await this.authorizeAdmin(actor);
    if (this.stopped) throw new MediaJobError("not_ready");
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.shutdown.signal])
      : this.shutdown.signal;
    const assertActive = () => {
      if (signal.aborted) throw new MediaJobError("interrupted");
    };
    assertActive();
    try {
      parseBilibiliResource(input.sourceUrl);
    } catch {
      throw new MediaJobError("invalid_source");
    }
    let config = await this.preferredConfiguration(actor.botId);
    let resource;
    try {
      resource = await bounded(
        (signal) => this.deps.inspect(input.sourceUrl, config, signal),
        signal,
        15_000,
      );
    } catch {
      assertActive();
      throw new MediaJobError("invalid_source");
    }
    assertActive();
    try {
      const parsed = parseBilibiliResource(resource.canonicalUrl);
      if (
        parsed.kind !== "canonical" ||
        parsed.idType !== "bv" ||
        parsed.id !== resource.bvid ||
        parsed.part !== resource.part ||
        parsed.canonicalUrl !== resource.canonicalUrl ||
        typeof resource.title !== "string" ||
        resource.title.length > 500 ||
        typeof resource.hasSubtitles !== "boolean"
      )
        throw new Error();
    } catch {
      throw new MediaJobError("invalid_source");
    }
    if (resource.hasSubtitles && input.forceAsr !== true)
      throw new MediaJobError("subtitles_available");
    if (
      !Number.isSafeInteger(resource.durationSeconds) ||
      resource.durationSeconds < 1 ||
      resource.durationSeconds > 2_147_483_647 // PostgreSQL duration_seconds is an int4.
    )
      throw new MediaJobError("duration_limit");
    config = await this.preferredConfiguration(actor.botId, resource.durationSeconds);
    if (resource.durationSeconds > config.limits.maxDurationSeconds)
      throw new MediaJobError("duration_limit");
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const billedSeconds =
      config.asr.provider === "groq"
        ? Math.max(10, resource.durationSeconds)
        : resource.durationSeconds;
    const expectedCost = (billedSeconds / 60) * config.limits.costPerMinute;
    // PCM may differ from platform metadata by two seconds. Reserve that tolerance before upload.
    const maximumSeconds =
      config.asr.provider === "groq"
        ? Math.max(10, resource.durationSeconds + 2)
        : resource.durationSeconds + 2;
    const estimatedCost =
      config.limits.maxPerJobCost === undefined
        ? expectedCost
        : (maximumSeconds / 60) * config.limits.costPerMinute * 1.1;
    // Each reservation must remain positive and representable in numeric(20,12).
    // This protects storage arithmetic without limiting the owner's configured budget.
    if (
      !Number.isFinite(estimatedCost) ||
      (config.limits.costPerMinute > 0 && estimatedCost <= 0) ||
      (estimatedCost > 0 && estimatedCost < 0.5e-12) ||
      estimatedCost >= 1e8
    )
      throw new MediaJobError("configuration_required");
    if (estimatedCost > (config.limits.maxPerJobCost ?? Infinity))
      throw new MediaJobError("quota_exceeded");
    const reservation = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.botId}:${actor.userId}:${day.toISOString()}`}, 0))`,
      );
      // One account's monthly budget is shared across all Bots and administrators.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asr:${config.providerAccount ?? actor.botId}`}, 0))`,
      );
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('asr-accounts'))`);
      const current = await this.configuration(actor.botId, config.providerAccount);
      if (
        current.revision !== config.revision ||
        current.installationRevision !== config.installationRevision ||
        current.asr.model !== config.asr.model ||
        current.providerRevision !== config.providerRevision
      )
        throw new MediaJobError("configuration_required");
      assertActive();
      const [duplicate] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.botId, actor.botId),
            eq(jobs.chatId, actor.chatId),
            eq(jobs.userId, actor.userId),
            sql`${jobs.threadId} IS NOT DISTINCT FROM ${actor.threadId ?? null}`,
            eq(jobs.bvid, resource.bvid),
            eq(jobs.part, resource.part),
            eq(jobs.configRevision, config.revision),
            eq(jobs.installationRevision, config.installationRevision),
            eq(jobs.providerModel, config.asr.model),
            eq(jobs.providerAccount, config.providerAccount ?? "legacy"),
            eq(jobs.providerRevision, config.providerRevision ?? 1),
            eq(jobs.forceAsr, input.forceAsr === true),
            inArray(jobs.status, ["pending_confirmation", "queued", ...running, "completed"]),
            gt(jobs.expiresAt, now),
            sql`(${jobs.status} <> 'pending_confirmation' OR (${jobs.confirmation}->>'expiresAt')::timestamptz > ${now.toISOString()}::timestamptz)`,
          ),
        )
        .limit(1);
      if (duplicate) return { row: duplicate, created: false };
      const [usage] = await tx
        .select({
          count: sql<number>`count(*)::integer`,
          seconds: sql<number>`coalesce(sum(${jobs.durationSeconds}),0)::double precision`,
          // Aggregate decimal reservations before converting to a number at budget edges.
          cost: sql<number>`coalesce(sum(CASE WHEN coalesce(${jobs.confirmation}->>'currency','USD') = ${config.currency ?? "USD"} THEN ${jobs.estimatedCost}::numeric ELSE 0 END),0)::double precision`,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.botId, actor.botId),
            eq(jobs.userId, actor.userId),
            sql`coalesce(${jobs.confirmedAt},${jobs.createdAt}) >= ${day.toISOString()}::timestamp`,
            inArray(jobs.status, [
              "pending_confirmation",
              "queued",
              ...running,
              "completed",
              "failed",
            ]),
          ),
        );
      if (
        !usage ||
        !Number.isSafeInteger(usage.count) ||
        usage.count < 0 ||
        !Number.isSafeInteger(usage.seconds) ||
        usage.seconds < 0 ||
        !Number.isFinite(usage.cost) ||
        usage.cost < 0 ||
        usage.count >= config.limits.dailyJobs ||
        BigInt(usage.seconds) + BigInt(resource.durationSeconds) >
          BigInt(config.limits.dailyMinutes) * 60n
      )
        throw new MediaJobError("quota_exceeded");
      const totalCost = usage.cost + estimatedCost;
      // Preserve tolerance for numeric(20,12) reservation quantization at exact budget edges.
      if (!Number.isFinite(totalCost) || totalCost > config.limits.maxDailyCost + 1e-8)
        throw new MediaJobError("quota_exceeded");
      await this.checkMonthlyBudget(tx, actor, config, resource.durationSeconds, estimatedCost);
      assertActive();
      const [saved] = await tx
        .insert(jobs)
        .values({
          botId: actor.botId,
          chatId: actor.chatId,
          userId: actor.userId,
          threadId: actor.threadId ?? null,
          providerAccount: config.providerAccount ?? "legacy",
          providerRevision: config.providerRevision ?? 1,
          forceAsr: input.forceAsr === true,
          status: "pending_confirmation",
          confirmation: {
            provider: config.asr.provider ?? "openai",
            model: config.asr.model,
            currency: config.currency ?? "USD",
            estimatedCost: expectedCost,
            maxCost: estimatedCost,
            freeQuota:
              config.freeQuota ??
              "免费额度未核实，账户剩余额度未知 / Free quota unverified; account balance unknown",
            expiresAt: new Date(now.getTime() + confirmationMs).toISOString(),
          },
          configRevision: config.revision,
          installationRevision: config.installationRevision,
          sourceUrl: resource.canonicalUrl,
          bvid: resource.bvid,
          part: resource.part,
          title: resource.title,
          durationSeconds: resource.durationSeconds,
          providerModel: config.asr.model,
          estimatedCost,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + retentionMs),
        })
        .returning();
      return { row: saved!, created: true };
    });
    if (signal.aborted) {
      if (reservation.created) await this.cancel(actor, reservation.row.id);
      throw new MediaJobError("interrupted");
    }
    if (reservation.row.status === "pending_confirmation") {
      try {
        if (!this.deps.requestConfirmation) throw new Error("confirmation_unavailable");
        await this.deps.requestConfirmation(view(reservation.row), actor);
      } catch {
        if (reservation.created) await this.cancel(actor, reservation.row.id);
        throw new MediaJobError("not_ready");
      }
    }
    return view(reservation.row);
  }
  private async checkMonthlyBudget(
    db: Pick<Database, "select">,
    actor: MediaJobActor,
    config: MediaJobConfiguration,
    seconds: number,
    cost: number,
    excludeId?: string,
  ) {
    if (
      [
        config.limits.maxMonthlyCost,
        config.limits.monthlyMinutes,
        config.limits.botMonthlyMinutes,
        config.limits.botMaxMonthlyCost,
        config.limits.accountDailyCost,
        config.limits.accountMonthlyCost,
        config.limits.accountMonthlyMinutes,
      ].every((value) => value === undefined)
    )
      return;
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const currency = config.currency ?? "USD";
    const account = config.providerAccount ?? "legacy";
    const [usage] = await db
      .select({
        seconds: sql<number>`coalesce(sum(CASE WHEN ${jobs.providerAccount} = ${account} THEN ${jobs.durationSeconds} ELSE 0 END),0)::double precision`,
        cost: sql<number>`coalesce(sum(CASE WHEN ${jobs.providerAccount} = ${account} AND coalesce(${jobs.confirmation}->>'currency','USD') = ${currency} THEN ${jobs.estimatedCost}::numeric ELSE 0 END),0)::double precision`,
        dailyCost: sql<number>`coalesce(sum(CASE WHEN ${jobs.providerAccount} = ${account} AND coalesce(${jobs.confirmation}->>'currency','USD') = ${currency} AND coalesce(${jobs.confirmedAt},${jobs.createdAt}) >= ${day.toISOString()}::timestamp THEN ${jobs.estimatedCost}::numeric ELSE 0 END),0)::double precision`,
        userSeconds: sql<number>`coalesce(sum(CASE WHEN ${jobs.botId} = ${actor.botId} AND ${jobs.userId} = ${actor.userId} THEN ${jobs.durationSeconds} ELSE 0 END),0)::double precision`,
        userCost: sql<number>`coalesce(sum(CASE WHEN ${jobs.botId} = ${actor.botId} AND ${jobs.userId} = ${actor.userId} AND coalesce(${jobs.confirmation}->>'currency','USD') = ${currency} THEN ${jobs.estimatedCost}::numeric ELSE 0 END),0)::double precision`,
        botSeconds: sql<number>`coalesce(sum(CASE WHEN ${jobs.botId} = ${actor.botId} THEN ${jobs.durationSeconds} ELSE 0 END),0)::double precision`,
        botCost: sql<number>`coalesce(sum(CASE WHEN ${jobs.botId} = ${actor.botId} AND coalesce(${jobs.confirmation}->>'currency','USD') = ${currency} THEN ${jobs.estimatedCost}::numeric ELSE 0 END),0)::double precision`,
      })
      .from(jobs)
      .where(
        and(
          sql`(${jobs.providerAccount} = ${account} OR ${jobs.botId} = ${actor.botId})`,
          sql`coalesce(${jobs.confirmedAt},${jobs.createdAt}) >= ${month.toISOString()}::timestamp`,
          inArray(jobs.status, [
            "pending_confirmation",
            "queued",
            ...running,
            "completed",
            "failed",
          ]),
          excludeId ? sql`${jobs.id} <> ${excludeId}` : undefined,
        ),
      );
    const limits = config.limits;
    if (
      !usage ||
      Object.values(usage).some((value) => !Number.isFinite(value) || value < 0) ||
      usage.cost + cost > (limits.accountMonthlyCost ?? Infinity) + 1e-8 ||
      usage.dailyCost + cost > (limits.accountDailyCost ?? Infinity) + 1e-8 ||
      usage.seconds + seconds > (limits.accountMonthlyMinutes ?? Infinity) * 60 ||
      usage.userCost + cost > (limits.maxMonthlyCost ?? Infinity) + 1e-8 ||
      usage.userSeconds + seconds > (limits.monthlyMinutes ?? Infinity) * 60 ||
      usage.botSeconds + seconds > (limits.botMonthlyMinutes ?? Infinity) * 60 ||
      usage.botCost + cost > (limits.botMaxMonthlyCost ?? Infinity) + 1e-8
    )
      throw new MediaJobError("quota_exceeded");
  }
  async confirm(actor: MediaJobActor, id: string): Promise<MediaJobView> {
    await this.authorizeAdmin(actor);
    if (this.stopped) throw new MediaJobError("not_ready");
    const original = await this.owned(actor, id);
    if (original.status !== "pending_confirmation") {
      if (original.status === "expired") throw new MediaJobError("expired");
      return view(original);
    }
    const deadline = Date.parse(original.confirmation?.expiresAt ?? "");
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      await this.db
        .update(jobs)
        .set({ status: "expired", updatedAt: new Date() })
        .where(and(eq(jobs.id, id), eq(jobs.status, "pending_confirmation")));
      throw new MediaJobError("expired");
    }
    const config = await this.configuration(actor.botId, original.providerAccount);
    if (!matches(original, config)) throw new MediaJobError("configuration_required");
    const resource = await bounded(
      (signal) => this.deps.inspect(original.sourceUrl, config, signal),
      this.shutdown.signal,
      15_000,
    );
    if (resource.hasSubtitles && !original.forceAsr) throw new MediaJobError("subtitles_available");
    if (
      resource.canonicalUrl !== original.sourceUrl ||
      resource.part !== original.part ||
      resource.bvid !== original.bvid ||
      resource.durationSeconds !== original.durationSeconds ||
      resource.durationSeconds > config.limits.maxDurationSeconds
    )
      throw new MediaJobError("duration_limit");
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.botId}:${actor.userId}:${day.toISOString()}`}, 0))`,
      );
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asr:${config.providerAccount ?? actor.botId}`}, 0))`,
      );
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('asr-accounts'))`);
      const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).for("update");
      if (!row) throw new MediaJobError("not_found");
      if (row.status !== "pending_confirmation") {
        if (row.status === "expired") throw new MediaJobError("expired");
        return view(row);
      }
      if (Date.parse(row.confirmation?.expiresAt ?? "") <= Date.now())
        throw new MediaJobError("expired");
      const current = await this.configuration(actor.botId, row.providerAccount);
      if (!matches(row, current)) throw new MediaJobError("configuration_required");
      await this.authorizeAdmin(actor);
      const [usage] = await tx
        .select({
          count: sql<number>`count(*)::integer`,
          seconds: sql<number>`coalesce(sum(${jobs.durationSeconds}),0)::double precision`,
          cost: sql<number>`coalesce(sum(CASE WHEN coalesce(${jobs.confirmation}->>'currency','USD') = ${config.currency ?? "USD"} THEN ${jobs.estimatedCost}::numeric ELSE 0 END),0)::double precision`,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.botId, actor.botId),
            eq(jobs.userId, actor.userId),
            sql`coalesce(${jobs.confirmedAt},${jobs.createdAt}) >= ${day.toISOString()}::timestamp`,
            sql`${jobs.id} <> ${id}`,
            inArray(jobs.status, [
              "pending_confirmation",
              "queued",
              ...running,
              "completed",
              "failed",
            ]),
          ),
        );
      if (
        !usage ||
        usage.count >= current.limits.dailyJobs ||
        usage.seconds + row.durationSeconds > current.limits.dailyMinutes * 60 ||
        usage.cost + row.estimatedCost > current.limits.maxDailyCost + 1e-8 ||
        row.estimatedCost > (current.limits.maxPerJobCost ?? Infinity)
      )
        throw new MediaJobError("quota_exceeded");
      await this.checkMonthlyBudget(tx, actor, current, row.durationSeconds, row.estimatedCost, id);
      const [saved] = await tx
        .update(jobs)
        .set({
          status: "queued",
          confirmedAt: now,
          expiresAt: new Date(now.getTime() + retentionMs),
          updatedAt: now,
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "pending_confirmation")))
        .returning();
      return view(saved!);
    });
  }
  async get(actor: MediaJobActor, id: string) {
    return view(await this.owned(actor, id));
  }
  async read(actor: MediaJobActor, id: string): Promise<TranscriptDocument> {
    const row = await this.owned(actor, id);
    if (row.status === "failed" || row.status === "cancelled")
      throw new MediaJobError("job_failed");
    if (row.status !== "completed" || !row.result || row.expiresAt.getTime() <= Date.now())
      throw new MediaJobError("not_ready");
    const config = await this.configuration(actor.botId, row.providerAccount);
    if (!matches(row, config)) throw new MediaJobError("not_ready");
    return row.result;
  }
  async cancel(actor: MediaJobActor, id: string) {
    const row = await this.owned(actor, id);
    if (terminal.has(row.status)) return view(row);
    const [saved] = await this.db
      .update(jobs)
      .set({
        cancelRequested: true,
        status: sql`CASE WHEN ${jobs.status}='queued' AND ${jobs.providerSubmittedAt} IS NOT NULL THEN 'failed' WHEN ${jobs.status} IN ('pending_confirmation','queued') THEN 'cancelled' ELSE ${jobs.status} END`,
        error: sql`CASE WHEN ${jobs.status}='queued' AND ${jobs.providerSubmittedAt} IS NOT NULL THEN 'provider_cancellation_unavailable' ELSE ${jobs.error} END`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(jobs.id, id), inArray(jobs.status, ["pending_confirmation", "queued", ...running])),
      )
      .returning();
    if (this.active?.row.id === id) this.active.controller.abort(new MediaJobError("interrupted"));
    return view(saved ?? (await this.owned(actor, id)));
  }
  private async ownerActor(botId: string, id: string): Promise<MediaJobActor> {
    if (!uuid.test(botId) || !uuid.test(id)) throw new MediaJobError("not_found");
    const [row] = await this.db
      .select({ chatId: jobs.chatId, userId: jobs.userId, threadId: jobs.threadId })
      .from(jobs)
      .where(and(eq(jobs.botId, botId), eq(jobs.id, id)));
    if (!row) throw new MediaJobError("not_found");
    return {
      botId,
      chatId: row.chatId,
      userId: row.userId,
      isAdmin: true,
      ...(row.threadId === null ? {} : { threadId: row.threadId }),
    };
  }
  // These methods are exposed only by the server's owner/admin routes.
  async listForBot(botId: string): Promise<MediaJobView[]> {
    if (!uuid.test(botId)) throw new MediaJobError("not_found");
    const rows = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.botId, botId))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(50);
    return rows.map(view);
  }
  async getForOwner(botId: string, id: string): Promise<MediaJobView> {
    return this.get(await this.ownerActor(botId, id), id);
  }
  async cancelForOwner(botId: string, id: string): Promise<MediaJobView> {
    return this.cancel(await this.ownerActor(botId, id), id);
  }
  async readForOwner(botId: string, id: string): Promise<TranscriptDocument> {
    return this.read(await this.ownerActor(botId, id), id);
  }
  async cancelForBot(botId?: string) {
    if (botId !== undefined && !uuid.test(botId)) return;
    await this.db
      .update(jobs)
      .set({
        cancelRequested: true,
        updatedAt: new Date(),
        status: sql`CASE WHEN ${jobs.status}='queued' AND ${jobs.providerSubmittedAt} IS NOT NULL THEN 'failed' WHEN ${jobs.status} IN ('pending_confirmation','queued') THEN 'cancelled' ELSE ${jobs.status} END`,
        error: sql`CASE WHEN ${jobs.status}='queued' AND ${jobs.providerSubmittedAt} IS NOT NULL THEN 'provider_cancellation_unavailable' ELSE ${jobs.error} END`,
      })
      .where(
        and(
          botId === undefined ? undefined : eq(jobs.botId, botId),
          inArray(jobs.status, ["pending_confirmation", "queued", ...running]),
        ),
      );
    if (this.active && (botId === undefined || this.active.row.botId === botId))
      this.active.controller.abort(new MediaJobError("configuration_required"));
  }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.recover(true);
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 1000);
    this.timer.unref();
    void this.tick().catch(() => undefined);
  }
  async close() {
    this.stopped = true;
    this.shutdown.abort(new MediaJobError("interrupted"));
    if (this.timer) clearInterval(this.timer);
    this.active?.controller.abort(new MediaJobError("interrupted"));
    await this.ticking;
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.runTick().finally(() => {
      if (this.ticking === task) this.ticking = undefined;
    });
    this.ticking = task;
    return task;
  }
  private async recover(restarting = false) {
    const now = new Date();
    if (now.getTime() >= this.nextSweep) {
      await this.deps.sweep?.();
      this.nextSweep = now.getTime() + 60_000;
    }
    await this.db
      .update(jobs)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(jobs.status, "pending_confirmation"),
          sql`(${jobs.confirmation} IS NULL OR (${jobs.confirmation}->>'expiresAt')::timestamptz <= ${now.toISOString()}::timestamptz)`,
        ),
      );
    if (restarting)
      await this.db
        .update(jobs)
        .set({ notification: "failed", updatedAt: now })
        .where(eq(jobs.notification, "delivering"));
    const expired = await this.db
      .select()
      .from(jobs)
      .where(and(inArray(jobs.status, running), lt(jobs.leaseExpiresAt, now)));
    for (const row of expired) {
      await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, row.id),
              eq(jobs.leaseId, row.leaseId!),
              lt(jobs.leaseExpiresAt, now),
              inArray(jobs.status, running),
            ),
          )
          .for("update", { skipLocked: true });
        if (!locked) return;
        // Keep the expired row unclaimable until its previous temporary files are gone.
        const cleaned = await this.performCleanup(row.id, locked.attempt);
        const canResume =
          locked.status === "transcribing" &&
          locked.providerTaskId &&
          locked.providerSubmittedAt &&
          this.deps.resume &&
          locked.expiresAt > now;
        const status = locked.cancelRequested
          ? locked.status === "transcribing"
            ? "failed"
            : "cancelled"
          : (canResume || (locked.status !== "transcribing" && locked.attempt < 2)) &&
              locked.expiresAt > now
            ? "queued"
            : "failed";
        if (status === "queued" && !cleaned) return;
        await tx
          .update(jobs)
          .set({
            status,
            cleanupPending: !cleaned,
            progress: status === "queued" ? 0 : locked.progress,
            error:
              locked.cancelRequested && locked.status === "transcribing"
                ? "provider_cancellation_unavailable"
                : status === "failed"
                  ? locked.status === "transcribing"
                    ? "interrupted_transcription"
                    : "interrupted"
                  : null,
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(jobs.id, row.id));
      });
    }
    await this.db
      .update(jobs)
      .set({
        status: sql`CASE WHEN ${jobs.providerSubmittedAt} IS NOT NULL THEN 'failed' ELSE 'cancelled' END`,
        error: sql`CASE WHEN ${jobs.providerSubmittedAt} IS NOT NULL THEN 'provider_cancellation_unavailable' ELSE NULL END`,
        updatedAt: now,
      })
      .where(and(eq(jobs.status, "queued"), eq(jobs.cancelRequested, true)));
    const purged = await this.db
      .update(jobs)
      .set({ result: null, cleanupPending: true, updatedAt: now })
      .where(and(lt(jobs.expiresAt, now), sql`${jobs.result} IS NOT NULL`))
      .returning({ id: jobs.id, attempt: jobs.attempt });
    for (const row of purged) await this.cleanup(row.id, row.attempt);
    await this.db
      .update(jobs)
      .set({ status: "failed", error: "expired", updatedAt: now })
      .where(and(eq(jobs.status, "queued"), lt(jobs.expiresAt, now)));
    const cleanupRows = await this.db
      .select({ id: jobs.id, attempt: jobs.attempt })
      .from(jobs)
      .where(
        and(
          eq(jobs.cleanupPending, true),
          inArray(jobs.status, ["queued", "completed", "failed", "cancelled", "expired"]),
        ),
      )
      .orderBy(jobs.updatedAt)
      .limit(20);
    for (const row of cleanupRows) await this.cleanup(row.id, row.attempt);
  }
  private async claim() {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('hanori_media_worker', 0))`,
      );
      const now = new Date();
      const [leased] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(inArray(jobs.status, running), gt(jobs.leaseExpiresAt, now)))
        .limit(1);
      if (leased || this.stopped) return undefined;
      const [row] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "queued"),
            isNotNull(jobs.confirmedAt),
            eq(jobs.cancelRequested, false),
            gt(jobs.expiresAt, now),
            sql`(${jobs.attempt} < 2 OR ${jobs.providerTaskId} IS NOT NULL)`,
            eq(jobs.cleanupPending, false),
          ),
        )
        .orderBy(jobs.createdAt)
        .for("update", { skipLocked: true })
        .limit(1);
      if (!row) return undefined;
      const [claimed] = await tx
        .update(jobs)
        .set({
          status: row.providerTaskId ? "transcribing" : "downloading",
          progress: row.providerTaskId ? 70 : 10,
          cleanupPending: true,
          leaseId: randomUUID(),
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempt: Math.min(row.attempt + 1, 2),
          updatedAt: now,
        })
        .where(eq(jobs.id, row.id))
        .returning();
      return claimed;
    });
  }
  private async current(row: MediaJobRow) {
    const [stored] = await this.db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.id, row.id), eq(jobs.leaseId, row.leaseId!), inArray(jobs.status, running)),
      );
    if (
      !stored ||
      stored.cancelRequested ||
      !stored.leaseExpiresAt ||
      stored.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new MediaJobError("interrupted");
    const config = await this.configuration(row.botId, row.providerAccount);
    if (!matches(row, config)) throw new MediaJobError("configuration_required");
    return config;
  }
  private async runTick() {
    await this.recover();
    await this.deliverPending();
    if (this.stopped) return;
    const row = await this.claim();
    if (!row) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    this.active = { row, controller };
    const execution: { stage: MediaJobStage } = {
      stage: row.providerTaskId ? "transcribing" : "downloading",
    };
    let heartbeatTask = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatTask = heartbeatTask
        .then(async () => {
          if (signal.aborted) return;
          await this.current(row);
          await this.db
            .update(jobs)
            .set({ leaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: new Date() })
            .where(and(eq(jobs.id, row.id), eq(jobs.leaseId, row.leaseId!)));
        })
        .catch(() => controller.abort(new MediaJobError("configuration_required")));
    }, 8_000);
    heartbeat.unref();
    try {
      const config = await this.current(row);
      const result =
        row.providerTaskId && this.deps.resume
          ? await this.deps.resume(row, config, signal)
          : await this.deps.execute(row, config, {
              signal,
              onStage: async (next) => {
                signal.throwIfAborted();
                if (!Object.hasOwn(progress, next) || progress[next] < progress[execution.stage])
                  throw new MediaJobError("job_failed");
                await this.current(row);
                const [saved] = await this.db
                  .update(jobs)
                  .set({
                    status: next,
                    progress: progress[next],
                    updatedAt: new Date(),
                    ...(next === "transcribing" ? { providerSubmittedAt: new Date() } : {}),
                  })
                  .where(
                    and(
                      eq(jobs.id, row.id),
                      eq(jobs.leaseId, row.leaseId!),
                      eq(jobs.cancelRequested, false),
                      inArray(jobs.status, running),
                    ),
                  )
                  .returning({ id: jobs.id });
                if (!saved) throw new MediaJobError("interrupted");
                execution.stage = next;
                signal.throwIfAborted();
              },
              onProviderTask: async (taskId) => {
                if (!taskId || taskId.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(taskId))
                  throw new MediaJobError("job_failed");
                const [saved] = await this.db
                  .update(jobs)
                  .set({ providerTaskId: taskId, updatedAt: new Date() })
                  .where(
                    and(
                      eq(jobs.id, row.id),
                      eq(jobs.leaseId, row.leaseId!),
                      eq(jobs.status, "transcribing"),
                    ),
                  )
                  .returning({ id: jobs.id });
                if (!saved) throw new MediaJobError("interrupted");
              },
            });
      signal.throwIfAborted();
      await this.current(row);
      if (execution.stage !== "transcribing") throw new MediaJobError("job_failed");
      const transcript = normalizedResult(result);
      const completed = await this.db
        .update(jobs)
        .set({
          status: "completed",
          progress: 100,
          result: transcript,
          error: null,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(jobs.id, row.id), eq(jobs.leaseId, row.leaseId!), eq(jobs.cancelRequested, false)),
        )
        .returning({ id: jobs.id });
      if (!completed.length) throw new MediaJobError("interrupted");
    } catch {
      const [stored] = await this.db.select().from(jobs).where(eq(jobs.id, row.id));
      const retry =
        this.stopped &&
        ((execution.stage !== "transcribing" && row.attempt < 2) ||
          Boolean(stored?.providerTaskId && this.deps.resume)) &&
        !stored?.cancelRequested;
      await this.db
        .update(jobs)
        .set({
          status:
            stored?.cancelRequested && execution.stage !== "transcribing"
              ? "cancelled"
              : retry
                ? "queued"
                : "failed",
          progress: retry && !stored?.providerTaskId ? 0 : progress[execution.stage],
          error: stored?.cancelRequested
            ? execution.stage === "transcribing"
              ? "provider_cancellation_unavailable"
              : null
            : execution.stage === "transcribing"
              ? "interrupted_transcription"
              : "job_failed",
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(jobs.id, row.id), eq(jobs.leaseId, row.leaseId!)));
    } finally {
      clearInterval(heartbeat);
      await heartbeatTask;
      await this.cleanup(row.id, row.attempt);
      if (this.active?.row.id === row.id) this.active = undefined;
    }
    await this.deliverPending();
  }
  private async performCleanup(id: string, attempt: number): Promise<boolean> {
    try {
      await this.deps.cleanup?.(id, attempt);
      return true;
    } catch {
      return false;
    }
  }
  private async cleanup(id: string, attempt: number) {
    if (await this.performCleanup(id, attempt)) {
      await this.db
        .update(jobs)
        .set({ cleanupPending: false })
        .where(and(eq(jobs.id, id), eq(jobs.attempt, attempt)));
    }
  }
  private async deliverPending() {
    const pending = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "completed"),
          eq(jobs.notification, "pending"),
          gt(jobs.expiresAt, new Date()),
        ),
      );
    for (const row of pending) {
      const [claimed] = await this.db
        .update(jobs)
        .set({ notification: "delivering", updatedAt: new Date() })
        .where(and(eq(jobs.id, row.id), eq(jobs.notification, "pending")))
        .returning();
      if (!claimed) continue;
      let sent = false;
      try {
        if (this.deps.notify) {
          await bounded(
            async () => this.deps.notify!({ ...claimed, result: null }),
            this.shutdown.signal,
            15_000,
          );
          sent = true;
        }
      } catch {
        /* Notification is at most once; the owner can retrieve the result by ID. */
      }
      await this.db
        .update(jobs)
        .set({ notification: sent ? "sent" : "failed", updatedAt: new Date() })
        .where(and(eq(jobs.id, row.id), eq(jobs.notification, "delivering")));
    }
  }
}
