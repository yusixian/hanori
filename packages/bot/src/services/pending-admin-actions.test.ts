import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PendingAdminActionRegistry,
  PENDING_ADMIN_ACTION_TTL_MS,
} from "./pending-github-actions.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingAdminActionRegistry", () => {
  it("binds an action kind and allows it to be taken only once", () => {
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind: "rss:remove_rss_feed",
      chatId: -100,
      userId: 7,
      description: "remove feed",
      execute: vi.fn().mockResolvedValue({ summary: "done" }),
    });

    expect(action).toMatchObject({
      kind: "rss:remove_rss_feed",
      chatId: -100,
      userId: 7,
    });
    expect(registry.take(action.id)).toBe(action);
    expect(registry.take(action.id)).toBeUndefined();
    registry.destroy();
  });

  it("expires pending actions after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    const registry = new PendingAdminActionRegistry();
    const action = registry.register({
      kind: "rss:add_rss_feed",
      chatId: -100,
      userId: 7,
      description: "add feed",
      execute: vi.fn().mockResolvedValue({ summary: "done" }),
    });

    vi.advanceTimersByTime(PENDING_ADMIN_ACTION_TTL_MS);
    expect(registry.get(action.id)).toBeUndefined();
    registry.destroy();
  });

  it("does not start an admitted action if the registry is destroyed before execution", async () => {
    const registry = new PendingAdminActionRegistry();
    const execute = vi.fn(async () => ({ summary: "done" }));
    const action = registry.register({
      chatId: -100,
      userId: 7,
      description: "pending action",
      execute,
    });
    const run = registry.run(action);
    const checked = expect(run).rejects.toThrow("Admin action registry was destroyed");
    registry.destroy();
    await checked;
    expect(execute).not.toHaveBeenCalled();
    await expect(registry.drain()).resolves.toEqual({ settled: true, timedOut: false });
  });

  it("aborts active actions and drains their tracked promises", async () => {
    const registry = new PendingAdminActionRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let actionSignal: AbortSignal | undefined;
    const action = registry.register({
      kind: "rss:add_rss_feed",
      chatId: -100,
      userId: 7,
      description: "add feed",
      execute: async (signal) => {
        actionSignal = signal;
        started();
        await gate;
        signal?.throwIfAborted();
        return { summary: "done" };
      },
    });
    const run = registry.run(action);
    const runResult = expect(run).rejects.toThrow("Admin action registry was destroyed");
    await didStart;

    const drain = registry.destroyAndDrain();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(actionSignal?.aborted).toBe(true);
    expect(drained).toBe(false);

    release();
    await runResult;
    await expect(drain).resolves.toEqual({ settled: true, timedOut: false });
  });

  it("bounds draining when an active action ignores cancellation", async () => {
    const registry = new PendingAdminActionRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const action = registry.register({
      chatId: -100,
      userId: 7,
      description: "legacy GitHub action",
      execute: async () => {
        started();
        await gate;
        return { summary: "done" };
      },
    });
    const run = registry.run(action);
    await didStart;

    await expect(registry.destroyAndDrain(5)).resolves.toEqual({
      settled: false,
      timedOut: true,
    });

    release();
    await expect(run).resolves.toEqual({ summary: "done" });
    await expect(registry.drain()).resolves.toEqual({ settled: true, timedOut: false });
  });
});
