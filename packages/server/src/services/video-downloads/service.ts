import { videoDownloadJobs as jobs, type Database } from "@cos-tool-bot/database";
import {
  parseBilibiliResource,
  type VideoDownloadActor,
  type VideoDownloadPort,
  type VideoDownloadStatus,
  type VideoDownloadView,
} from "@cos-tool-bot/shared";
import { and, asc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { BilibiliClientError } from "../media/bilibili.js";
import { MediaHttpError } from "../media/http.js";
import { VideoDownloadCacheError } from "./cache.js";
import {
  VideoDownloadError,
  type InspectedVideoDownload,
  type VideoDownloadConfiguration,
  type VideoDownloadStage,
} from "./contracts.js";

export type VideoDownloadRow = typeof jobs.$inferSelect;
export interface DownloadedVideo {
  path: string;
  bytes: number;
  expiresAt: number;
}
export interface VideoDownloadDependencies {
  configuration(botId: string): Promise<VideoDownloadConfiguration | null>;
  inspect(
    source: string,
    config: VideoDownloadConfiguration,
    signal: AbortSignal,
  ): Promise<InspectedVideoDownload>;
  download(
    row: VideoDownloadRow,
    config: VideoDownloadConfiguration,
    options: { signal: AbortSignal; onStage(stage: VideoDownloadStage): Promise<void> },
  ): Promise<DownloadedVideo>;
  deliver(row: VideoDownloadRow, file: DownloadedVideo, signal: AbortSignal): Promise<number>;
  cleanup(id: string, retain?: boolean): Promise<void>;
  sweep(): Promise<void>;
  notifyFailure?(row: VideoDownloadRow): Promise<void>;
  reportError?(code: "video_download_tick_failed" | "video_download_cleanup_failed"): void;
}
const running: VideoDownloadStatus[] = ["downloading", "merging", "sending"];
const activeStatuses: VideoDownloadStatus[] = ["queued", ...running];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function authorize(actor: VideoDownloadActor) {
  if (
    !actor.isAdmin ||
    !uuid.test(actor.botId) ||
    !Number.isSafeInteger(actor.chatId) ||
    actor.chatId === 0 ||
    !Number.isSafeInteger(actor.userId) ||
    actor.userId < 1 ||
    (actor.threadId !== undefined &&
      (!Number.isSafeInteger(actor.threadId) ||
        actor.threadId < 1 ||
        actor.threadId > 2_147_483_647))
  )
    throw new VideoDownloadError("forbidden");
}
function view(row: VideoDownloadRow): VideoDownloadView {
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    title: row.title,
    durationSeconds: row.durationSeconds,
    status: row.status,
    error: row.error,
    bytes: row.bytes,
    messageId: row.messageId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cacheExpiresAt: row.cacheExpiresAt?.toISOString() ?? null,
  };
}
function matches(row: VideoDownloadRow, config: VideoDownloadConfiguration) {
  return (
    row.configRevision === config.revision &&
    row.installationRevision === config.installationRevision
  );
}
function safeError(error: unknown): string {
  if (
    error instanceof VideoDownloadError ||
    error instanceof VideoDownloadCacheError ||
    error instanceof MediaHttpError ||
    error instanceof BilibiliClientError
  )
    return error.code;
  return "download_failed";
}

/** A database lock serializes download, upload, recovery and disk cleanup across app processes.
 * The lock transaction contains no job writes: status changes stay durable before sending.
 */
export class VideoDownloadService implements VideoDownloadPort {
  private readonly shutdown = new AbortController();
  private active?: { id: string; botId: string; controller: AbortController };
  private ticking?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly pendingCleanup = new Map<string, boolean>();
  constructor(
    private readonly db: Database,
    private readonly deps: VideoDownloadDependencies,
  ) {}

  private async configuration(botId: string) {
    const config = await this.deps.configuration(botId);
    if (!config) throw new VideoDownloadError("configuration_required");
    return config;
  }
  private async owned(actor: VideoDownloadActor, id: string) {
    authorize(actor);
    if (!uuid.test(id)) throw new VideoDownloadError("not_found");
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
    if (!row || row.threadId !== (actor.threadId ?? null))
      throw new VideoDownloadError("not_found");
    return row;
  }
  async create(
    actor: VideoDownloadActor,
    input: { sourceUrl: string },
    callerSignal?: AbortSignal,
  ) {
    authorize(actor);
    if (this.stopped) throw new VideoDownloadError("interrupted");
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(callerSignal ? [callerSignal] : []),
      AbortSignal.timeout(20_000),
    ]);
    signal.throwIfAborted();
    try {
      parseBilibiliResource(input.sourceUrl);
    } catch {
      throw new VideoDownloadError("invalid_source");
    }
    const config = await this.configuration(actor.botId);
    const resource = await this.deps.inspect(input.sourceUrl, config, signal);
    signal.throwIfAborted();
    const parsed = parseBilibiliResource(resource.canonicalUrl);
    if (
      parsed.kind !== "canonical" ||
      parsed.idType !== "bv" ||
      parsed.id !== resource.bvid ||
      parsed.part !== resource.part ||
      parsed.canonicalUrl !== resource.canonicalUrl ||
      typeof resource.title !== "string" ||
      resource.title.length > 500
    )
      throw new VideoDownloadError("invalid_source");
    if (
      !Number.isSafeInteger(resource.durationSeconds) ||
      resource.durationSeconds < 1 ||
      resource.durationSeconds > config.limits.maxDurationSeconds ||
      resource.durationSeconds > 2_147_483_647
    )
      throw new VideoDownloadError("duration_limit");
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const { row, created } = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`video-download:create:${actor.botId}:${actor.userId}`},0))`,
      );
      const current = await this.configuration(actor.botId);
      if (
        current.revision !== config.revision ||
        current.installationRevision !== config.installationRevision
      )
        throw new VideoDownloadError("configuration_required");
      signal.throwIfAborted();
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
            sql`${jobs.threadId} IS NOT DISTINCT FROM ${actor.threadId ?? null}`,
            inArray(jobs.status, activeStatuses),
          ),
        )
        .limit(1);
      if (duplicate) return { row: duplicate, created: false };
      const [usage] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(eq(jobs.botId, actor.botId), eq(jobs.userId, actor.userId), gte(jobs.createdAt, day)),
        );
      if (!usage || usage.count >= config.limits.dailyJobs)
        throw new VideoDownloadError("quota_exceeded");
      const [saved] = await tx
        .insert(jobs)
        .values({
          botId: actor.botId,
          chatId: actor.chatId,
          userId: actor.userId,
          threadId: actor.threadId,
          configRevision: config.revision,
          installationRevision: config.installationRevision,
          sourceUrl: resource.canonicalUrl,
          bvid: resource.bvid,
          part: resource.part,
          title: resource.title,
          durationSeconds: resource.durationSeconds,
        })
        .returning();
      return { row: saved!, created: true };
    });
    if (signal.aborted) {
      if (created) await this.cancel(actor, row.id);
      throw new VideoDownloadError("interrupted");
    }
    return view(row);
  }
  async get(actor: VideoDownloadActor, id: string) {
    return view(await this.owned(actor, id));
  }
  async cancel(actor: VideoDownloadActor, id: string) {
    const row = await this.owned(actor, id);
    // Uploading is an irreversible external action; never promise it was cancelled.
    if (!(["queued", "downloading", "merging"] as VideoDownloadStatus[]).includes(row.status))
      return view(row);
    const [saved] = await this.db
      .update(jobs)
      .set({
        cancelRequested: true,
        status: sql`CASE WHEN ${jobs.status}='queued' THEN 'cancelled' ELSE ${jobs.status} END`,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", "downloading", "merging"])))
      .returning();
    if (saved && this.active?.id === id)
      this.active.controller.abort(new VideoDownloadError("cancelled"));
    return view(saved ?? (await this.owned(actor, id)));
  }
  async cancelForBot(botId?: string) {
    await this.db
      .update(jobs)
      .set({ cancelRequested: true, updatedAt: new Date() })
      .where(
        and(
          botId === undefined ? undefined : eq(jobs.botId, botId),
          inArray(jobs.status, activeStatuses),
        ),
      );
    if (this.active && (botId === undefined || this.active.botId === botId))
      this.active.controller.abort(new VideoDownloadError("configuration_changed"));
  }
  async start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => this.deps.reportError?.("video_download_tick_failed"));
    }, 2000);
    this.timer.unref();
    void this.tick().catch(() => this.deps.reportError?.("video_download_tick_failed"));
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort(new VideoDownloadError("interrupted"));
    await this.ticking;
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.db
      .transaction(async (tx) => {
        const locked = await tx.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended('hanori:video-download-worker',0)) AS acquired`,
        );
        if (!locked[0]?.acquired || this.stopped) return;
        await this.recover();
        await this.deps.sweep();
        const [row] = await this.db
          .select()
          .from(jobs)
          .where(eq(jobs.status, "queued"))
          .orderBy(asc(jobs.createdAt))
          .limit(1);
        if (row && !this.stopped) await this.run(row);
        // Task metadata is small but also expires. Active uploads are never removed.
        await this.db
          .delete(jobs)
          .where(
            and(
              eq(jobs.cleanupPending, false),
              lt(jobs.updatedAt, new Date(Date.now() - 7 * 86400_000)),
              inArray(jobs.status, ["completed", "failed", "cancelled", "delivery_unknown"]),
            ),
          );
      })
      .finally(() => {
        if (this.ticking === task) this.ticking = undefined;
      });
    this.ticking = task;
    return task;
  }
  private async recover() {
    // Bot deletion can cascade away the database row while its worker is stopping.
    for (const [id, retain] of this.pendingCleanup) {
      await this.deps.cleanup(id, retain);
      await this.db.update(jobs).set({ cleanupPending: false }).where(eq(jobs.id, id));
      this.pendingCleanup.delete(id);
    }
    // Owning the global lock proves no other live tick is executing these rows.
    const abandoned = await this.db
      .select()
      .from(jobs)
      .where(or(inArray(jobs.status, running), eq(jobs.cleanupPending, true)));
    for (const row of abandoned) {
      await this.deps.cleanup(row.id, row.status === "completed");
      await this.db
        .update(jobs)
        .set({
          cleanupPending: false,
          ...(running.includes(row.status)
            ? {
                status:
                  row.status === "sending"
                    ? ("delivery_unknown" as const)
                    : row.cancelRequested
                      ? ("cancelled" as const)
                      : ("failed" as const),
                error: row.status === "sending" ? "delivery_unknown" : "interrupted",
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, row.id));
    }
  }
  private async run(row: VideoDownloadRow) {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.shutdown.signal,
      AbortSignal.timeout(10 * 60_000),
    ]);
    this.active = { id: row.id, botId: row.botId, controller };
    let sending = false;
    let completed = false;
    let checking = false;
    const assertCurrent = async () => {
      signal.throwIfAborted();
      const config = await this.configuration(row.botId);
      const [current] = await this.db.select().from(jobs).where(eq(jobs.id, row.id));
      if (!current || current.cancelRequested) throw new VideoDownloadError("cancelled");
      if (!matches(row, config)) throw new VideoDownloadError("configuration_changed");
      signal.throwIfAborted();
      return config;
    };
    const poll = setInterval(() => {
      if (checking) return;
      checking = true;
      void assertCurrent()
        .catch((error: unknown) => controller.abort(error))
        .finally(() => {
          checking = false;
        });
    }, 1000);
    poll.unref();
    try {
      const config = await assertCurrent();
      if (row.createdAt.getTime() < Date.now() - 3600_000) throw new VideoDownloadError("expired");
      await this.db.update(jobs).set({ cleanupPending: true }).where(eq(jobs.id, row.id));
      const file = await this.deps.download(row, config, {
        signal,
        onStage: async (stage) => {
          await assertCurrent();
          const [saved] = await this.db
            .update(jobs)
            .set({ status: stage, updatedAt: new Date() })
            .where(
              and(
                eq(jobs.id, row.id),
                eq(jobs.cancelRequested, false),
                inArray(jobs.status, ["queued", "downloading", "merging"]),
              ),
            )
            .returning();
          if (!saved) throw new VideoDownloadError("cancelled");
        },
      });
      await assertCurrent();
      if (
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > config.limits.maxBytes ||
        !Number.isFinite(file.expiresAt) ||
        file.expiresAt <= Date.now()
      )
        throw new VideoDownloadError("invalid_video");
      const [committing] = await this.db
        .update(jobs)
        .set({
          status: "sending",
          bytes: file.bytes,
          cacheExpiresAt: new Date(file.expiresAt),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jobs.id, row.id),
            eq(jobs.cancelRequested, false),
            inArray(jobs.status, ["downloading", "merging"]),
          ),
        )
        .returning();
      if (!committing) throw new VideoDownloadError("cancelled");
      signal.throwIfAborted();
      sending = true;
      const messageId = await this.deps.deliver(row, file, signal);
      if (!Number.isSafeInteger(messageId) || messageId < 1)
        throw new VideoDownloadError("delivery_unknown");
      // A known receipt remains success even if cancellation arrived during upload.
      await this.db
        .update(jobs)
        .set({ status: "completed", messageId, updatedAt: new Date() })
        .where(eq(jobs.id, row.id));
      completed = true;
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      const status = sending
        ? "delivery_unknown"
        : reason instanceof VideoDownloadError && reason.code === "cancelled"
          ? "cancelled"
          : "failed";
      const [failed] = await this.db
        .update(jobs)
        .set({
          status,
          error: sending ? "delivery_unknown" : safeError(reason),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, row.id))
        .returning();
      if (failed) await this.deps.notifyFailure?.(failed).catch(() => undefined);
    } finally {
      clearInterval(poll);
      this.active = undefined;
      // Stop the worker before touching its files. Uncertain uploads get no automatic retry.
      this.pendingCleanup.set(row.id, completed);
      try {
        await this.deps.cleanup(row.id, completed);
        await this.db.update(jobs).set({ cleanupPending: false }).where(eq(jobs.id, row.id));
        this.pendingCleanup.delete(row.id);
      } catch {
        this.deps.reportError?.("video_download_cleanup_failed");
      }
    }
  }
}
