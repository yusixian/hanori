import type { Logger } from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { UsageMaintenanceService } from "./usage-maintenance.js";

function fixture() {
  const governor = {
    pruneExpiredDetails: vi.fn(async () => {}),
    reclaimExpiredReservations: vi.fn(async () => 0),
  };
  const logger = { error: vi.fn() };
  return {
    governor,
    logger,
    service: new UsageMaintenanceService(governor, logger as unknown as Logger),
  };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("keeps the existing periods without repeating startup reconciliation", async () => {
  vi.useFakeTimers();
  const { service, governor } = fixture();
  service.start();
  service.start();
  expect(vi.getTimerCount()).toBe(2);
  expect(governor.reclaimExpiredReservations).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(governor.reclaimExpiredReservations).toHaveBeenCalledOnce();
  expect(governor.pruneExpiredDetails).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 60_000);
  expect(governor.pruneExpiredDetails).toHaveBeenCalledOnce();
  expect(governor.reclaimExpiredReservations).toHaveBeenCalledTimes(1440);
  await service.close();
  service.start();
  expect(vi.getTimerCount()).toBe(0);
});

it("close waits for both admitted maintenance operations including failed diagnostics", async () => {
  vi.useFakeTimers();
  const { service, governor, logger } = fixture();
  let release!: () => void;
  let reject!: (error: unknown) => void;
  governor.pruneExpiredDetails.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = new Promise<number>((_resolve, onReject) => {
    reject = onReject;
  });
  service.start();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 60_000);
  governor.reclaimExpiredReservations.mockReturnValueOnce(pending);
  await vi.advanceTimersByTimeAsync(60_000);
  const closing = service.close();
  expect(service.close()).toBe(closing);
  const closed = vi.fn();
  void closing.then(closed);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).not.toHaveBeenCalled();
  const error = new Error("database unavailable");
  reject(error);
  await closing;
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(error);
  expect(closed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("logs failure and keeps the next interval usable", async () => {
  vi.useFakeTimers();
  const { service, governor, logger } = fixture();
  const error = new Error("reclaim failed");
  governor.reclaimExpiredReservations.mockRejectedValueOnce(error);
  service.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(governor.reclaimExpiredReservations).toHaveBeenCalledTimes(2);
  expect(logger.error).toHaveBeenCalledExactlyOnceWith(error);
  await service.close();
});
