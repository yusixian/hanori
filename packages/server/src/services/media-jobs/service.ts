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
import { and, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
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
      | "expired",
  ) {
    super(code);
    this.name = "MediaJobError";
  }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const running = ["downloading", "converting", "transcribing"] as const;
const terminal = new Set(["completed", "failed", "cancelled"]);
const progress = { downloading: 10, converting: 40, transcribing: 70 } as const;
const leaseMs = 90_000;
const retentionMs = 24 * 60 * 60 * 1000;

function authorize(actor: MediaJobActor) {
  if (
    !actor.isAdmin ||
    !uuid.test(actor.botId) ||
    !Number.isSafeInteger(actor.chatId) ||
    actor.chatId === 0 ||
    !Number.isSafeInteger(actor.userId) ||
    actor.userId < 1
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
    value.asr.apiKey.length > 0 &&
    typeof value.asr.baseUrl === "string" &&
    value.asr.baseUrl.length > 0 &&
    Number.isSafeInteger(limits.maxDurationSeconds) &&
    limits.maxDurationSeconds >= 1 &&
    limits.maxDurationSeconds <= 600 &&
    Number.isSafeInteger(limits.dailyJobs) &&
    limits.dailyJobs >= 1 &&
    limits.dailyJobs <= 10 &&
    Number.isFinite(limits.dailyMinutes) &&
    limits.dailyMinutes > 0 &&
    limits.dailyMinutes <= 60 &&
    Number.isFinite(limits.costPerMinute) &&
    limits.costPerMinute > 0 &&
    Number.isFinite(limits.maxDailyCost) &&
    limits.maxDailyCost > 0
  );
}
function matches(row: MediaJobRow, config: MediaJobConfiguration) {
  return (
    row.configRevision === config.revision &&
    row.installationRevision === config.installationRevision &&
    row.providerModel === config.asr.model
  );
}
function view(row: MediaJobRow): MediaJobView {
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    title: row.title,
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
  constructor(
    private readonly db: Database,
    private readonly deps: MediaJobDependencies,
  ) {}

  private async configuration(botId: string) {
    let config: MediaJobConfiguration | null;
    try {
      config = await this.deps.configuration(botId);
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
    return row;
  }
  async create(
    actor: MediaJobActor,
    input: { sourceUrl: string },
    callerSignal?: AbortSignal,
  ): Promise<MediaJobView> {
    authorize(actor);
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
    const config = await this.configuration(actor.botId);
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
    if (resource.hasSubtitles) throw new MediaJobError("subtitles_available");
    if (
      !Number.isSafeInteger(resource.durationSeconds) ||
      resource.durationSeconds < 1 ||
      resource.durationSeconds > config.limits.maxDurationSeconds
    )
      throw new MediaJobError("duration_limit");
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const estimatedCost = (resource.durationSeconds / 60) * config.limits.costPerMinute;
    if (!Number.isFinite(estimatedCost) || estimatedCost > 3.4e38)
      throw new MediaJobError("configuration_required");
    const reservation = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.botId}:${actor.userId}:${day.toISOString()}`}, 0))`,
      );
      const current = await this.configuration(actor.botId);
      if (
        current.revision !== config.revision ||
        current.installationRevision !== config.installationRevision ||
        current.asr.model !== config.asr.model
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
            eq(jobs.bvid, resource.bvid),
            eq(jobs.part, resource.part),
            eq(jobs.configRevision, config.revision),
            eq(jobs.installationRevision, config.installationRevision),
            eq(jobs.providerModel, config.asr.model),
            inArray(jobs.status, ["queued", ...running, "completed"]),
            gt(jobs.expiresAt, now),
          ),
        )
        .limit(1);
      if (duplicate) return { row: duplicate, created: false };
      const [usage] = await tx
        .select({
          count: sql<number>`count(*)::integer`,
          seconds: sql<number>`coalesce(sum(${jobs.durationSeconds}),0)::double precision`,
          // Aggregate decimal reservations before converting to a number at budget edges.
          cost: sql<number>`coalesce(sum(${jobs.estimatedCost}::numeric),0)::double precision`,
        })
        .from(jobs)
        .where(
          and(eq(jobs.botId, actor.botId), eq(jobs.userId, actor.userId), gte(jobs.createdAt, day)),
        );
      if (
        !usage ||
        usage.count >= config.limits.dailyJobs ||
        usage.seconds + resource.durationSeconds > config.limits.dailyMinutes * 60 ||
        usage.cost + estimatedCost > config.limits.maxDailyCost + 1e-8
      )
        throw new MediaJobError("quota_exceeded");
      assertActive();
      const [saved] = await tx
        .insert(jobs)
        .values({
          botId: actor.botId,
          chatId: actor.chatId,
          userId: actor.userId,
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
    return view(reservation.row);
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
    const config = await this.configuration(actor.botId);
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
        status: sql`CASE WHEN ${jobs.status}='queued' THEN 'cancelled' ELSE ${jobs.status} END`,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", ...running])))
      .returning();
    if (this.active?.row.id === id) this.active.controller.abort(new MediaJobError("interrupted"));
    return view(saved ?? (await this.owned(actor, id)));
  }
  private async ownerActor(botId: string, id: string): Promise<MediaJobActor> {
    if (!uuid.test(botId) || !uuid.test(id)) throw new MediaJobError("not_found");
    const [row] = await this.db
      .select({ chatId: jobs.chatId, userId: jobs.userId })
      .from(jobs)
      .where(and(eq(jobs.botId, botId), eq(jobs.id, id)));
    if (!row) throw new MediaJobError("not_found");
    return { botId, chatId: row.chatId, userId: row.userId, isAdmin: true };
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
      .set({ cancelRequested: true, updatedAt: new Date() })
      .where(
        and(
          botId === undefined ? undefined : eq(jobs.botId, botId),
          inArray(jobs.status, ["queued", ...running]),
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
        const status = locked.cancelRequested
          ? "cancelled"
          : locked.status !== "transcribing" && locked.attempt < 2 && locked.expiresAt > now
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
              status === "failed"
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
      .set({ status: "cancelled", updatedAt: now })
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
          inArray(jobs.status, ["queued", "completed", "failed", "cancelled"]),
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
            eq(jobs.cancelRequested, false),
            gt(jobs.expiresAt, now),
            lt(jobs.attempt, 2),
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
          status: "downloading",
          progress: 10,
          cleanupPending: true,
          leaseId: randomUUID(),
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempt: row.attempt + 1,
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
    const config = await this.configuration(row.botId);
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
    const execution: { stage: MediaJobStage } = { stage: "downloading" };
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
      const result = await this.deps.execute(row, config, {
        signal,
        onStage: async (next) => {
          signal.throwIfAborted();
          if (!Object.hasOwn(progress, next) || progress[next] < progress[execution.stage])
            throw new MediaJobError("job_failed");
          await this.current(row);
          const [saved] = await this.db
            .update(jobs)
            .set({ status: next, progress: progress[next], updatedAt: new Date() })
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
        execution.stage !== "transcribing" &&
        row.attempt < 2 &&
        !stored?.cancelRequested;
      await this.db
        .update(jobs)
        .set({
          status: stored?.cancelRequested ? "cancelled" : retry ? "queued" : "failed",
          progress: retry ? 0 : progress[execution.stage],
          error: stored?.cancelRequested
            ? null
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
