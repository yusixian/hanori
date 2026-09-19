import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingActionRegistry } from "./pending-actions.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function registerPersistentTimer(registry: PendingActionRegistry, durationMs?: number) {
  return registry.registerTimer(
    1,
    "reason",
    setTimeout(() => {}, 0),
    true,
    durationMs,
  );
}

describe("PendingActionRegistry timer eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a multi-day timer past the generic persistent window", () => {
    const registry = new PendingActionRegistry();
    const { timerId } = registerPersistentTimer(registry, 3 * DAY_MS);

    vi.advanceTimersByTime(26 * HOUR_MS);

    expect(registry.getTimer(timerId)?.timerId).toBe(timerId);
  });

  it("evicts a multi-day timer once its own deadline and grace have passed", () => {
    const registry = new PendingActionRegistry();
    const { timerId } = registerPersistentTimer(registry, 3 * DAY_MS);

    vi.advanceTimersByTime(3 * DAY_MS + 2 * HOUR_MS);

    expect(registry.getTimer(timerId)).toBeUndefined();
  });

  it("falls back to the persistent window when no duration is given", () => {
    const registry = new PendingActionRegistry();
    const { timerId } = registerPersistentTimer(registry);

    vi.advanceTimersByTime(26 * HOUR_MS);

    expect(registry.getTimer(timerId)).toBeUndefined();
  });

  it("still evicts a non-persistent timer after one hour", () => {
    const registry = new PendingActionRegistry();
    const { timerId } = registry.registerTimer(
      1,
      "reason",
      setTimeout(() => {}, 0),
    );

    vi.advanceTimersByTime(2 * HOUR_MS);

    expect(registry.getTimer(timerId)).toBeUndefined();
  });
});
