import { describe, expect, test, vi } from "vitest";
import { KeyedAsyncLock } from "./keyed-async-lock.js";

describe("KeyedAsyncLock", () => {
  test("serializes operations for the same key", async () => {
    const lock = new KeyedAsyncLock();
    let releaseFirst!: () => void;
    const first = lock.run("bot-a", () => new Promise<void>((resolve) => (releaseFirst = resolve)));
    const secondOperation = vi.fn().mockResolvedValue("second");
    const second = lock.run("bot-a", secondOperation);

    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
  });

  test("allows operations for different keys to run concurrently", async () => {
    const lock = new KeyedAsyncLock();
    let releaseFirst!: () => void;
    const first = lock.run("bot-a", () => new Promise<void>((resolve) => (releaseFirst = resolve)));
    const secondOperation = vi.fn().mockResolvedValue("second");

    await expect(lock.run("bot-b", secondOperation)).resolves.toBe("second");
    expect(secondOperation).toHaveBeenCalledOnce();

    releaseFirst();
    await first;
  });
});

test("preserves rejection, continues the queue and does not release a newer operation", async () => {
  const lock = new KeyedAsyncLock();
  const failure = new Error("first failed");
  const next = deferred<void>();
  const first = lock.run("a", async () => {
    throw failure;
  });
  const second = lock.run("a", () => next.promise);
  await expect(first).rejects.toBe(failure);
  expect(lock.isLocked("a")).toBe(true);
  const thirdOperation = vi.fn(async () => "third");
  const third = lock.run("a", thirdOperation);
  await Promise.resolve();
  expect(thirdOperation).not.toHaveBeenCalled();
  next.resolve();
  await second;
  await expect(third).resolves.toBe("third");
  await Promise.resolve();
  expect(lock.isLocked("a")).toBe(false);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
