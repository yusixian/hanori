import type { Database } from "@cos-tool-bot/database";
import type { UsageGovernancePort } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryConsolidator } from "./memory-consolidator.js";

function fixture() {
  const query = vi.fn().mockResolvedValue([]);
  const acquire = vi.fn().mockResolvedValue([]);
  const values = vi.fn((_value: { botId: string }) => ({
    onConflictDoUpdate: () => ({ returning: acquire }),
  }));
  const db = {
    select: () => ({
      from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: query }) }) }) }),
    }),
    insert: () => ({ values }),
  } as unknown as Database;
  const error = vi.fn();
  const service = new MemoryConsolidator(
    db,
    { error } as unknown as Logger,
    "unused",
    {} as UsageGovernancePort,
    { refreshEmbeddings: vi.fn() },
  );
  return { service, query, acquire, values, error };
}

afterEach(() => vi.useRealTimers());

it("logs startup and scheduled query failures and recovers on the next interval", async () => {
  vi.useFakeTimers();
  const { service, query, error } = fixture();
  const startupFailure = new Error("database unavailable at startup");
  const scheduledFailure = new Error("database unavailable during sweep");
  query.mockRejectedValueOnce(startupFailure).mockRejectedValueOnce(scheduledFailure);
  try {
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(
      { error: startupFailure },
      "Memory consolidation tick failed",
    );
    await vi.advanceTimersByTimeAsync(service.getIntervalMs());
    expect(error).toHaveBeenCalledWith(
      { error: scheduledFailure },
      "Memory consolidation tick failed",
    );
    await vi.advanceTimersByTimeAsync(service.getIntervalMs());
    expect(query).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(2);
    service.stop();
    await vi.advanceTimersByTimeAsync(service.getIntervalMs());
    expect(query).toHaveBeenCalledTimes(3);
  } finally {
    service.stop();
  }
});

it("preserves manual tick rejection and permits the next manual attempt", async () => {
  const { service, query, error } = fixture();
  const failure = new Error("database unavailable");
  query.mockRejectedValueOnce(failure);
  await expect(service.tick()).rejects.toBe(failure);
  await expect(service.tick()).resolves.toBeUndefined();
  expect(query).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
});

it("isolates a failed bot lease and still attempts the next bot", async () => {
  const { service, query, acquire, values, error } = fixture();
  const failure = new Error("lease failed");
  query.mockResolvedValueOnce([{ id: "first" }, { id: "second" }]);
  acquire.mockRejectedValueOnce(failure);
  await expect(service.tick()).resolves.toBeUndefined();
  expect(values.mock.calls.map(([value]) => value)).toEqual([
    expect.objectContaining({ botId: "first" }),
    expect.objectContaining({ botId: "second" }),
  ]);
  expect(error).toHaveBeenCalledWith(
    { error: failure, botId: "first" },
    "Memory consolidation failed",
  );
});

it("close waits for the candidate query and does not start a bot afterward", async () => {
  const { service, query, acquire } = fixture();
  let release!: (rows: { id: string }[]) => void;
  query.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const tick = service.tick();
  const closed = vi.fn();
  const closing = service.close();
  void closing.then(closed);
  expect(service.close()).toBe(closing);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  release([{ id: "first" }]);
  await tick;
  await closing;
  expect(acquire).not.toHaveBeenCalled();
  service.start();
  await service.tick();
  expect(query).toHaveBeenCalledOnce();
  expect(service.getHandle()).toBeNull();
});

it("close waits for an admitted bot and skips the next bot", async () => {
  const { service, query, acquire, values } = fixture();
  let release!: () => void;
  query.mockResolvedValueOnce([{ id: "first" }, { id: "second" }]);
  acquire.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () => resolve([]);
    }),
  );
  const tick = service.tick();
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
  const closing = service.close();
  const closed = vi.fn();
  void closing.then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  release();
  await tick;
  await closing;
  expect(values).toHaveBeenCalledOnce();
});

it("preserves pending tick failure during close", async () => {
  const { service, query } = fixture();
  let reject!: (error: unknown) => void;
  query.mockReturnValueOnce(
    new Promise((_resolve, onReject) => {
      reject = onReject;
    }),
  );
  const tick = service.tick();
  const closing = service.close();
  const error = new Error("query failed");
  const expectations = [expect(tick).rejects.toBe(error), expect(closing).rejects.toBe(error)];
  reject(error);
  await Promise.all(expectations);
});

it("keeps stop restartable and overlapping ticks a no-op", async () => {
  vi.useFakeTimers();
  const { service, query } = fixture();
  let release!: () => void;
  query.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () => resolve([]);
    }),
  );
  service.start();
  await service.tick();
  expect(query).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  service.stop();
  service.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledTimes(2);
  await service.close();
});
