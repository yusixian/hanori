import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
    await connection.client.unsafe(
      "CREATE TABLE public.bots (id uuid PRIMARY KEY, admin_chat_ids json NOT NULL DEFAULT '[]')",
    );
    const migrations = await readdir(new URL("../../../../database/drizzle/", import.meta.url));
    for (const filename of migrations
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) >= 58)
      .sort()) {
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
      "TRUNCATE public.bots, bot_plugin_configs, media_transcription_jobs, video_download_jobs",
    );
    actor = { botId: randomUUID(), chatId: -100, userId: 42, threadId: 9, isAdmin: true };
    otherBotId = randomUUID();
    await connection.client`INSERT INTO public.bots (id,admin_chat_ids) VALUES (${actor.botId}, '[42,43]'::json), (${otherBotId}, '[42,43]'::json)`;
    configuration = fixtureConfig();
    deps = {
      authorize: vi.fn(async (scope) => {
        const [bot] =
          await connection.client`SELECT admin_chat_ids FROM bots WHERE id=${scope.botId}`;
        return Array.isArray(bot?.admin_chat_ids) && bot.admin_chat_ids.includes(scope.userId);
      }),
      requestConfirmation: vi.fn(async () => {}),
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
  async function create(part = 1, scope = actor) {
    const job = await service.create(scope, { sourceUrl: source(part) });
    return service.confirm(scope, job.id);
  }
  async function stored(id: string) {
    const [row] = await connection.client`SELECT * FROM media_transcription_jobs WHERE id=${id}`;
    return row!;
  }

  it("persists a proposal and cost disclosure without downloading or charging until confirmation", async () => {
    const proposal = await service.create(actor, { sourceUrl: source() });
    expect(proposal).toMatchObject({
      status: "pending_confirmation",
      threadId: actor.threadId,
      confirmation: {
        provider: "openai",
        model: "whisper-fixture",
        currency: "USD",
        estimatedCost: 0.01,
        maxCost: 0.01,
      },
    });
    expect(proposal.confirmation!.freeQuota).toContain("unknown");
    expect(deps.requestConfirmation).toHaveBeenCalledExactlyOnceWith(proposal, actor);
    expect(await stored(proposal.id)).toMatchObject({ confirmed_at: null, attempt: 0 });
    await service.tick();
    await makeService().tick();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(await service.get(actor, proposal.id)).toMatchObject({ status: "pending_confirmation" });
    expect(await service.confirm(actor, proposal.id)).toMatchObject({ status: "queued" });
    expect((await stored(proposal.id)).confirmed_at).not.toBeNull();
    expect(deps.execute).not.toHaveBeenCalled();
    await service.tick();
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(await service.get(actor, proposal.id)).toMatchObject({ status: "completed" });
  });

  it("binds confirmation to the requesting administrator, Bot, chat and topic and rechecks revocation", async () => {
    const proposal = await service.create(actor, { sourceUrl: source() });
    for (const scope of [
      { ...actor, botId: otherBotId },
      { ...actor, chatId: -200 },
      { ...actor, userId: 43 },
      { ...actor, threadId: 10 },
      { ...actor, threadId: undefined },
    ])
      await expect(service.confirm(scope, proposal.id)).rejects.toMatchObject({
        code: "not_found",
      });
    await expect(service.confirm({ ...actor, isAdmin: false }, proposal.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await connection.client`UPDATE bots SET admin_chat_ids='[43]'::json WHERE id=${actor.botId}`;
    await expect(service.confirm(actor, proposal.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await stored(proposal.id)).toMatchObject({
      status: "pending_confirmation",
      confirmed_at: null,
    });
    await service.tick();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("expires pending confirmation durably and releases its reservation for a new proposal", async () => {
    const proposal = await service.create(actor, { sourceUrl: source() });
    const expiredConfirmation = {
      ...proposal.confirmation!,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await connection.client`UPDATE media_transcription_jobs SET confirmation=${JSON.stringify(expiredConfirmation)}::json WHERE id=${proposal.id}`;
    const restarted = makeService();
    await expect(restarted.confirm(actor, proposal.id)).rejects.toMatchObject({ code: "expired" });
    await restarted.tick();
    expect(await stored(proposal.id)).toMatchObject({ status: "expired", confirmed_at: null });
    expect(deps.execute).not.toHaveBeenCalled();
    const fresh = await service.create(actor, { sourceUrl: source() });
    expect(fresh.id).not.toBe(proposal.id);
    expect(fresh.status).toBe("pending_confirmation");
  });

  it("deduplicates pending proposals and atomically confirms a repeated concurrent callback across instances", async () => {
    const [proposal, duplicate] = await Promise.all([
      service.create(actor, { sourceUrl: source() }),
      makeService().create(actor, { sourceUrl: source() }),
    ]);
    expect(duplicate.id).toBe(proposal.id);
    expect(proposal.status).toBe("pending_confirmation");
    const other = makeService();
    const confirmed = await Promise.all([
      service.confirm(actor, proposal.id),
      other.confirm(actor, proposal.id),
    ]);
    expect(confirmed.every((job) => job.status === "queued")).toBe(true);
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(1);
    await Promise.all([service.tick(), other.tick()]);
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(await other.confirm(actor, proposal.id)).toMatchObject({ status: "completed" });
    await other.tick();
    expect(deps.execute).toHaveBeenCalledOnce();
  });

  it("requires a new proposal when its provider credential revision changes before confirmation", async () => {
    configuration!.providerAccount = "account-fixture";
    configuration!.providerRevision = 1;
    const proposal = await service.create(actor, { sourceUrl: source() });
    configuration = { ...configuration!, providerRevision: 2 };
    await expect(service.confirm(actor, proposal.id)).rejects.toMatchObject({
      code: "configuration_required",
    });
    await service.tick();
    expect(deps.execute).not.toHaveBeenCalled();
    const fresh = await service.create(actor, { sourceUrl: source() });
    expect(fresh.id).not.toBe(proposal.id);
    expect(await stored(fresh.id)).toMatchObject({ provider_revision: 2 });
    expect(await service.confirm(actor, fresh.id)).toMatchObject({ status: "queued" });
  });

  it("supports a zero-price Groq account but still waits for transfer confirmation", async () => {
    configuration = {
      ...fixtureConfig(),
      asr: { ...fixtureConfig().asr, provider: "groq", model: "whisper-large-v3-turbo" },
      providerAccount: "groq-free-fixture",
      limits: { ...fixtureConfig().limits, costPerMinute: 0, maxPerJobCost: 0 },
    };
    const proposal = await service.create(actor, { sourceUrl: source() });
    expect(proposal).toMatchObject({
      status: "pending_confirmation",
      confirmation: { provider: "groq", estimatedCost: 0, maxCost: 0, currency: "USD" },
    });
    expect(Number((await stored(proposal.id)).estimated_cost)).toBe(0);
    await service.tick();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(await service.confirm(actor, proposal.id)).toMatchObject({ status: "queued" });
    await service.tick();
    expect(deps.execute).toHaveBeenCalledOnce();
  });

  it("reserves Groq's minimum ten billed seconds for a short paid clip", async () => {
    configuration = {
      ...fixtureConfig(),
      asr: { ...fixtureConfig().asr, provider: "groq", model: "whisper-large-v3-turbo" },
      providerAccount: "groq-paid-fixture",
      limits: { ...fixtureConfig().limits, costPerMinute: 0.06, maxPerJobCost: 0.005 },
    };
    vi.mocked(deps.inspect).mockResolvedValue({
      canonicalUrl: source(),
      bvid,
      part: 1,
      title: "Short fixture",
      durationSeconds: 2,
      hasSubtitles: false,
    });
    await expect(service.create(actor, { sourceUrl: source() })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    expect(deps.requestConfirmation).not.toHaveBeenCalled();
    configuration.limits.maxPerJobCost = 0.02;
    const proposal = await service.create(actor, { sourceUrl: source() });
    expect(proposal.confirmation?.estimatedCost).toBeCloseTo(0.01);
    expect(proposal.confirmation?.maxCost).toBeCloseTo(0.011);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("prefers a configured free allowance and discloses a paid proposal when the remainder cannot cover the whole clip", async () => {
    const paid: MediaJobConfiguration = {
      ...fixtureConfig(),
      providerAccount: "paid-account",
      currency: "CNY",
    };
    const free: MediaJobConfiguration = {
      ...fixtureConfig(),
      providerAccount: "free-account",
      currency: "USD",
      asr: { ...fixtureConfig().asr, provider: "groq", model: "whisper-large-v3-turbo" },
      freeAllowanceMinutes: 1.5,
      freeAllowancePeriod: "month",
      freeQuota: "Only this deployment's ledger is known; external balance unknown",
      limits: { ...fixtureConfig().limits, costPerMinute: 0 },
    };
    deps.configurations = vi.fn(async () => [paid, free]);
    deps.configuration = vi.fn(async (_botId, account) =>
      account === free.providerAccount ? free : paid,
    );
    const first = await service.create(actor, { sourceUrl: source(1) });
    expect(first.confirmation).toMatchObject({
      provider: "groq",
      estimatedCost: 0,
      currency: "USD",
    });
    await service.confirm(actor, first.id);
    const second = await service.create(actor, { sourceUrl: source(2) });
    expect(second).toMatchObject({
      status: "pending_confirmation",
      confirmation: { provider: "openai", estimatedCost: 0.01, currency: "CNY" },
    });
    expect(await stored(second.id)).toMatchObject({
      provider_account: "paid-account",
      confirmed_at: null,
    });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it.each(["cost", "minutes"])(
    "serializes one shared account's monthly %s across concurrent Bots",
    async (limit) => {
      configuration!.providerAccount = "shared-monthly-account";
      if (limit === "cost") configuration!.limits.accountMonthlyCost = 0.015;
      else configuration!.limits.accountMonthlyMinutes = 1;
      const other = makeService();
      const results = await Promise.allSettled([
        service.create(actor, { sourceUrl: source(1) }),
        other.create({ ...actor, botId: otherBotId }, { sourceUrl: source(2) }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "quota_exceeded" },
      });
      const rows =
        await connection.client`SELECT bot_id,estimated_cost FROM media_transcription_jobs`;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.estimated_cost)).toBe(0.01);
      expect(deps.execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { scope: "user", budget: "cost" },
    { scope: "user", budget: "minutes" },
    { scope: "bot", budget: "cost" },
    { scope: "bot", budget: "minutes" },
  ])(
    "keeps monthly $scope $budget budgets within their declared scope",
    async ({ scope, budget }) => {
      configuration!.providerAccount = "scope-budget-account";
      if (scope === "user") {
        if (budget === "cost") configuration!.limits.maxMonthlyCost = 0.015;
        else configuration!.limits.monthlyMinutes = 1;
      } else {
        if (budget === "cost") configuration!.limits.botMaxMonthlyCost = 0.015;
        else configuration!.limits.botMonthlyMinutes = 1;
      }
      await create(1);
      await expect(create(2)).rejects.toMatchObject({ code: "quota_exceeded" });
      const anotherAdmin = { ...actor, userId: 43 };
      if (scope === "user")
        expect(await create(3, anotherAdmin)).toMatchObject({ status: "queued" });
      else {
        await expect(create(3, anotherAdmin)).rejects.toMatchObject({ code: "quota_exceeded" });
        expect(await create(4, { ...anotherAdmin, botId: otherBotId })).toMatchObject({
          status: "queued",
        });
      }
    },
  );

  it("keeps CNY and USD cost ledgers separate at exact daily and monthly budget boundaries", async () => {
    configuration!.providerAccount = "currency-account";
    configuration!.currency = "USD";
    configuration!.limits.maxDailyCost = 0.01;
    configuration!.limits.maxMonthlyCost = 0.01;
    configuration!.limits.accountDailyCost = 0.01;
    configuration!.limits.accountMonthlyCost = 0.01;
    const usd = await create(1);
    await service.tick();
    expect(await service.get(actor, usd.id)).toMatchObject({ status: "completed" });
    configuration = { ...configuration!, providerRevision: 2, currency: "CNY" };
    const cny = await create(2);
    expect(usd.confirmation?.currency).toBe("USD");
    expect(cny.confirmation?.currency).toBe("CNY");
    await expect(create(3)).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(2);
  });

  it.each([
    { period: "day", before: "2026-10-02T23:59:59.000Z", after: "2026-10-03T00:00:02.000Z" },
    { period: "month", before: "2026-09-30T23:59:59.000Z", after: "2026-10-01T00:00:02.000Z" },
  ])(
    "charges a proposal confirmed across a UTC $period boundary to its confirmation period",
    async ({ period, before, after }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(before));
      configuration!.providerAccount = "rollover-account";
      if (period === "day") configuration!.limits.accountDailyCost = 0.01;
      else configuration!.limits.accountMonthlyCost = 0.01;
      const proposal = await service.create(actor, { sourceUrl: source(1) });
      vi.setSystemTime(new Date(after));
      await service.confirm(actor, proposal.id);
      const [confirmed] =
        await connection.client`SELECT to_char(confirmed_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_iso FROM media_transcription_jobs WHERE id=${proposal.id}`;
      expect(confirmed!.confirmed_iso).toBe(after);
      await expect(
        service.create({ ...actor, botId: otherBotId }, { sourceUrl: source(2) }),
      ).rejects.toMatchObject({ code: "quota_exceeded" });
      expect(deps.execute).not.toHaveBeenCalled();
    },
  );

  it("serializes an account's daily cost budget across different Bots", async () => {
    configuration!.providerAccount = "daily-shared-account";
    configuration!.limits.accountDailyCost = 0.015;
    const results = await Promise.allSettled([
      service.create(actor, { sourceUrl: source(1) }),
      makeService().create({ ...actor, botId: otherBotId }, { sourceUrl: source(2) }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "quota_exceeded" },
    });
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(1);
  });

  it.each(["actor", "bot"])(
    "retains a submitted provider task's paid reservation when its queued recovery is cancelled through %s",
    async (scope) => {
      configuration!.limits.dailyJobs = 1;
      const job = await create();
      await connection.client`UPDATE media_transcription_jobs SET provider_task_id='fixture-recovery-task',provider_submitted_at=${new Date().toISOString()} WHERE id=${job.id}`;
      deps.resume = vi.fn(async () => document);
      if (scope === "actor")
        expect(await service.cancel(actor, job.id)).toMatchObject({
          status: "failed",
          error: "provider_cancellation_unavailable",
        });
      else await service.cancelForBot(actor.botId);
      await service.tick();
      expect(await service.get(actor, job.id)).toMatchObject({
        status: "failed",
        error: "provider_cancellation_unavailable",
        cancelRequested: true,
      });
      await expect(create(2)).rejects.toMatchObject({ code: "quota_exceeded" });
      expect(deps.execute).not.toHaveBeenCalled();
      expect(deps.resume).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit administrator forceAsr proposal and confirmation to override existing subtitles", async () => {
    const inspect = deps.inspect;
    deps.inspect = vi.fn(async (...args: Parameters<MediaJobDependencies["inspect"]>) => ({
      ...(await inspect(...args)),
      hasSubtitles: true,
    }));
    await expect(service.create(actor, { sourceUrl: source() })).rejects.toMatchObject({
      code: "subtitles_available",
    });
    await expect(
      service.create({ ...actor, isAdmin: false }, { sourceUrl: source(), forceAsr: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const proposal = await service.create(actor, { sourceUrl: source(), forceAsr: true });
    expect(proposal.status).toBe("pending_confirmation");
    expect(await stored(proposal.id)).toMatchObject({ force_asr: true, confirmed_at: null });
    await service.tick();
    expect(deps.execute).not.toHaveBeenCalled();
    await service.confirm(actor, proposal.id);
    await service.tick();
    expect(deps.execute).toHaveBeenCalledOnce();
  });

  it("checks for newly available platform subtitles again when a proposal is confirmed", async () => {
    const proposal = await service.create(actor, { sourceUrl: source() });
    const inspect = deps.inspect;
    deps.inspect = vi.fn(async (...args: Parameters<MediaJobDependencies["inspect"]>) => ({
      ...(await inspect(...args)),
      hasSubtitles: true,
    }));
    await expect(service.confirm(actor, proposal.id)).rejects.toMatchObject({
      code: "subtitles_available",
    });
    expect(await stored(proposal.id)).toMatchObject({
      status: "pending_confirmation",
      confirmed_at: null,
    });
    await service.tick();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("does not create or charge a job when subtitle inspection fails or its result is invalid", async () => {
    vi.mocked(deps.inspect).mockRejectedValueOnce(new Error("private caption API credential"));
    await expect(service.create(actor, { sourceUrl: source() })).rejects.toMatchObject({
      code: "invalid_source",
    });
    vi.mocked(deps.inspect).mockResolvedValueOnce({
      canonicalUrl: source(),
      bvid,
      part: 1,
      title: "Fixture",
      durationSeconds: 60,
      hasSubtitles: undefined as unknown as boolean,
    });
    await expect(service.create(actor, { sourceUrl: source() })).rejects.toMatchObject({
      code: "invalid_source",
    });
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(0);
    expect(deps.requestConfirmation).not.toHaveBeenCalled();
    await service.tick();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("resumes a known submitted provider task after restart without uploading or submitting it again", async () => {
    const known = await create(1);
    const unknown = await create(2);
    const expiredLease = new Date(Date.now() - 1000).toISOString();
    const submitted = new Date(Date.now() - 2000).toISOString();
    await connection.client`UPDATE media_transcription_jobs SET status='transcribing',progress=70,attempt=2,provider_task_id='fixture-cloud-task',provider_submitted_at=${submitted},lease_id=${randomUUID()},lease_expires_at=${expiredLease} WHERE id=${known.id}`;
    await connection.client`UPDATE media_transcription_jobs SET status='transcribing',progress=70,attempt=1,provider_submitted_at=${submitted},lease_id=${randomUUID()},lease_expires_at=${expiredLease} WHERE id=${unknown.id}`;
    deps.resume = vi.fn(async (row) => {
      expect(row.providerTaskId).toBe("fixture-cloud-task");
      return document;
    });
    await service.close();
    const restarted = makeService();
    await restarted.tick();
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(await restarted.get(actor, known.id)).toMatchObject({ status: "completed" });
    expect(await restarted.get(actor, unknown.id)).toMatchObject({
      status: "failed",
      error: "interrupted_transcription",
    });
    await restarted.tick();
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("marks provider cancellation unavailable after stopping local transcription waiting", async () => {
    const entered = deferred<AbortSignal>();
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("transcribing");
      await options.onProviderTask?.("fixture-billable-task");
      entered.resolve(options.signal);
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
      return document;
    });
    const job = await create();
    const execution = service.tick();
    const signal = await entered.promise;
    await service.cancel(actor, job.id);
    await execution;
    expect(signal.aborted).toBe(true);
    expect(await service.get(actor, job.id)).toMatchObject({
      status: "failed",
      error: "provider_cancellation_unavailable",
      cancelRequested: true,
    });
    expect((await stored(job.id)).provider_task_id).toBe("fixture-billable-task");
    expect(deps.notify).not.toHaveBeenCalled();
    await makeService().tick();
    expect(deps.execute).toHaveBeenCalledOnce();
  });

  it("resumes a known provider task after normal shutdown without a second paid submission", async () => {
    const entered = deferred<void>();
    deps.resume = vi.fn(async (row) => {
      expect(row.providerTaskId).toBe("fixture-shutdown-task");
      return document;
    });
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("transcribing");
      await options.onProviderTask?.("fixture-shutdown-task");
      entered.resolve();
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
      return document;
    });
    const job = await create();
    const execution = service.tick();
    await entered.promise;
    await service.close();
    await execution;
    expect(await service.get(actor, job.id)).toMatchObject({ status: "queued" });
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.resume).not.toHaveBeenCalled();
    const restarted = makeService();
    await restarted.tick();
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(await restarted.get(actor, job.id)).toMatchObject({ status: "completed" });
  });

  it("waits for the returned provider task ID to be persisted before finishing shutdown", async () => {
    deps.resume = vi.fn(async () => document);
    deps.execute = vi.fn(async (_row, _config, options) => {
      await options.onStage("transcribing");
      await options.onProviderTask?.("fixture-durable-shutdown-task");
      options.signal.throwIfAborted();
      return document;
    });
    const job = await create();
    const blocker = createDb(url);
    let execution: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    await connection.client
      .unsafe(`CREATE FUNCTION hold_provider_task_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_task_id IS DISTINCT FROM OLD.provider_task_id AND NEW.provider_task_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(134763785); END IF; RETURN NEW; END $$;
      CREATE TRIGGER hold_provider_task_update BEFORE UPDATE ON media_transcription_jobs FOR EACH ROW EXECUTE FUNCTION hold_provider_task_update();`);
    try {
      await blocker.client.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(134763785)");
        execution = service.tick();
        const deadline = Date.now() + 3000;
        let updating = false;
        while (Date.now() < deadline) {
          const [waiting] =
            await connection.client`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%provider_task_id%'`;
          if (waiting!.count >= 1) {
            updating = true;
            break;
          }
          await delay(10);
        }
        expect(updating).toBe(true);
        let closed = false;
        closing = service.close().then(() => {
          closed = true;
        });
        await delay(20);
        expect(closed).toBe(false);
      });
      await closing;
      await execution;
      expect(await stored(job.id)).toMatchObject({
        status: "queued",
        provider_task_id: "fixture-durable-shutdown-task",
      });
      await makeService().tick();
      expect(deps.resume).toHaveBeenCalledOnce();
      expect(deps.execute).toHaveBeenCalledOnce();
      expect(await service.get(actor, job.id)).toMatchObject({ status: "completed" });
    } finally {
      await closing;
      await execution;
      await blocker.client.end();
      await connection.client.unsafe(
        "DROP TRIGGER hold_provider_task_update ON media_transcription_jobs; DROP FUNCTION hold_provider_task_update()",
      );
    }
  });

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
    "releases pre-submission cancellation and retains %s reservations for failed work",
    async (limit) => {
      if (limit === "jobs") configuration!.limits.dailyJobs = 1;
      if (limit === "minutes") configuration!.limits.dailyMinutes = 1;
      if (limit === "cost") configuration!.limits.maxDailyCost = 0.01;
      const first = await create();
      await service.cancel(actor, first.id);
      expect(await create(2)).toMatchObject({ status: "queued" });
      await connection.client`UPDATE media_transcription_jobs SET status='failed' WHERE id=${first.id}`;
      await expect(create(3)).rejects.toMatchObject({ code: "quota_exceeded" });
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
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, dailyJobs: 1.5 } },
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, dailyMinutes: NaN } },
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, maxDurationSeconds: 0 } },
      { ...fixtureConfig(), limits: { ...fixtureConfig().limits, costPerMinute: 0 } },
    ]) {
      configuration = invalid;
      await expect(create()).rejects.toMatchObject({ code: "configuration_required" });
    }
    expect(deps.inspect).not.toHaveBeenCalled();
  });

  it("queues above the former limits while enforcing the owner's larger job quota", async () => {
    configuration!.limits = {
      maxDurationSeconds: 1200,
      dailyJobs: 12,
      dailyMinutes: 120,
      costPerMinute: 101,
      maxDailyCost: 2000,
    };
    for (let part = 1; part <= 12; part++) expect((await create(part)).status).toBe("queued");
    await expect(create(13)).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(12);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("accepts longer configured tasks but rejects media beyond the owner's duration before execution", async () => {
    configuration!.limits.maxDurationSeconds = 1200;
    configuration!.limits.dailyMinutes = Number.MAX_SAFE_INTEGER;
    const inspect = deps.inspect;
    let durationSeconds = 1201;
    deps.inspect = vi.fn(async (...args: Parameters<MediaJobDependencies["inspect"]>) => ({
      ...(await inspect(...args)),
      durationSeconds,
    }));
    await expect(create()).rejects.toMatchObject({ code: "duration_limit" });
    expect(await connection.client`SELECT id FROM media_transcription_jobs`).toHaveLength(0);
    await service.tick();
    expect(deps.execute).not.toHaveBeenCalled();
    durationSeconds = 900;
    expect(await create()).toMatchObject({ status: "queued", durationSeconds: 900 });
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
