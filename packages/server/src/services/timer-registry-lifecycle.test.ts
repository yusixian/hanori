import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerRegistry } from "./timer-registry.js";

const BOT_A = "00000000-0000-4000-8000-000000000001";
const BOT_B = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-28T00:00:00.000Z");

interface TimerRow {
  id: string;
  botId: string | null;
  type: string;
  name: string;
  chatId: number | null;
  status: string;
  intervalMs: number | null;
  firesAt: Date | null;
  createdAt: Date;
  firedAt: Date | null;
  meta: Record<string, unknown> | null;
}

function row(
  id: string,
  botId: string,
  firesAt: Date,
  overrides: Partial<TimerRow> = {},
): TimerRow {
  return {
    id,
    botId,
    type: "ai",
    name: `timer ${id}`,
    chatId: 42,
    status: "active",
    intervalMs: null,
    firesAt,
    createdAt: NOW,
    firedAt: null,
    meta: { reason: id, userId: 42 },
    ...overrides,
  };
}

function database(selectResults: TimerRow[][] = [], initialRows: TimerRow[] = []) {
  const persisted = new Map(initialRows.map((entry) => [entry.id, structuredClone(entry)]));
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];

  const applyUpdate = (values: Record<string, unknown>) => {
    const target = [...persisted.values()].find((entry) => {
      if (values.status === "processing") {
        return (
          entry.status === "active" ||
          (entry.status === "processing" &&
            entry.firedAt !== null &&
            entry.firedAt.getTime() <= Date.now() - 60_000)
        );
      }
      if (values.status === "fired") return entry.status === "processing";
      if (values.status === "active") return entry.status === "processing";
      return entry.status === "active";
    });
    if (!target) return [];
    Object.assign(target, values);
    updates.push(values);
    return [{ id: target.id }];
  };
  const db = {
    select: () => ({
      from: () => ({ where: async () => structuredClone(selectResults.shift() ?? []) }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push(values);
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => applyUpdate(values),
        }),
      }),
    }),
  } as unknown as Database;
  return { db, persisted, updates, inserts };
}

function logger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
}

describe("TimerRegistry Bot lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses only one Bot's in-memory timers without changing durable active state", async () => {
    const { db, updates, inserts } = database();
    const registry = new TimerRegistry(db, logger());
    const fireA = vi.fn();
    const fireAfterPauseA = vi.fn();
    const fireB = vi.fn();

    await registry.registerAi({
      timerId: "timer-a",
      botId: BOT_A,
      chatId: 42,
      name: "A",
      seconds: 60,
      handle: setTimeout(fireA, 60_000) as unknown as NodeJS.Timeout,
    });
    await registry.registerAi({
      timerId: "timer-b",
      botId: BOT_B,
      chatId: 42,
      name: "B",
      seconds: 60,
      handle: setTimeout(fireB, 60_000) as unknown as NodeJS.Timeout,
    });

    await expect(registry.pauseBot(BOT_A)).resolves.toBe(1);
    expect(registry.get("timer-a")).toBeUndefined();
    expect(registry.get("timer-b")).toBeDefined();
    expect(updates).toEqual([]);

    await registry.registerAi({
      timerId: "timer-a-after-pause",
      botId: BOT_A,
      chatId: 42,
      name: "A after pause",
      seconds: 60,
      handle: setTimeout(fireAfterPauseA, 60_000) as unknown as NodeJS.Timeout,
    });
    expect(registry.get("timer-a-after-pause")).toBeUndefined();
    expect(inserts).toContainEqual(
      expect.objectContaining({ id: "timer-a-after-pause", botId: BOT_A, status: "active" }),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fireA).not.toHaveBeenCalled();
    expect(fireAfterPauseA).not.toHaveBeenCalled();
    expect(fireB).toHaveBeenCalledOnce();
    registry.destroy();
  });

  it("rebuilds a future timer and claims it before normal delivery", async () => {
    const future = row("future", BOT_A, new Date(NOW.getTime() + 60_000));
    const { db, persisted } = database([[future]], [future]);
    const registry = new TimerRegistry(db, logger());
    const onFire = vi.fn();

    await expect(registry.resumeBot(BOT_A, onFire)).resolves.toEqual({
      recovered: 1,
      cancelled: 0,
      immediate: 0,
    });
    expect(onFire).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(persisted.get("future")?.status).toBe("fired");
    expect(onFire).toHaveBeenCalledWith("future", BOT_A, 42, future.meta, false);
    expect(registry.get("future")).toBeUndefined();
    registry.destroy();
  });

  it("conditionally claims an overdue timer exactly once before delayed delivery", async () => {
    const overdue = row("overdue", BOT_A, new Date(NOW.getTime() - 48 * 60 * 60 * 1000));
    const { db, persisted } = database([[overdue], [overdue]], [overdue]);
    const first = new TimerRegistry(db, logger());
    const second = new TimerRegistry(db, logger());
    const onFire = vi.fn();

    const results = await Promise.all([
      first.resumeBot(BOT_A, onFire),
      second.resumeBot(BOT_A, onFire),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(results.map((result) => result.immediate).sort()).toEqual([0, 1]);
    expect(persisted.get("overdue")?.status).toBe("fired");
    expect(onFire).toHaveBeenCalledOnce();
    expect(onFire).toHaveBeenCalledWith("overdue", BOT_A, 42, overdue.meta, true);
    first.destroy();
    second.destroy();
  });

  it("restores a claimed timer when recovered delivery fails", async () => {
    const overdue = row("retry", BOT_A, new Date(NOW.getTime() - 1_000));
    const { db, persisted, updates } = database([[overdue]], [overdue]);
    const registry = new TimerRegistry(db, logger());

    await expect(
      registry.resumeBot(BOT_A, async () => Promise.reject(new Error("delivery failed"))),
    ).resolves.toEqual({ recovered: 0, cancelled: 0, immediate: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(persisted.get("retry")?.status).toBe("active");
    expect(updates).toContainEqual({ status: "active", firedAt: null });
    expect(registry.get("retry")).toMatchObject({ status: "active" });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(persisted.get("retry")?.status).toBe("active");
    expect(registry.get("retry")).toBeUndefined();
    registry.destroy();
  });

  it("recovers an expired processing lease after a previous process crashed", async () => {
    const crashed = row("crashed", BOT_A, new Date(NOW.getTime() - 120_000), {
      status: "processing",
      firedAt: new Date(NOW.getTime() - 61_000),
    });
    const { db, persisted } = database([[crashed]], [crashed]);
    const registry = new TimerRegistry(db, logger());
    const onFire = vi.fn(async () => {});

    await expect(registry.resumeBot(BOT_A, onFire)).resolves.toMatchObject({ immediate: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(onFire).toHaveBeenCalledOnce();
    expect(persisted.get("crashed")?.status).toBe("fired");
    registry.destroy();
  });

  it("does not hold the Bot lock while an overdue delivery is in flight", async () => {
    const overdue = row("slow", BOT_A, new Date(NOW.getTime() - 1_000));
    const { db } = database([[overdue]], [overdue]);
    const registry = new TimerRegistry(db, logger());
    let releaseDelivery = () => {};
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const onFire = vi.fn(() => delivery);

    await expect(registry.resumeBot(BOT_A, onFire)).resolves.toMatchObject({ immediate: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onFire).toHaveBeenCalledOnce();

    await expect(registry.pauseBot(BOT_A)).resolves.toBe(0);
    releaseDelivery();
    await Promise.resolve();
    registry.destroy();
  });

  it("fails reconciliation when durable timers cannot be loaded", async () => {
    const loadError = new Error("database unavailable");
    const db = {
      select: () => ({
        from: () => ({ where: async () => Promise.reject(loadError) }),
      }),
    } as unknown as Database;
    const log = logger();
    const registry = new TimerRegistry(db, log);

    await expect(registry.resumeBot(BOT_A, vi.fn())).rejects.toBe(loadError);
    expect(log.error).toHaveBeenCalled();
    registry.destroy();
  });
});
