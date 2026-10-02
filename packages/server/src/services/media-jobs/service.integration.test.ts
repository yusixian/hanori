import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createDb } from "@cos-tool-bot/database";
import {
  parseBilibiliResource,
  type MediaJobActor,
  type TranscriptDocument,
} from "@cos-tool-bot/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaJobConfiguration, MediaJobDependencies } from "./contracts.js";
import { MediaJobService } from "./service.js";

const baseUrl = process.env.PLUGIN_CONFIG_TEST_DATABASE_URL;
const bvid = "BV1xx411c7mD";
const document: TranscriptDocument = {
  source: "asr",
  track: "original",
  language: "zh",
  cues: [{ startMs: 0, endMs: 1000, text: "Synthetic transcript" }],
};
function source(part = 1) {
  return `https://www.bilibili.com/video/${bvid}${part === 1 ? "" : `?p=${part}`}`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function fixtureConfig(): MediaJobConfiguration {
  return {
    revision: 1,
    installationRevision: 3,
    cookie: "synthetic-cookie",
    asr: {
      baseUrl: "https://asr.example/v1",
      apiKey: "synthetic-api-key",
      model: "whisper-fixture",
    },
    limits: {
      maxDurationSeconds: 600,
      dailyJobs: 10,
      dailyMinutes: 60,
      costPerMinute: 0.01,
      maxDailyCost: 1,
    },
    allowExport: true,
  };
}

describe.skipIf(!baseUrl)("durable media transcription jobs", () => {
  const databaseName = `media_jobs_${randomUUID().replaceAll("-", "")}_test`;
  let admin: ReturnType<typeof createDb> | undefined;
  let connection: ReturnType<typeof createDb>;
  let url: string;
  let created = false;
  let service: MediaJobService;
  let configuration: MediaJobConfiguration | null;
  let deps: MediaJobDependencies;
  let actor: MediaJobActor;
  let otherBotId: string;
  const services: MediaJobService[] = [];
  beforeAll(async () => {
    const parsed = new URL(baseUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.endsWith("_test"))
      throw new Error("Media job tests require an explicit local *_test database");
    admin = createDb(parsed.href);
    await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    parsed.pathname = `/${databaseName}`;
    url = parsed.href;
    connection = createDb(url);
    await connection.client.unsafe("CREATE TABLE public.bots (id uuid PRIMARY KEY)");
    for (const filename of [
      "0058_sloppy_jocasta.sql",
      "0059_superb_lifeguard.sql",
      "0060_gigantic_cargill.sql",
      "0061_sour_meteorite.sql",
      "0062_black_midnight.sql",
      "0063_thin_power_pack.sql",
    ]) {
      const migration = await readFile(
        new URL(`../../../../database/drizzle/${filename}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        await connection.client.unsafe(statement);
    }
  }, 15_000);
  beforeEach(async () => {
    await connection.client.unsafe(
      "TRUNCATE public.bots, bot_plugin_configs, media_transcription_jobs",
    );
    actor = { botId: randomUUID(), chatId: -100, userId: 42, isAdmin: true };
    otherBotId = randomUUID();
    await connection.client`INSERT INTO public.bots (id) VALUES (${actor.botId}), (${otherBotId})`;
    configuration = fixtureConfig();
    deps = {
      configuration: vi.fn(async () => configuration),
      inspect: vi.fn(async (url) => {
        const parsed = parseBilibiliResource(url);
        if (parsed.kind !== "canonical" || parsed.idType !== "bv")
          throw new Error("Not fixture media");
        return {
          canonicalUrl: parsed.canonicalUrl,
          bvid: parsed.id,
          part: parsed.part,
          title: "Fixture video",
          durationSeconds: 60,
          hasSubtitles: false,
        };
      }),
      execute: vi.fn(async (_row, _config, options) => {
        await options.onStage("converting");
        await options.onStage("transcribing");
        return document;
      }),
      cleanup: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    service = makeService();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(services.splice(0).map((item) => item.close()));
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
  function makeService(db = connection.db) {
    const instance = new MediaJobService(db, deps);
    services.push(instance);
    return instance;
  }
  function create(part = 1, scope = actor) {
    return service.create(scope, { sourceUrl: source(part) });
  }
  async function stored(id: string) {
    const [row] = await connection.client`SELECT * FROM media_transcription_jobs WHERE id=${id}`;
    return row!;
  }

  it("durably queues, deduplicates a repeated actor/resource and exposes no stored secrets", async () => {
    const [first, duplicate] = await Promise.all([create(), create()]);
    expect(first.id).toBe(duplicate.id);
    expect(first).toMatchObject({
      status: "queued",
      progress: 0,
      sourceUrl: source(),
      part: 1,
      durationSeconds: 60,
    });
    const row = await stored(first.id);
    expect(row).toMatchObject({
      config_revision: 1,
      installation_revision: 3,
      provider_model: "whisper-fixture",
      estimated_cost: "0.010000000000",
      attempt: 0,
    });
    expect(JSON.stringify(row)).not.toContain("synthetic-cookie");
    expect(JSON.stringify(row)).not.toContain("synthetic-api-key");
    const restartedConnection = createDb(url);
    const restarted = makeService(restartedConnection.db);
    try {
      expect(await restarted.get(actor, first.id)).toEqual(first);
    } finally {
      await restarted.close();
      await restartedConnection.client.end();
    }
  });

  it("aborts inspection with the caller and does not reserve cancelled work", async () => {
    const controller = new AbortController();
    const entered = deferred<AbortSignal>();
    deps.inspect = vi.fn(async (_url, _config, signal) => {
      entered.resolve(signal);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("Inspection must have been cancelled");
    });
    const creation = service.create(actor, { sourceUrl: source() }, controller.signal);
    const rejected = expect(creation).rejects.toMatchObject({ code: "interrupted" });
    const inspectSignal = await entered.promise;
    controller.abort(new Error("private caller diagnostic"));
    await rejected;
    expect(inspectSignal.aborted).toBe(true);
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(0);
    await expect(
      service.create(actor, { sourceUrl: source() }, controller.signal),
    ).rejects.toMatchObject({
      code: "interrupted",
    });
    expect(deps.inspect).toHaveBeenCalledTimes(1);
  });

  it("cancels a reservation committed while its caller was stopping", async () => {
    const controller = new AbortController();
    const blocker = createDb(url);
    let creation: Promise<unknown> | undefined;
    await connection.client
      .unsafe(`CREATE FUNCTION hold_media_cancel_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(134763784); RETURN NEW; END $$;
      CREATE TRIGGER hold_media_cancel_insert BEFORE INSERT ON media_transcription_jobs FOR EACH ROW EXECUTE FUNCTION hold_media_cancel_insert();`);
    try {
      await blocker.client.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(134763784)");
        creation = service
          .create(actor, { sourceUrl: source() }, controller.signal)
          .catch((error) => error);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const [waiting] =
            await connection.client`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
          if (waiting!.count >= 1) {
            controller.abort();
            return;
          }
          await delay(10);
        }
        throw new Error("Reservation must reach its insert lock");
      });
      expect(await creation).toMatchObject({ code: "interrupted" });
      const rows =
        await connection.client`SELECT status,cancel_requested FROM media_transcription_jobs`;
      expect(rows).toEqual([
        expect.objectContaining({ status: "cancelled", cancel_requested: true }),
      ]);
      await service.tick();
      expect(deps.execute).not.toHaveBeenCalled();
    } finally {
      if (creation) await creation;
      await blocker.client.end();
      await connection.client.unsafe(
        "DROP TRIGGER hold_media_cancel_insert ON media_transcription_jobs; DROP FUNCTION hold_media_cancel_insert()",
      );
    }
  });

  it.each(["queued", "converting"] as const)(
    "preserves an existing %s job when its duplicate caller cancels during lookup",
    async (status) => {
      const existing = await create();
      if (status === "converting")
        await connection.client`UPDATE media_transcription_jobs SET status='converting', progress=40, attempt=1, lease_id=${randomUUID()}, lease_expires_at=${new Date(Date.now() + 90_000).toISOString()} WHERE id=${existing.id}`;
      const controller = new AbortController();
      const blocker = createDb(url);
      let creation: Promise<unknown> | undefined;
      try {
        await blocker.client.begin(async (tx) => {
          await tx.unsafe("LOCK TABLE media_transcription_jobs IN ACCESS EXCLUSIVE MODE");
          creation = service
            .create(actor, { sourceUrl: source() }, controller.signal)
            .catch((error) => error);
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const [waiting] =
              await connection.client`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%media_transcription_jobs%'`;
            if (waiting!.count >= 1) {
              controller.abort();
              return;
            }
            await delay(10);
          }
          throw new Error("Duplicate lookup must reach its table lock");
        });
        expect(await creation).toMatchObject({ code: "interrupted" });
        expect(await stored(existing.id)).toMatchObject({ status, cancel_requested: false });
        expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(1);
        if (status === "queued") {
          await service.tick();
          expect((await service.get(actor, existing.id)).status).toBe("completed");
          expect(deps.execute).toHaveBeenCalledOnce();
        }
      } finally {
        if (creation) await creation;
        await blocker.client.end();
      }
    },
  );

  it("provides bounded owner views across chats while retaining Bot isolation and read revision checks", async () => {
    const job = await create();
    await service.tick();
    const otherChat = await create(2, { ...actor, chatId: -200, userId: 43 });
    const otherBot = await create(3, { ...actor, botId: otherBotId });
    await expect(service.get(actor, otherChat.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await service.getForOwner(actor.botId, otherChat.id)).toMatchObject({
      id: otherChat.id,
    });
    expect(await service.readForOwner(actor.botId, job.id)).toEqual(document);
    await expect(service.getForOwner(actor.botId, otherBot.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.cancelForOwner(otherBotId, otherChat.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.readForOwner(otherBotId, job.id)).rejects.toMatchObject({
      code: "not_found",
    });
    configuration!.revision++;
    await expect(service.readForOwner(actor.botId, job.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    configuration = null;
    expect(await service.cancelForOwner(actor.botId, otherChat.id)).toMatchObject({
      status: "cancelled",
    });
    await connection.client`INSERT INTO media_transcription_jobs (bot_id,chat_id,user_id,config_revision,installation_revision,source_url,bvid,part,title,duration_seconds,provider_model,estimated_cost,expires_at,created_at)
      SELECT bot_id,chat_id,user_id,config_revision,installation_revision,source_url,bvid,part,title,duration_seconds,provider_model,estimated_cost,expires_at,created_at + n * INTERVAL '1 second'
      FROM media_transcription_jobs CROSS JOIN generate_series(1,60) n WHERE id=${job.id}`;
    const list = await service.listForBot(actor.botId);
    expect(list).toHaveLength(50);
    expect(list.map((entry) => entry.id)).not.toContain(otherBot.id);
    expect(
      list.every((entry, index) => index === 0 || entry.createdAt <= list[index - 1]!.createdAt),
    ).toBe(true);
    expect(JSON.stringify(list)).not.toContain("Synthetic transcript");
    expect(JSON.stringify(list)).not.toContain("synthetic-api-key");
  });

  it("serializes simultaneous actor/day quota reservations in the actual database", async () => {
    configuration!.limits.dailyJobs = 1;
    const other = makeService();
    const blocker = createDb(url);
    let writes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await connection.client
      .unsafe(`CREATE FUNCTION hold_media_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(134763783); RETURN NEW; END $$;
      CREATE TRIGGER hold_media_insert BEFORE INSERT ON media_transcription_jobs FOR EACH ROW EXECUTE FUNCTION hold_media_insert();`);
    try {
      await blocker.client.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(134763783)");
        writes = Promise.allSettled([create(1), other.create(actor, { sourceUrl: source(2) })]);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const [waiting] =
            await connection.client`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
          if (waiting!.count >= 2) return;
          await delay(10);
        }
        throw new Error("Both reservations must reach their database lock");
      });
      const results = await writes!;
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "quota_exceeded" },
      });
      expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(1);
    } finally {
      if (writes) await writes;
      await blocker.client.end();
      await connection.client.unsafe(
        "DROP TRIGGER hold_media_insert ON media_transcription_jobs; DROP FUNCTION hold_media_insert()",
      );
    }
  });

  it.each(["jobs", "minutes", "cost"])(
    "retains %s reservations for cancelled and failed work",
    async (limit) => {
      if (limit === "jobs") configuration!.limits.dailyJobs = 1;
      if (limit === "minutes") configuration!.limits.dailyMinutes = 1;
      if (limit === "cost") configuration!.limits.maxDailyCost = 0.01;
      const first = await create();
      await service.cancel(actor, first.id);
      await expect(create(2)).rejects.toMatchObject({ code: "quota_exceeded" });
      await connection.client`UPDATE media_transcription_jobs SET status='failed' WHERE id=${first.id}`;
      await expect(create(2)).rejects.toMatchObject({ code: "quota_exceeded" });
    },
  );

  it("accepts the tenth 0.1-dollar reservation at an exact one-dollar budget", async () => {
    configuration!.limits.costPerMinute = 0.1;
    for (let part = 1; part <= 9; part++) await create(part);
    expect((await create(10)).status).toBe("queued");
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(10);
  });

  it("keeps historical price reservations and rejects cost beyond the remaining budget", async () => {
    configuration!.limits.costPerMinute = 0.1;
    for (let part = 1; part <= 8; part++) await create(part);
    configuration = {
      ...configuration!,
      revision: 2,
      limits: { ...configuration!.limits, costPerMinute: 0.2 },
    };
    expect((await create(9)).status).toBe("queued");
    await expect(create(10)).rejects.toMatchObject({ code: "quota_exceeded" });
    const [usage] =
      await connection.client`SELECT count(*)::integer AS count, sum(estimated_cost::numeric) AS cost FROM media_transcription_jobs`;
    expect(usage!.count).toBe(9);
    expect(Number(usage!.cost)).toBe(1);
  });

  it("admits six ten-second reservations at their exact budget and rejects a seventh", async () => {
    const inspect = deps.inspect;
    deps.inspect = vi.fn(async (...args: Parameters<MediaJobDependencies["inspect"]>) => ({
      ...(await inspect(...args)),
      durationSeconds: 10,
    }));
    configuration!.limits.costPerMinute = 0.1;
    configuration!.limits.maxDailyCost = 0.1;
    for (let part = 1; part <= 5; part++) await create(part);
    expect((await create(6)).status).toBe("queued");
    await expect(create(7)).rejects.toMatchObject({ code: "quota_exceeded" });
    const [usage] =
      await connection.client`SELECT count(*)::integer AS count, sum(estimated_cost::numeric) AS cost FROM media_transcription_jobs`;
    expect(usage!.count).toBe(6);
    expect(Number(usage!.cost)).toBeCloseTo(0.1, 10);
  });

  it("authorizes the exact Bot/chat/user scope and permits cancellation after configuration is disabled", async () => {
    await expect(create(1, { ...actor, isAdmin: false })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(deps.inspect).not.toHaveBeenCalled();
    const job = await create();
    for (const scope of [
      { ...actor, botId: otherBotId },
      { ...actor, chatId: -200 },
      { ...actor, userId: 43 },
    ]) {
      await expect(service.get(scope, job.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(service.cancel(scope, job.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(service.read(scope, job.id)).rejects.toMatchObject({ code: "not_found" });
    }
    configuration = null;
    expect(await service.cancel(actor, job.id)).toMatchObject({ status: "cancelled" });
  });

  it("rejects missing or invalid quota configuration before resource inspection", async () => {
    for (const invalid of [
      null,
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, dailyJobs: 11 } },
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, dailyMinutes: NaN } },
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, maxDurationSeconds: 601 } },
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, costPerMinute: 0 } },
    ]) {
      configuration = invalid;
      await expect(create()).rejects.toMatchObject({ code: "configuration_required" });
    }
    expect(deps.inspect).not.toHaveBeenCalled();
  });

  it("requires platform subtitles when present and bounds duration before reserving a job", async () => {
    vi.mocked(deps.inspect).mockResolvedValueOnce({
      canonicalUrl: source(),
      bvid,
      part: 1,
      title: "Fixture",
      durationSeconds: 60,
      hasSubtitles: true,
    });
    await expect(create()).rejects.toMatchObject({ code: "subtitles_available" });
    vi.mocked(deps.inspect).mockResolvedValueOnce({
      canonicalUrl: source(),
      bvid,
      part: 1,
      title: "Fixture",
      durationSeconds: 601,
      hasSubtitles: false,
    });
    await expect(create()).rejects.toMatchObject({ code: "duration_limit" });
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(0);
  });

  it("persists each stage before executor work, completes and delivers only a job notice once", async () => {
    deps.execute = vi.fn(async (row, config, options) => {
      expect(config.asr.apiKey).toBe("synthetic-api-key");
      expect(await stored(row.id)).toMatchObject({
        status: "downloading",
        progress: 10,
        attempt: 1,
      });
      await options.onStage("converting");
      expect(await stored(row.id)).toMatchObject({ status: "converting", progress: 40 });
      await options.onStage("transcribing");
      expect(await stored(row.id)).toMatchObject({ status: "transcribing", progress: 70 });
      return document;
    });
    deps.notify = vi.fn(async (row) => {
      expect(row.result).toBeNull();
      expect(await stored(row.id)).toMatchObject({
        status: "completed",
        notification: "delivering",
      });
    });
    const job = await create();
    await service.tick();
    expect(await service.get(actor, job.id)).toMatchObject({
      status: "completed",
      progress: 100,
      notification: "sent",
      language: "zh",
    });
    expect(await service.read(actor, job.id)).toEqual(document);
    await service.tick();
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(deps.cleanup).toHaveBeenCalledWith(job.id, 1);
  });

  it("allows only one active leased executor across service instances", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("converting");
      if (++calls === 1) {
        started.resolve();
        await release.promise;
      }
      await options.onStage("transcribing");
      return document;
    });
    const first = await create(1);
    const second = await create(2);
    const other = makeService();
    const execution = service.tick();
    await started.promise;
    try {
      await other.tick();
      expect(deps.execute).toHaveBeenCalledOnce();
      expect(await service.get(actor, second.id)).toMatchObject({ status: "queued" });
    } finally {
      release.resolve();
      await execution;
    }
    expect(await service.get(actor, first.id)).toMatchObject({ status: "completed" });
    await other.tick();
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it("cancels a running conversion, waits for executor cleanup and never notifies completion", async () => {
    const started = deferred<AbortSignal>();
    let exited = false;
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("converting");
      started.resolve(options.signal);
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            exited = true;
            reject(options.signal.reason);
          },
          { once: true },
        ),
      );
      return document;
    });
    deps.cleanup = vi.fn(async () => {
      expect(exited).toBe(true);
    });
    const job = await create();
    const execution = service.tick();
    const signal = await started.promise;
    configuration = null;
    await service.cancel(actor, job.id);
    await execution;
    expect(signal.aborted).toBe(true);
    expect(await service.get(actor, job.id)).toMatchObject({ status: "cancelled" });
    expect(deps.cleanup).toHaveBeenCalledOnce();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it.each(["converting", "transcribing"] as const)(
    "shutdown drains %s and only retries pre-charge work",
    async (stage) => {
      const started = deferred<AbortSignal>();
      deps.execute = vi.fn(async (_row, _config, options) => {
        await options.onStage(stage);
        started.resolve(options.signal);
        await new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          }),
        );
        return document;
      });
      const job = await create();
      const execution = service.tick();
      const signal = await started.promise;
      await service.close();
      await execution;
      expect(signal.aborted).toBe(true);
      expect(deps.cleanup).toHaveBeenCalledOnce();
      const afterClose = await service.get(actor, job.id);
      expect(afterClose.status).toBe(stage === "transcribing" ? "failed" : "queued");
      if (stage === "transcribing") expect(afterClose.error).toBe("interrupted_transcription");
      deps.execute = vi.fn(async (_row, _config, options) => {
        await options.onStage("transcribing");
        return document;
      });
      const restarted = makeService();
      await restarted.tick();
      expect(deps.execute).toHaveBeenCalledTimes(stage === "transcribing" ? 0 : 1);
      if (stage === "transcribing")
        expect(await create(1, actor).catch((error) => error)).toMatchObject({ code: "not_ready" });
      else expect(await restarted.get(actor, job.id)).toMatchObject({ status: "completed" });
    },
  );

  it("recovers an expired pre-charge lease once but never resubmits charged or exhausted leases", async () => {
    const charged = await create(1);
    const recoverable = await create(2);
    const exhausted = await create(3);
    const expiredLease = new Date(Date.now() - 1000).toISOString();
    await connection.client`UPDATE media_transcription_jobs SET status='transcribing', progress=70, attempt=1, lease_id=${randomUUID()}, lease_expires_at=${expiredLease} WHERE id=${charged.id}`;
    await connection.client`UPDATE media_transcription_jobs SET status='downloading', progress=10, attempt=1, lease_id=${randomUUID()}, lease_expires_at=${expiredLease} WHERE id=${recoverable.id}`;
    await connection.client`UPDATE media_transcription_jobs SET status='converting', progress=40, attempt=2, lease_id=${randomUUID()}, lease_expires_at=${expiredLease} WHERE id=${exhausted.id}`;
    await service.tick();
    expect(await service.get(actor, charged.id)).toMatchObject({
      status: "failed",
      error: "interrupted_transcription",
    });
    expect(await service.get(actor, exhausted.id)).toMatchObject({
      status: "failed",
      error: "interrupted",
    });
    expect(await service.get(actor, recoverable.id)).toMatchObject({ status: "completed" });
    expect((await stored(recoverable.id)).attempt).toBe(2);
    expect(deps.execute).toHaveBeenCalledOnce();
  });

  it("heartbeat aborts a running job after its configuration revision changes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const started = deferred<AbortSignal>();
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("converting");
      started.resolve(options.signal);
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
      return document;
    });
    const job = await create();
    const execution = service.tick();
    const signal = await started.promise;
    configuration = { ...configuration!, revision: 2 };
    await vi.advanceTimersByTimeAsync(8000);
    await execution;
    expect(signal.aborted).toBe(true);
    expect(await service.get(actor, job.id)).toMatchObject({ status: "failed" });
    expect(deps.cleanup).toHaveBeenCalledOnce();
  });

  it("blocks a provider-stage transition after consent changes and globally cancels queued jobs", async () => {
    let charged = false;
    deps.execute = vi.fn(async (_row, _config, options) => {
      configuration = { ...configuration!, installationRevision: 4 };
      await options.onStage("transcribing");
      charged = true;
      return document;
    });
    const job = await create(1);
    const queued = await create(2);
    await service.tick();
    expect(charged).toBe(false);
    expect(await service.get(actor, job.id)).toMatchObject({ status: "failed" });
    await service.cancelForBot();
    await service.tick();
    expect(await service.get(actor, queued.id)).toMatchObject({ status: "cancelled" });
  });

  it("claims delivery once across instances, marks abandoned delivery failed and keeps results retrievable", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    deps.notify = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });
    const job = await create();
    const other = makeService();
    const finishing = service.tick();
    await started.promise;
    try {
      await other.tick();
      expect(deps.notify).toHaveBeenCalledOnce();
      expect((await service.get(actor, job.id)).notification).toBe("delivering");
    } finally {
      release.resolve();
      await finishing;
    }
    await connection.client`UPDATE media_transcription_jobs SET notification='delivering' WHERE id=${job.id}`;
    const restarted = makeService();
    await restarted.start();
    await restarted.close();
    expect((await service.get(actor, job.id)).notification).toBe("failed");
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(await service.read(actor, job.id)).toEqual(document);
  });

  it("does not retry a failed notification and expires transcript contents with cleanup", async () => {
    deps.notify = vi.fn(async () => {
      throw new Error("private-notification-url");
    });
    const job = await create();
    await service.tick();
    await service.tick();
    expect((await service.get(actor, job.id)).notification).toBe("failed");
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(JSON.stringify(await service.get(actor, job.id))).not.toContain(
      "private-notification-url",
    );
    configuration = { ...configuration!, revision: 2 };
    await expect(service.read(actor, job.id)).rejects.toMatchObject({ code: "not_ready" });
    configuration = fixtureConfig();
    await connection.client`UPDATE media_transcription_jobs SET expires_at=${new Date(Date.now() - 1).toISOString()} WHERE id=${job.id}`;
    await service.tick();
    expect((await stored(job.id)).result).toBeNull();
    await expect(service.read(actor, job.id)).rejects.toMatchObject({ code: "not_ready" });
    expect(deps.cleanup).toHaveBeenCalledTimes(2);
  });
  it("durably retries failed artifact cleanup without repeating execution or notification", async () => {
    vi.mocked(deps.cleanup!).mockRejectedValueOnce(new Error("private-temporary-path"));
    const job = await create();
    await service.tick();
    expect((await stored(job.id)).cleanup_pending).toBe(true);
    await makeService().tick();
    expect((await stored(job.id)).cleanup_pending).toBe(false);
    expect(deps.cleanup).toHaveBeenCalledTimes(2);
    expect(deps.cleanup).toHaveBeenLastCalledWith(job.id, 1);
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.notify).toHaveBeenCalledOnce();
  });

  it("holds an expired pre-charge lease until its previous attempt cleanup succeeds", async () => {
    const job = await create();
    await connection.client`UPDATE media_transcription_jobs SET status='downloading', progress=10, attempt=1, cleanup_pending=true, lease_id=${randomUUID()}, lease_expires_at=${new Date(Date.now() - 1000).toISOString()} WHERE id=${job.id}`;
    vi.mocked(deps.cleanup!).mockRejectedValueOnce(new Error("temporary cleanup failed"));
    await service.tick();
    expect((await stored(job.id)).attempt).toBe(1);
    expect((await stored(job.id)).status).toBe("downloading");
    expect(deps.execute).not.toHaveBeenCalled();
    await service.tick();
    expect((await stored(job.id)).attempt).toBe(2);
    expect((await stored(job.id)).status).toBe("completed");
    expect(deps.cleanup).toHaveBeenNthCalledWith(1, job.id, 1);
    expect(deps.cleanup).toHaveBeenNthCalledWith(2, job.id, 1);
    expect(deps.cleanup).toHaveBeenLastCalledWith(job.id, 2);
  });

  it("fences stale original cleanup by attempt and cannot clear the new attempt cleanup reservation", async () => {
    const oldStarted = deferred<void>();
    const releaseOld = deferred<void>();
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    deps.execute = vi.fn(async (row, _config, options) => {
      await options.onStage("converting");
      if (row.attempt === 1) {
        oldStarted.resolve();
        await releaseOld.promise;
      }
      await options.onStage("transcribing");
      return document;
    });
    deps.cleanup = vi.fn(async (_id, attempt) => {
      if (attempt === 2) {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      }
    });
    const job = await create();
    const oldTick = service.tick();
    await oldStarted.promise;
    await connection.client`UPDATE media_transcription_jobs SET lease_expires_at=${new Date(Date.now() - 1000).toISOString()} WHERE id=${job.id}`;
    const newTick = makeService().tick();
    await cleanupStarted.promise;
    try {
      releaseOld.resolve();
      await oldTick;
      expect((await stored(job.id)).attempt).toBe(2);
      expect((await stored(job.id)).cleanup_pending).toBe(true);
    } finally {
      releaseOld.resolve();
      releaseCleanup.resolve();
      await oldTick;
      await newTick;
    }
    expect((await stored(job.id)).cleanup_pending).toBe(false);
    expect(deps.cleanup).toHaveBeenCalledWith(job.id, 1);
    expect(deps.cleanup).toHaveBeenCalledWith(job.id, 2);
  });
  it("stores only bounded validated ASR fields and rejects oversized transcript bodies", async () => {
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("transcribing");
      return {
        ...document,
        privateDebug: "synthetic-api-key",
        cues: [{ ...document.cues[0]!, privateDebug: "synthetic-cookie" }],
      };
    });
    const first = await create(1);
    await service.tick();
    expect(await service.read(actor, first.id)).toEqual(document);
    expect(JSON.stringify((await stored(first.id)).result)).not.toContain("synthetic-api-key");
    expect(JSON.stringify((await stored(first.id)).result)).not.toContain("synthetic-cookie");
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("transcribing");
      return {
        ...document,
        cues: Array.from({ length: 40 }, (_, index) => ({
          startMs: index * 1000,
          endMs: index * 1000 + 500,
          text: "x".repeat(14000),
        })),
      };
    });
    const oversized = await create(2);
    await service.tick();
    expect((await stored(oversized.id)).result).toBeNull();
    expect((await service.get(actor, oversized.id)).status).toBe("failed");
  });
});
