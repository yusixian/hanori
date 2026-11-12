import { bots } from "@cos-tool-bot/database";
import type { Database } from "@cos-tool-bot/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSummaryService } from "./chat-summary-service.js";
import type { SummaryRunner } from "./summary-runner.js";

const configRow = {
  id: 7,
  botId: "bot-a",
  chatId: -1001,
  isActive: true,
  scheduleHour: null,
  scheduleMinute: null,
  windowHours: 24,
  customPrompt: null,
  providerId: null,
  modelId: null,
  maxMessages: null,
  cooldownSeconds: 60,
  accessMode: "all",
  lastScheduledAt: null,
  lastManualAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function collectPrimitiveValues(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => collectPrimitiveValues(entry, seen));
}

function createService(row: typeof configRow | null) {
  let claimed = false;
  const conditions: unknown[] = [];
  const update = vi.fn(() => ({
    set: (values: unknown) => {
      void values;
      return {
        where: (condition: unknown) => {
          conditions.push(condition);
          return {
            returning: async () => {
              if (claimed) return [];
              claimed = true;
              return [{ id: row?.id }];
            },
          };
        },
      };
    },
  }));
  const db = {
    execute: vi.fn().mockResolvedValue([]),
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === bots ? [{ adminChatIds: [42] }] : row ? [row] : []),
      }),
    }),
    update,
  } as unknown as Database;
  const run = vi.fn(async (_opts: unknown) => ({
    ok: true as const,
    summaryId: 1,
    contentHtml: "summary",
  }));
  const service = new ChatSummaryService(
    db,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger,
    { run } as unknown as SummaryRunner,
    vi.fn(async () => undefined),
    () => true,
    async () => ({ enabled: true }),
  );
  return { service, run, update, conditions };
}

const manualOptions = {
  botId: "bot-a",
  chatId: -1001,
  userId: 42,
  mode: { kind: "default" as const },
  skipSend: true,
};

describe("ChatSummaryService manual cooldown", () => {
  it("allows at most one concurrent runner through an atomic claim", async () => {
    const { service, run, conditions } = createService({ ...configRow, lastManualAt: null });

    const results = await Promise.all([
      service.triggerManual(manualOptions),
      service.triggerManual(manualOptions),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.reason === "cooldown")).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      const values = collectPrimitiveValues(condition);
      expect(values).toContain("bot-a");
      expect(values).toContain(-1001);
      expect(values).toContain(7);
    }
  });

  it("keeps the no-config path free of cooldown claims", async () => {
    const { service, run, update } = createService(null);

    const results = await Promise.all([
      service.triggerManual(manualOptions),
      service.triggerManual(manualOptions),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bypass updates the timestamp with bot and chat scope before running", async () => {
    const { service, run, conditions } = createService({ ...configRow, lastManualAt: null });

    await expect(
      service.triggerManual({ ...manualOptions, bypassCooldown: true }),
    ).resolves.toMatchObject({
      ok: true,
    });

    expect(run).toHaveBeenCalledTimes(1);
    const values = collectPrimitiveValues(conditions[0]);
    expect(values).toContain("bot-a");
    expect(values).toContain(-1001);
    expect(values).toContain(7);
  });
});

it.each(["config", "claim", "runner"])(
  "continues scheduled chats after one %s failure",
  async (failureStage) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = new Error("temporary failure");
    const rows = [
      { ...configRow, scheduleHour: 0, scheduleMinute: 1 },
      { ...configRow, id: 8, botId: "bot-b", chatId: -1002, scheduleHour: 0, scheduleMinute: 1 },
    ];
    const claim = vi.fn().mockResolvedValue([{ id: 8 }]);
    if (failureStage === "claim") claim.mockRejectedValueOnce(failure);
    const db = {
      execute: vi.fn().mockResolvedValue([]),
      select: () => ({ from: () => ({ where: async () => rows }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: claim }) }) }),
    } as unknown as Database;
    const run = vi.fn().mockResolvedValue({ ok: true, contentHtml: "summary" });
    if (failureStage === "runner") run.mockRejectedValueOnce(failure);
    const getConfig = vi.fn().mockResolvedValue({ enabled: true, timezone: "UTC" });
    if (failureStage === "config") getConfig.mockRejectedValueOnce(failure);
    const send = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const service = new ChatSummaryService(
      db,
      logger as unknown as Logger,
      { run } as unknown as SummaryRunner,
      send,
      () => true,
      getConfig,
    );
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(send).toHaveBeenCalledExactlyOnceWith("bot-b", -1002, "summary");
      expect(logger.error).toHaveBeenCalledWith(
        { err: failure, botId: "bot-a", chatId: -1001 },
        "Scheduled summary failed",
      );
      if (failureStage === "runner") expect(claim).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  },
);

it("does not start a second summary when overlapping schedulers lose the database claim", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const row = { ...configRow, scheduleHour: 0, scheduleMinute: 1 };
  let resolveSelected!: (rows: (typeof row)[]) => void;
  const selected = new Promise<(typeof row)[]>((resolve) => {
    resolveSelected = resolve;
  });
  let resolveCompleted!: (result: { ok: true; contentHtml: string }) => void;
  const completed = new Promise<{ ok: true; contentHtml: string }>((resolve) => {
    resolveCompleted = resolve;
  });
  let reads = 0;
  let claimed = false;
  const conditions: unknown[] = [];
  const claim = vi.fn(async () => {
    if (claimed) return [];
    claimed = true;
    return [{ id: row.id }];
  });
  const db = {
    execute: vi.fn().mockResolvedValue([]),
    select: () => ({
      from: () => ({
        where: () => {
          if (++reads === 2) resolveSelected([row]);
          return selected;
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (condition: unknown) => {
          conditions.push(condition);
          return { returning: claim };
        },
      }),
    }),
  } as unknown as Database;
  const run = vi.fn(() => completed);
  const send = vi.fn().mockResolvedValue(undefined);
  const services = [0, 1].map(
    () =>
      new ChatSummaryService(
        db,
        { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger,
        { run } as unknown as SummaryRunner,
        send,
        () => true,
        async () => ({ enabled: true, timezone: "UTC" }),
      ),
  );
  try {
    services.forEach((service) => service.start());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    for (const condition of conditions) {
      const query = new PgDialect().sqlToQuery(condition as SQL);
      expect(query.sql).toContain('"summary_configs"."id" = $1');
      expect(query.sql).toContain('"summary_configs"."last_scheduled_at" is null');
      expect(query.sql).toContain('"summary_configs"."last_scheduled_at" < $2');
      expect(query.params).toEqual([row.id, "2025-12-31T01:01:00.000Z"]);
    }
    resolveCompleted({ ok: true, contentHtml: "summary" });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledExactlyOnceWith(row.botId, row.chatId, "summary");
  } finally {
    resolveCompleted({ ok: true, contentHtml: "summary" });
    services.forEach((service) => service.stop());
    vi.useRealTimers();
  }
});

describe("ChatSummaryService close", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function lifecycleFixture() {
    const rows = [
      { ...configRow, scheduleHour: 0, scheduleMinute: 1 },
      { ...configRow, id: 8, botId: "bot-b", chatId: -1002, scheduleHour: 0, scheduleMinute: 1 },
    ];
    const query = vi.fn().mockResolvedValue(rows);
    const claim = vi.fn().mockResolvedValue([{ id: 7 }]);
    const getConfig = vi.fn().mockResolvedValue({ enabled: true, timezone: "UTC" });
    const run = vi.fn().mockResolvedValue({ ok: true, summaryId: 1, contentHtml: "summary" });
    const send = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const db = {
      execute: vi.fn().mockResolvedValue([]),
      select: () => ({ from: () => ({ where: query }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: claim }) }) }),
    } as unknown as Database;
    const service = new ChatSummaryService(
      db,
      logger as unknown as Logger,
      { run } as unknown as SummaryRunner,
      send,
      () => true,
      getConfig,
    );
    return { service, query, claim, getConfig, run, send, logger };
  }

  it.each(["config", "claim", "runner", "send"])(
    "drains the current scheduled %s and skips subsequent chats",
    async (phase) => {
      const { service, claim, getConfig, run, send } = lifecycleFixture();
      let release!: (value: unknown) => void;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const pending =
        phase === "config"
          ? getConfig
          : phase === "claim"
            ? claim
            : phase === "runner"
              ? run
              : send;
      pending.mockReturnValueOnce(gate);
      service.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pending).toHaveBeenCalledOnce();
      let closed = false;
      const close = service.close();
      expect(service.close()).toBe(close);
      void close.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release(
        phase === "config"
          ? { enabled: true, timezone: "UTC" }
          : phase === "claim"
            ? [{ id: 7 }]
            : phase === "runner"
              ? { ok: true, contentHtml: "summary" }
              : undefined,
      );
      await close;
      expect(claim).toHaveBeenCalledTimes(phase === "config" ? 0 : 1);
      expect(run).toHaveBeenCalledTimes(phase === "config" ? 0 : 1);
      expect(send).toHaveBeenCalledTimes(phase === "config" ? 0 : 1);
      service.start();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "waits for manual send while retaining its existing failure result (fails: %s)",
    async (fails) => {
      const { service, send, run, logger } = lifecycleFixture();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      send.mockImplementationOnce(async () => {
        await pending;
        if (fails) throw new Error("send failed");
      });
      const manual = service.triggerManual({ ...manualOptions, skipSend: false });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      let closed = false;
      const close = service.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      await expect(service.triggerManual(manualOptions)).resolves.toEqual({
        ok: false,
        reason: "disabled",
      });
      release();
      await expect(manual).resolves.toMatchObject({
        ok: true,
        summaryId: 1,
        contentHtml: "summary",
      });
      await close;
      expect(run).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledTimes(fails ? 1 : 0);
    },
  );

  it("preserves stop/start scheduling until terminal close", async () => {
    const { service, query } = lifecycleFixture();
    query.mockResolvedValue([]);
    service.start();
    service.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).not.toHaveBeenCalled();
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledOnce();
    await service.close();
    service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledOnce();
  });
  it.each([false, true])("waits for caller-owned Telegram delivery (fails: %s)", async (fails) => {
    const { service, send } = lifecycleFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = vi.fn(async () => {
      await gate;
      if (fails) throw new Error("Telegram failed");
    });
    const manual = service.triggerManual({ ...manualOptions, deliver });
    const result = fails
      ? expect(manual).rejects.toThrow("Telegram failed")
      : expect(manual).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledExactlyOnceWith("summary"));
    let closed = false;
    const close = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await result;
    await close;
    expect(send).not.toHaveBeenCalled();
  });
});

it("owner previews and approved task summaries leave manual cooldown untouched and do not deliver", async () => {
  const { service, run, update } = createService({ ...configRow, accessMode: "admin" });
  const request = {
    since: "2026-01-01T00:00:00Z",
    until: "2026-01-02T00:00:00Z",
    maxMessages: 1000,
    instructions: "decisions",
  };
  expect(
    await service.summarize({ botId: "bot-a", chatId: -1001, userId: 0, owner: true, request }),
  ).toMatchObject({ ok: true });
  expect(update).not.toHaveBeenCalled();
  const approvedWindow = {
    since: new Date(request.since),
    until: new Date(request.until),
    limit: 1000,
  };
  expect(
    await service.summarize({
      botId: "bot-a",
      chatId: -1001,
      userId: 0,
      approvedWindow,
      request: { instructions: "approved" },
    }),
  ).toMatchObject({ ok: true });
  expect(update).not.toHaveBeenCalled();
  expect(run.mock.calls[1]?.[0]).toMatchObject({
    window: approvedWindow,
    originalMessagesOnly: true,
    instructions: "approved",
  });
});
it("tool callers cannot bypass summary admin access or broaden an approved range", async () => {
  const { service, run } = createService({ ...configRow, accessMode: "admin" });
  expect(
    await service.summarize({ botId: "bot-a", chatId: -1001, userId: 43, request: {} }),
  ).toEqual({
    ok: false,
    reason: "no_access",
    summaryId: undefined,
    contentRaw: undefined,
    messageCount: undefined,
    coverage: undefined,
  });
  expect(run).not.toHaveBeenCalled();
  expect(
    await service.summarize({
      botId: "bot-a",
      chatId: -1001,
      userId: 42,
      approvedWindow: { since: new Date(0), until: new Date(1), limit: 10 },
      request: { mode: { kind: "recent", count: 1000 } },
    }),
  ).toEqual({ ok: false, reason: "outside_approved_scope" });
});
