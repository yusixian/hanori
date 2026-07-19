import { describe, expect, test, vi } from "vitest";
import {
  AsyncTaskLimiter,
  confirmPendingInsertAbsent,
  isTerminalGenerationRecoveryError,
  PendingGenerationInsertFallbackTracker,
  persistTerminalGenerationClaim,
  tryPersistTerminalGenerationFailure,
} from "./generation-recovery.js";

describe("confirmPendingInsertAbsent", () => {
  test("distinguishes confirmed absence, presence, and a transient lookup failure", async () => {
    await expect(confirmPendingInsertAbsent(vi.fn().mockResolvedValue(undefined))).resolves.toBe(
      true,
    );
    await expect(confirmPendingInsertAbsent(vi.fn().mockResolvedValue({ id: 1 }))).resolves.toBe(
      false,
    );
    const error = new Error("lookup failed");
    await expect(confirmPendingInsertAbsent(vi.fn().mockRejectedValue(error))).rejects.toBe(error);
  });
});

describe("isTerminalGenerationRecoveryError", () => {
  test.each([
    "PixAI task failed: provider error",
    "PixAI task cancelled: user cancelled",
    "PixAI task timed out after 1200s",
  ])("marks remote terminal results as failed: %s", (message) => {
    expect(isTerminalGenerationRecoveryError(message)).toBe(true);
  });

  test.each([
    'PixAI GraphQL get task failed: HTTP 401 {"message":"invalid token"}',
    "TypeError: fetch failed",
    "PixAI GraphQL get task failed: HTTP 503",
    "Bot is not running",
  ])("keeps retryable recovery errors pending: %s", (message) => {
    expect(isTerminalGenerationRecoveryError(message)).toBe(false);
  });
});

describe("tryPersistTerminalGenerationFailure", () => {
  test("contains database update failures", async () => {
    const error = new Error("database unavailable");

    await expect(tryPersistTerminalGenerationFailure(() => Promise.reject(error))).resolves.toEqual(
      { ok: false, error },
    );
  });
});

describe("PendingGenerationInsertFallbackTracker", () => {
  test("leaves a deleted or otherwise unmarked row absent", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    const insert = vi.fn().mockResolvedValue(undefined);

    await expect(
      tracker.insertIfClaimed("bot-a", "task-1", vi.fn().mockResolvedValue(true), insert),
    ).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  test("allows only one fallback insert for a tracked task under concurrency", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    let releaseInsert!: () => void;
    const insert = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseInsert = resolve;
        }),
    );
    tracker.markPendingInsertFailure("bot-a", "task-1");

    const confirmAbsent = vi.fn().mockResolvedValue(true);
    const first = tracker.insertIfClaimed("bot-a", "task-1", confirmAbsent, insert);
    const second = tracker.insertIfClaimed("bot-a", "task-1", confirmAbsent, insert);

    await expect(second).resolves.toBe(false);
    expect(insert).toHaveBeenCalledOnce();
    expect(confirmAbsent).toHaveBeenCalledOnce();
    releaseInsert();
    await expect(first).resolves.toBe(true);
  });

  test("retains eligibility when absence confirmation fails before any insert", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    const transientError = new Error("database unavailable");
    const confirmAbsent = vi.fn().mockRejectedValueOnce(transientError).mockResolvedValueOnce(true);
    const insert = vi.fn().mockResolvedValue(undefined);
    tracker.markPendingInsertFailure("bot-a", "task-1");

    await expect(tracker.insertIfClaimed("bot-a", "task-1", confirmAbsent, insert)).rejects.toBe(
      transientError,
    );
    await expect(tracker.insertIfClaimed("bot-a", "task-1", confirmAbsent, insert)).resolves.toBe(
      true,
    );
    expect(insert).toHaveBeenCalledOnce();
  });

  test("does not insert when terminal confirmation finds an existing row", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    const insert = vi.fn().mockResolvedValue(undefined);
    tracker.markPendingInsertFailure("bot-a", "task-1");

    await expect(
      tracker.insertIfClaimed("bot-a", "task-1", vi.fn().mockResolvedValue(false), insert),
    ).resolves.toBe(false);
    await expect(
      tracker.insertIfClaimed("bot-a", "task-1", vi.fn().mockResolvedValue(true), insert),
    ).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  test("suppresses an in-flight fallback when the user deletes the generation", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    let releaseConfirmation!: (absent: boolean) => void;
    const confirmAbsent = vi.fn(
      () => new Promise<boolean>((resolve) => (releaseConfirmation = resolve)),
    );
    const insert = vi.fn().mockResolvedValue(undefined);
    tracker.markPendingInsertFailure("bot-a", "task-1");

    const fallback = tracker.insertIfClaimed("bot-a", "task-1", confirmAbsent, insert);
    tracker.suppress("bot-a", "task-1");
    releaseConfirmation(true);

    await expect(fallback).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  test("does not resurrect a deletion when a late pending-insert failure is reported", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    const insert = vi.fn().mockResolvedValue(undefined);

    tracker.suppress("bot-a", "task-1");
    tracker.markPendingInsertFailure("bot-a", "task-1");

    await expect(
      tracker.insertIfClaimed("bot-a", "task-1", vi.fn().mockResolvedValue(true), insert),
    ).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  test("expires stale markers and clears all markers for a deleted bot", async () => {
    let now = 1_000;
    const tracker = new PendingGenerationInsertFallbackTracker(100, () => now);
    tracker.markPendingInsertFailure("bot-a", "task-1");
    tracker.markPendingInsertFailure("bot-b", "task-2");
    tracker.suppress("bot-a", "task-3");
    tracker.clearBot("bot-a");

    const insert = vi.fn().mockResolvedValue(undefined);
    await expect(
      tracker.insertIfClaimed("bot-a", "task-1", vi.fn().mockResolvedValue(true), insert),
    ).resolves.toBe(false);
    now += 101;
    expect(tracker.pruneExpired()).toBe(1);
    await expect(
      tracker.insertIfClaimed("bot-b", "task-2", vi.fn().mockResolvedValue(true), insert),
    ).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  test("consumes eligibility when the fallback insert fails", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    const error = new Error("database unavailable");
    const insert = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    tracker.markPendingInsertFailure("bot-a", "task-1");

    await expect(
      tracker.insertIfClaimed("bot-a", "task-1", vi.fn().mockResolvedValue(true), insert),
    ).rejects.toBe(error);
    await expect(
      tracker.insertIfClaimed("bot-a", "task-1", vi.fn().mockResolvedValue(true), insert),
    ).resolves.toBe(false);
    expect(insert).toHaveBeenCalledOnce();
  });
});

describe("persistTerminalGenerationClaim", () => {
  test("allows only one concurrent terminal update to own delivery", async () => {
    let pending = true;
    const updatePending = vi.fn(async () => {
      if (!pending) return false;
      pending = false;
      return true;
    });
    const insertFallback = vi.fn().mockResolvedValue(false);

    const results = await Promise.allSettled([
      persistTerminalGenerationClaim("task-1", updatePending, insertFallback),
      persistTerminalGenerationClaim("task-1", updatePending, insertFallback),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(insertFallback).toHaveBeenCalledOnce();
  });

  test("allows the recorded pending-insert fallback to own delivery", async () => {
    await expect(
      persistTerminalGenerationClaim(
        "task-1",
        vi.fn().mockResolvedValue(false),
        vi.fn().mockResolvedValue(true),
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects a missing or deleted generation before delivery", async () => {
    await expect(
      persistTerminalGenerationClaim(
        "task-1",
        vi.fn().mockResolvedValue(false),
        vi.fn().mockResolvedValue(false),
      ),
    ).rejects.toThrow("already claimed or is no longer pending");
  });
});

describe("AsyncTaskLimiter", () => {
  test("runs no more than the configured concurrency", async () => {
    const limiter = new AsyncTaskLimiter(2);
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 4 }, (_, index) =>
      limiter.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return index;
      }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(maxActive).toBe(2);
  });

  test("rejects and removes a queued task immediately after cancellation", async () => {
    const limiter = new AsyncTaskLimiter(1);
    let releaseFirst!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => (releaseFirst = resolve)));
    const controller = new AbortController();
    const queued = vi.fn().mockResolvedValue(undefined);
    const second = limiter.run(queued, controller.signal);

    controller.abort(new Error("bot stopped"));
    await expect(second).rejects.toThrow("bot stopped");
    expect(queued).not.toHaveBeenCalled();

    releaseFirst();
    await first;
  });
});
