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
