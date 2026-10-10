import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createShutdownHandler, ShutdownSteps } from "./shutdown.js";

it("runs cleanup once when SIGINT and SIGTERM arrive during a pending shutdown", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closeDatabase = vi.fn();
  const stop = vi.fn(async (_signal: NodeJS.Signals) => {
    await pending;
    closeDatabase();
  });
  const shutdown = createShutdownHandler(stop);
  const signals = new EventEmitter();
  const attempts: Promise<void>[] = [];
  signals.once("SIGINT", () => attempts.push(shutdown("SIGINT")));
  signals.once("SIGTERM", () => attempts.push(shutdown("SIGTERM")));
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  expect(stop).toHaveBeenCalledExactlyOnceWith("SIGINT");
  expect(attempts[0]).toBe(attempts[1]);
  expect(closeDatabase).not.toHaveBeenCalled();
  release();
  await Promise.all(attempts);
  expect(closeDatabase).toHaveBeenCalledOnce();
  expect(shutdown("SIGTERM")).toBe(attempts[0]);
});

it.each([false, true])(
  "preserves a failed attempt without restarting cleanup (synchronous: %s)",
  async (synchronous) => {
    const error = new Error("shutdown failed");
    const stop = vi.fn(() => {
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    const shutdown = createShutdownHandler(stop);
    const first = shutdown("SIGTERM");
    await expect(first).rejects.toBe(error);
    expect(shutdown("SIGINT")).toBe(first);
    expect(stop).toHaveBeenCalledOnce();
  },
);

it("publishes the attempt before synchronous side effects can invoke it again", async () => {
  let nested: Promise<void> | undefined;
  const stop = vi.fn(async () => {
    nested = shutdown("SIGTERM");
  });
  const shutdown = createShutdownHandler(stop);
  const first = shutdown("SIGINT");
  expect(nested).toBe(first);
  await first;
  expect(stop).toHaveBeenCalledOnce();
});

it("continues cleanup after synchronous and asynchronous failures", async () => {
  const steps = new ShutdownSteps();
  const syncError = new Error("sync");
  const asyncError = new Error("async");
  await steps.run("sync", () => {
    throw syncError;
  });
  await steps.run("async", () => Promise.reject(asyncError));
  const closeDatabase = vi.fn();
  await steps.run("database", closeDatabase);
  expect(closeDatabase).toHaveBeenCalledOnce();
  expect(steps.failures).toEqual([
    { step: "sync", error: syncError },
    { step: "async", error: asyncError },
  ]);
});

it("waits for the whole parallel group after a failure before closing dependencies", async () => {
  const steps = new ShutdownSteps();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closeDependency = vi.fn();
  const cleanup = (async () => {
    await Promise.all([
      steps.run("failed", () => Promise.reject(new Error("failed"))),
      steps.run("pending", () => pending),
    ]);
    await steps.run("dependency", closeDependency);
  })();
  await vi.waitFor(() => expect(steps.failures).toHaveLength(1));
  expect(closeDependency).not.toHaveBeenCalled();
  release();
  await cleanup;
  expect(closeDependency).toHaveBeenCalledOnce();
});
