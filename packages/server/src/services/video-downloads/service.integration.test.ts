import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@cos-tool-bot/database";
import { parseBilibiliResource, type VideoDownloadActor } from "@cos-tool-bot/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoDownloadCache } from "./cache.js";
import type { VideoDownloadConfiguration } from "./contracts.js";
import { VideoDownloadService, type VideoDownloadDependencies } from "./service.js";

const baseUrl = process.env.PLUGIN_CONFIG_TEST_DATABASE_URL;
const bvid = "BV1xx411c7mD";
const source = (part = 1) =>
  `https://www.bilibili.com/video/${bvid}${part === 1 ? "" : `?p=${part}`}`;
function fixtureConfig(): VideoDownloadConfiguration {
  return {
    revision: 1,
    installationRevision: 3,
    cookie: "synthetic-private-cookie",
    limits: {
      maxDurationSeconds: 600,
      maxBytes: 1000,
      maxCacheBytes: 10_000,
      minFreeDiskBytes: 50,
      cacheTtlMs: 60_000,
      dailyJobs: 10,
    },
  };
}

describe.skipIf(!baseUrl)("durable video download jobs", () => {
  const databaseName = `video_downloads_${randomUUID().replaceAll("-", "")}_test`;
  let admin: ReturnType<typeof createDb> | undefined;
  let connection: ReturnType<typeof createDb>;
  let url: string;
  let created = false;
  let configuration: VideoDownloadConfiguration | null;
  let actor: VideoDownloadActor;
  let otherBotId: string;
  let service: VideoDownloadService;
  let deps: VideoDownloadDependencies;
  const services: VideoDownloadService[] = [];
  const connections: ReturnType<typeof createDb>[] = [];
  const releaseGates: (() => void)[] = [];

  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !parsed.pathname.endsWith("_test")
    ) {
      throw new Error("Video download tests require an explicit local *_test database");
    }
    admin = createDb(parsed.href);
    await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    parsed.pathname = `/${databaseName}`;
    url = parsed.href;
    connection = createDb(url);
    await connection.client.unsafe("CREATE TABLE public.bots (id uuid PRIMARY KEY)");
    for (const name of ["0065_sturdy_mephisto.sql", "0066_large_thunderbolt_ross.sql"]) {
      const migration = await readFile(
        new URL(`../../../../database/drizzle/${name}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        await connection.client.unsafe(statement);
    }
  }, 15_000);
  beforeEach(async () => {
    await connection.client.unsafe("TRUNCATE public.bots, video_download_jobs");
    actor = { botId: randomUUID(), chatId: -100, userId: 42, threadId: 7, isAdmin: true };
    otherBotId = randomUUID();
    await connection.client`INSERT INTO public.bots (id) VALUES (${actor.botId}), (${otherBotId})`;
    configuration = fixtureConfig();
    deps = {
      configuration: vi.fn(async () => configuration),
      inspect: vi.fn(async (url) => {
        const parsed = parseBilibiliResource(url);
        if (parsed.kind !== "canonical" || parsed.idType !== "bv")
          throw new Error("Invalid test source");
        return {
          canonicalUrl: parsed.canonicalUrl,
          bvid: parsed.id,
          part: parsed.part,
          title: "Synthetic clip",
          durationSeconds: 60,
        };
      }),
      download: vi.fn(async (_row, _config, options) => {
        await options.onStage("downloading");
        await options.onStage("merging");
        return { path: "/synthetic/output.mp4", bytes: 80, expiresAt: Date.now() + 60_000 };
      }),
      deliver: vi.fn(async () => 123),
      cleanup: vi.fn(async () => {}),
      sweep: vi.fn(async () => {}),
      notifyFailure: vi.fn(async () => {}),
      reportError: vi.fn(),
    };
    service = makeService();
  });
  afterEach(async () => {
    releaseGates.splice(0).forEach((release) => release());
    await Promise.all(services.splice(0).map((item) => item.close()));
    await Promise.all(connections.splice(0).map((item) => item.client.end()));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (connection) await connection.client.end();
    if (admin) {
      try {
        if (created) await admin.client.unsafe(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin.client.end();
      }
    }
  });
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseGates.push(release);
    return { promise, release };
  }
  function makeService(database = connection.db) {
    const instance = new VideoDownloadService(database, deps);
    services.push(instance);
    return instance;
  }
  function create(part = 1, scope = actor) {
    return service.create(scope, { sourceUrl: source(part) });
  }
  async function stored(id: string) {
    const [row] = await connection.client`SELECT * FROM video_download_jobs WHERE id=${id}`;
    return row!;
  }

  it("deduplicates concurrent requests, persists identity, and stores no cookie", async () => {
    configuration!.limits.dailyJobs = 1;
    const [first, duplicate] = await Promise.all([create(), create()]);
    expect(first.id).toBe(duplicate.id);
    expect(first).toMatchObject({
      status: "queued",
      sourceUrl: source(),
      title: "Synthetic clip",
      durationSeconds: 60,
    });
    const row = await stored(first.id);
    expect(row).toMatchObject({
      config_revision: 1,
      installation_revision: 3,
      thread_id: 7,
      part: 1,
    });
    expect(JSON.stringify(row)).not.toContain("synthetic-private-cookie");
    expect(await connection.client`SELECT id FROM video_download_jobs`).toHaveLength(1);
    const restarted = makeService();
    expect(await restarted.get(actor, first.id)).toEqual(first);
    await expect(create(2, { ...actor, chatId: -200 })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    expect(await create(2, { ...actor, userId: 43 })).toMatchObject({ status: "queued" });
    expect(await create(2, { ...actor, botId: otherBotId })).toMatchObject({ status: "queued" });
  });

  it("isolates job reads and cancellation by bot, chat, user, and forum thread", async () => {
    await expect(create(1, { ...actor, isAdmin: false })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(deps.inspect).not.toHaveBeenCalled();
    const saved = await create();
    for (const change of [
      { botId: otherBotId },
      { chatId: -101 },
      { userId: 43 },
      { threadId: 8 },
      { threadId: undefined },
    ]) {
      const outsider = { ...actor, ...change };
      await expect(service.get(outsider, saved.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(service.cancel(outsider, saved.id)).rejects.toMatchObject({ code: "not_found" });
    }
    expect((await stored(saved.id)).cancel_requested).toBe(false);
    await expect(service.get(actor, "../not-an-id")).rejects.toMatchObject({ code: "not_found" });
    const otherThread = await create(1, { ...actor, threadId: 8 });
    expect(otherThread.id).not.toBe(saved.id);
  });

  it("rejects untrusted sources, inconsistent metadata and excessive duration", async () => {
    await expect(
      service.create(actor, { sourceUrl: "https://evil.example/private" }),
    ).rejects.toMatchObject({ code: "invalid_source" });
    expect(deps.inspect).not.toHaveBeenCalled();
    deps.inspect = vi.fn(async () => ({
      canonicalUrl: source(),
      bvid,
      part: 2,
      title: "Synthetic clip",
      durationSeconds: 60,
    }));
    await expect(create()).rejects.toMatchObject({ code: "invalid_source" });
    deps.inspect = vi.fn(async () => ({
      canonicalUrl: source(),
      bvid,
      part: 1,
      title: "Synthetic clip",
      durationSeconds: 601,
    }));
    await expect(create()).rejects.toMatchObject({ code: "duration_limit" });
    expect(await connection.client`SELECT id FROM video_download_jobs`).toHaveLength(0);
  });

  it("persists each stage before download, merging and sending, then stores a Telegram receipt", async () => {
    const saved = await create();
    const stages: string[] = [];
    deps.download = vi.fn(async (_row, _config, options) => {
      expect((await stored(saved.id)).status).toBe("queued");
      for (const stage of ["downloading", "merging"] as const) {
        await options.onStage(stage);
        stages.push((await stored(saved.id)).status);
      }
      return { path: "/synthetic/output.mp4", bytes: 80, expiresAt: Date.now() + 60_000 };
    });
    deps.deliver = vi.fn(async () => {
      const row = await stored(saved.id);
      expect(row).toMatchObject({ status: "sending", bytes: 80, message_id: null });
      expect(row.cache_expires_at).toBeTruthy();
      stages.push(row.status);
      return 123;
    });
    await service.tick();
    expect(stages).toEqual(["downloading", "merging", "sending"]);
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "completed",
      messageId: 123,
      bytes: 80,
      error: null,
    });
    expect(deps.cleanup).toHaveBeenLastCalledWith(saved.id, true);
    await service.tick();
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("cancels queued and downloading work before sending and cleans its files", async () => {
    const queued = await create(2);
    expect(await service.cancel(actor, queued.id)).toMatchObject({ status: "cancelled" });
    await service.tick();
    expect(deps.download).not.toHaveBeenCalled();
    const saved = await create();
    const entered = gate();
    const proceed = gate();
    let signal!: AbortSignal;
    deps.download = vi.fn(async (_row, _config, options) => {
      signal = options.signal;
      await options.onStage("downloading");
      entered.release();
      await proceed.promise;
      signal.throwIfAborted();
      throw new Error("Cancelled download must not continue");
    });
    const tick = service.tick();
    await entered.promise;
    await service.cancel(actor, saved.id);
    expect(signal.aborted).toBe(true);
    proceed.release();
    await tick;
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "cancelled",
      error: "cancelled",
    });
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenLastCalledWith(saved.id, false);
  });

  it("does not falsely promise cancellation of an upload and keeps a known receipt", async () => {
    const saved = await create();
    const entered = gate();
    const proceed = gate();
    let signal!: AbortSignal;
    deps.deliver = vi.fn(async (_row, _file, current) => {
      signal = current;
      entered.release();
      await proceed.promise;
      return 999;
    });
    const tick = service.tick();
    await entered.promise;
    expect(await service.cancel(actor, saved.id)).toMatchObject({ status: "sending" });
    expect(signal.aborted).toBe(false);
    expect((await stored(saved.id)).cancel_requested).toBe(false);
    proceed.release();
    await tick;
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "completed",
      messageId: 999,
    });
  });

  it("rejects stale queued configuration and stops active work on configuration invalidation", async () => {
    const queued = await create();
    configuration = { ...configuration!, revision: 2 };
    await service.tick();
    expect(await service.get(actor, queued.id)).toMatchObject({
      status: "failed",
      error: "configuration_changed",
    });
    expect(deps.download).not.toHaveBeenCalled();
    const saved = await create(2);
    const entered = gate();
    const proceed = gate();
    let signal!: AbortSignal;
    deps.download = vi.fn(async (_row, _config, options) => {
      signal = options.signal;
      await options.onStage("downloading");
      entered.release();
      await proceed.promise;
      signal.throwIfAborted();
      throw new Error("Invalidated work must stop");
    });
    const tick = service.tick();
    await entered.promise;
    await service.cancelForBot(actor.botId);
    expect(signal.aborted).toBe(true);
    proceed.release();
    await tick;
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "failed",
      error: "configuration_changed",
    });
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("marks an upload exception unknown and never resends automatically", async () => {
    const saved = await create();
    deps.deliver = vi.fn(async () => {
      throw new Error("private network diagnostic");
    });
    await service.tick();
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "delivery_unknown",
      error: "delivery_unknown",
      messageId: null,
    });
    expect(JSON.stringify(await stored(saved.id))).not.toContain("private network diagnostic");
    await service.tick();
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.cleanup).toHaveBeenLastCalledWith(saved.id, false);
  });

  it("recovers abandoned running jobs and cleans worker files before sweeping", async () => {
    const downloading = await create(1);
    const merging = await create(2);
    const sending = await create(3);
    await connection.client`UPDATE video_download_jobs SET status='downloading' WHERE id=${downloading.id}`;
    await connection.client`UPDATE video_download_jobs SET status='merging',cancel_requested=true WHERE id=${merging.id}`;
    await connection.client`UPDATE video_download_jobs SET status='sending' WHERE id=${sending.id}`;
    const events: string[] = [];
    deps.cleanup = vi.fn(async (id) => {
      events.push(`cleanup:${id}`);
    });
    deps.sweep = vi.fn(async () => {
      events.push("sweep");
    });
    const restarted = makeService();
    await restarted.tick();
    expect(await restarted.get(actor, downloading.id)).toMatchObject({
      status: "failed",
      error: "interrupted",
    });
    expect(await restarted.get(actor, merging.id)).toMatchObject({
      status: "cancelled",
      error: "interrupted",
    });
    expect(await restarted.get(actor, sending.id)).toMatchObject({
      status: "delivery_unknown",
      error: "delivery_unknown",
    });
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toBe("sweep");
    expect(new Set(events.slice(0, -1))).toEqual(
      new Set([downloading, merging, sending].map((row) => `cleanup:${row.id}`)),
    );
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("serializes two service instances through the database advisory lock", async () => {
    const first = await create(1);
    const second = await create(2);
    const entered = gate();
    const proceed = gate();
    deps.download = vi.fn(async (_row, _config, options) => {
      await options.onStage("downloading");
      entered.release();
      await proceed.promise;
      await options.onStage("merging");
      return { path: "/synthetic/output.mp4", bytes: 80, expiresAt: Date.now() + 60_000 };
    });
    const extra = createDb(url);
    connections.push(extra);
    const competing = makeService(extra.db);
    const tick = service.tick();
    await entered.promise;
    await competing.tick();
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect((await stored(first.id)).status).toBe("downloading");
    expect((await stored(second.id)).status).toBe("queued");
    proceed.release();
    await tick;
    await competing.tick();
    expect(deps.deliver).toHaveBeenCalledTimes(2);
    expect(await service.get(actor, first.id)).toMatchObject({ status: "completed" });
    expect(await service.get(actor, second.id)).toMatchObject({ status: "completed" });
  });

  it("sweeps expired disk artifacts and old task metadata even while downloads are disabled", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "video-download-service-"));
    let now = 1000;
    const cache = new VideoDownloadCache({
      root: join(temporary, "cache"),
      now: () => now,
      statfs: async () => ({ bavail: 100_000n, bsize: 1n }),
    });
    try {
      const saved = await create();
      const lease = await cache.reserve({
        id: saved.id,
        reservedBytes: 100,
        maxCacheBytes: 1000,
        minFreeDiskBytes: 0,
      });
      await writeFile(lease.filePath("output.mp4"), "fixture");
      await lease.commit("output.mp4", { ttlMs: 10, maxFileBytes: 100 });
      await lease.release({ retain: true });
      await connection.client`UPDATE video_download_jobs SET status='completed',updated_at=now()-interval '8 days' WHERE id=${saved.id}`;
      configuration = null;
      deps.sweep = vi.fn(() => cache.sweep());
      now = 1011;
      await service.tick();
      await expect(lstat(lease.filePath("output.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await connection.client`SELECT id FROM video_download_jobs WHERE id=${saved.id}`,
      ).toHaveLength(0);
      expect(deps.download).not.toHaveBeenCalled();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("retries failed cleanup before sweeping and preserves completed receipts", async () => {
    const saved = await create();
    deps.cleanup = vi.fn(async () => {
      throw new Error("worker still running");
    });
    await service.tick();
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "completed",
      messageId: 123,
    });
    expect((await stored(saved.id)).cleanup_pending).toBe(true);
    vi.mocked(deps.sweep).mockClear();
    await expect(service.tick()).rejects.toThrow("worker still running");
    expect(deps.sweep).not.toHaveBeenCalled();
    expect((await stored(saved.id)).cleanup_pending).toBe(true);
    deps.cleanup = vi.fn(async () => {});
    await service.tick();
    expect(deps.cleanup).toHaveBeenCalledWith(saved.id, true);
    expect(deps.sweep).toHaveBeenCalledOnce();
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "completed",
      messageId: 123,
    });
    expect((await stored(saved.id)).cleanup_pending).toBe(false);
    expect(deps.deliver).toHaveBeenCalledOnce();
  });

  it("retries cleanup after bot deletion cascades the task and preserves the successful delivery decision", async () => {
    const saved = await create();
    deps.cleanup = vi.fn(async () => {}).mockRejectedValueOnce(new Error("worker still running"));
    await service.tick();
    expect(await service.get(actor, saved.id)).toMatchObject({
      status: "completed",
      messageId: 123,
    });
    expect(deps.cleanup).toHaveBeenCalledWith(saved.id, true);
    await connection.client`DELETE FROM public.bots WHERE id=${actor.botId}`;
    expect(
      await connection.client`SELECT id FROM video_download_jobs WHERE id=${saved.id}`,
    ).toHaveLength(0);
    const events: string[] = [];
    vi.mocked(deps.cleanup).mockImplementation(async (_id, retain) => {
      expect(retain).toBe(true);
      events.push("cleanup");
    });
    deps.sweep = vi.fn(async () => {
      events.push("sweep");
    });
    await service.tick();
    expect(events).toEqual(["cleanup", "sweep"]);
    expect(deps.cleanup).toHaveBeenCalledTimes(2);
    expect(deps.deliver).toHaveBeenCalledOnce();
  });
});
