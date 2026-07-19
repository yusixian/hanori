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
  test("only confirms absence after a successful empty lookup", async () => {
    await expect(confirmPendingInsertAbsent(vi.fn().mockResolvedValue(undefined))).resolves.toBe(
      true,
    );
    await expect(confirmPendingInsertAbsent(vi.fn().mockResolvedValue({ id: 1 }))).resolves.toBe(
      false,
    );
    await expect(
      confirmPendingInsertAbsent(vi.fn().mockRejectedValue(new Error("lookup failed"))),
    ).resolves.toBe(false);
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

    await expect(tracker.insertIfClaimed("bot-a", "task-1", insert)).resolves.toBe(false);
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

    const first = tracker.insertIfClaimed("bot-a", "task-1", insert);
    const second = tracker.insertIfClaimed("bot-a", "task-1", insert);

    await expect(second).resolves.toBe(false);
    expect(insert).toHaveBeenCalledOnce();
    releaseInsert();
    await expect(first).resolves.toBe(true);
  });

  test("consumes eligibility when the fallback insert fails", async () => {
    const tracker = new PendingGenerationInsertFallbackTracker();
    const error = new Error("database unavailable");
    const insert = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    tracker.markPendingInsertFailure("bot-a", "task-1");

    await expect(tracker.insertIfClaimed("bot-a", "task-1", insert)).rejects.toBe(error);
    await expect(tracker.insertIfClaimed("bot-a", "task-1", insert)).resolves.toBe(false);
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
