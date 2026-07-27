import type { Database } from "@cos-tool-bot/database";
import type { BotStatus } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  BotLifecycleError,
  BotLifecycleService,
  type BotLifecycleRuntime,
} from "./bot-lifecycle-service.js";

const BOT_A = "00000000-0000-4000-8000-000000000001";
const BOT_B = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = 42;

function database(
  desiredReads: Array<boolean | undefined>,
  events: string[] = [],
  options: { failTransaction?: Error; readDesired?: boolean } = {},
) {
  const audits: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const lockedSelect = () => ({
    from: () => ({
      where: () => ({
        for: async () => {
          events.push("db:read");
          const desired = desiredReads.shift();
          return desired === undefined ? [] : [{ isActive: desired }];
        },
      }),
    }),
  });
  const tx = {
    select: lockedSelect,
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
          events.push("db:update");
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        audits.push(values);
        events.push("db:audit");
      },
    }),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: async () =>
          options.readDesired === undefined ? [] : [{ isActive: options.readDesired }],
      }),
    }),
    transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => {
      events.push("db:begin");
      if (options.failTransaction) throw options.failTransaction;
      const result = await operation(tx);
      events.push("db:commit");
      return result;
    },
  } as unknown as Database;
  return { db, audits, updates };
}

function runtime(
  statuses: Record<string, BotStatus>,
  events: string[] = [],
  overrides: Partial<Pick<BotLifecycleRuntime, "start" | "stop" | "restart">> = {},
) {
  const current = new Map(Object.entries(statuses));
  const start = vi.fn(async (botId: string) => {
    events.push(`runtime:start:${botId}`);
    await overrides.start?.(botId);
    current.set(botId, "running");
  });
  const stop = vi.fn(async (botId: string) => {
    events.push(`runtime:stop:${botId}`);
    await overrides.stop?.(botId);
    current.set(botId, "stopped");
  });
  const restart = vi.fn(async (botId: string) => {
    events.push(`runtime:restart:${botId}`);
    await overrides.restart?.(botId);
    current.set(botId, "running");
  });
  return {
    value: {
      getStatus: (botId: string) => current.get(botId) ?? "stopped",
      start,
      stop,
      restart,
    } satisfies BotLifecycleRuntime,
    start,
    stop,
    restart,
  };
}

describe("BotLifecycleService", () => {
  it("reads durable desired state separately from runtime reconciliation", async () => {
    const { db } = database([], [], { readDesired: true });
    const running = runtime({ [BOT_A]: "running" });
    const service = new BotLifecycleService(db, running.value);

    await expect(service.read(BOT_A)).resolves.toEqual({
      desiredActive: true,
      runtimeStatus: "running",
      reconciled: true,
    });
  });

  it("commits desired enable and audit before starting runtime", async () => {
    const events: string[] = [];
    const { db, audits, updates } = database([false], events);
    const stopped = runtime({ [BOT_A]: "stopped" }, events);
    const service = new BotLifecycleService(
      db,
      stopped.value,
      () => new Date("2026-07-28T00:00:00.000Z"),
    );

    await expect(
      service.enable({ botId: BOT_A, actorTelegramUserId: ACTOR_ID }),
    ).resolves.toMatchObject({
      desiredActive: true,
      runtimeStatus: "running",
      reconciled: true,
      persisted: true,
      applied: true,
    });
    expect(events.indexOf("db:commit")).toBeLessThan(events.indexOf(`runtime:start:${BOT_A}`));
    expect(updates).toEqual([{ isActive: true }]);
    expect(audits[0]).toMatchObject({
      actorTelegramUserId: ACTOR_ID,
      actorRole: "admin",
      capability: "bot.lifecycle.manage",
      action: "bot.lifecycle.enabled",
      previousSummary: { desiredActive: false },
      nextSummary: { desiredActive: true, desiredChanged: true },
    });
  });

  it("keeps desired=true and returns a safe unreconciled result when start fails", async () => {
    const { db, updates } = database([false]);
    const stopped = runtime({ [BOT_A]: "stopped" }, [], {
      start: async () => Promise.reject(new Error("secret runtime detail")),
    });
    const service = new BotLifecycleService(db, stopped.value);

    const result = await service.enable({ botId: BOT_A, actorTelegramUserId: ACTOR_ID });

    expect(updates).toEqual([{ isActive: true }]);
    expect(result).toEqual({
      desiredActive: true,
      runtimeStatus: "stopped",
      reconciled: false,
      persisted: true,
      applied: false,
      errorCode: "start_failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret runtime detail");
  });

  it("keeps desired=false and returns unreconciled when stop fails", async () => {
    const { db, updates } = database([true]);
    const running = runtime({ [BOT_A]: "running" }, [], {
      stop: async () => Promise.reject(new Error("private stop failure")),
    });
    const service = new BotLifecycleService(db, running.value);

    await expect(service.disable({ botId: BOT_A, actorTelegramUserId: ACTOR_ID })).resolves.toEqual(
      {
        desiredActive: false,
        runtimeStatus: "running",
        reconciled: false,
        persisted: true,
        applied: false,
        errorCode: "stop_failed",
      },
    );
    expect(updates).toEqual([{ isActive: false }]);
  });

  it("reconciles repeated enable and disable requests against runtime", async () => {
    const { db } = database([true, false]);
    const current = runtime({ [BOT_A]: "stopped", [BOT_B]: "running" });
    const service = new BotLifecycleService(db, current.value);

    await service.enable({ botId: BOT_A, actorTelegramUserId: ACTOR_ID });
    await service.disable({ botId: BOT_B, actorTelegramUserId: ACTOR_ID });

    expect(current.start).toHaveBeenCalledWith(BOT_A);
    expect(current.stop).toHaveBeenCalledWith(BOT_B);
  });

  it("rejects restart while desired=false without touching runtime", async () => {
    const { db, audits, updates } = database([false]);
    const stopped = runtime({ [BOT_A]: "stopped" });
    const service = new BotLifecycleService(db, stopped.value);

    await expect(
      service.restart({ botId: BOT_A, actorTelegramUserId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "desired_inactive" } satisfies Partial<BotLifecycleError>);
    expect(stopped.restart).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(audits[0]).toMatchObject({
      action: "bot.lifecycle.restart-rejected",
      outcome: "failed",
    });
  });

  it("restarts a desired-active Bot without changing desired state", async () => {
    const { db, audits, updates } = database([true]);
    const running = runtime({ [BOT_A]: "running" });
    const service = new BotLifecycleService(db, running.value);

    await expect(
      service.restart({ botId: BOT_A, actorTelegramUserId: ACTOR_ID }),
    ).resolves.toMatchObject({
      desiredActive: true,
      runtimeStatus: "running",
      reconciled: true,
      applied: true,
    });
    expect(updates).toEqual([]);
    expect(audits[0]).toMatchObject({
      action: "bot.lifecycle.restart-requested",
      outcome: "succeeded",
    });
    expect(running.restart).toHaveBeenCalledWith(BOT_A);
  });

  it("does not touch runtime when the desired-state transaction fails", async () => {
    const { db } = database([], [], { failTransaction: new Error("database unavailable") });
    const stopped = runtime({ [BOT_A]: "stopped" });
    const service = new BotLifecycleService(db, stopped.value);

    const operation = service.enable({ botId: BOT_A, actorTelegramUserId: ACTOR_ID });

    await expect(operation).rejects.toMatchObject({
      code: "persistence_failed",
      message: "Bot lifecycle state could not be persisted",
    } satisfies Partial<BotLifecycleError>);
    await expect(operation).rejects.not.toThrow("database unavailable");
    expect(stopped.start).not.toHaveBeenCalled();
    expect(stopped.stop).not.toHaveBeenCalled();
    expect(stopped.restart).not.toHaveBeenCalled();
  });

  it("serializes the same Bot while allowing another Bot to progress", async () => {
    const events: string[] = [];
    let releaseStart = () => {};
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { db } = database([false, false, true], events);
    const current = runtime({ [BOT_A]: "stopped", [BOT_B]: "stopped" }, events, {
      start: async (botId) => (botId === BOT_A ? startBlocked : undefined),
    });
    const service = new BotLifecycleService(db, current.value);

    const firstA = service.enable({ botId: BOT_A, actorTelegramUserId: ACTOR_ID });
    await vi.waitFor(() => expect(current.start).toHaveBeenCalledWith(BOT_A));
    const secondA = service.disable({ botId: BOT_A, actorTelegramUserId: ACTOR_ID });
    const firstB = service.enable({ botId: BOT_B, actorTelegramUserId: ACTOR_ID });

    await expect(firstB).resolves.toMatchObject({ reconciled: true });
    expect(current.stop).not.toHaveBeenCalledWith(BOT_A);

    releaseStart();
    await Promise.all([firstA, secondA]);
    expect(current.stop).toHaveBeenCalledWith(BOT_A);
    expect(events.indexOf(`runtime:start:${BOT_B}`)).toBeLessThan(
      events.indexOf(`runtime:stop:${BOT_A}`),
    );
  });
});
