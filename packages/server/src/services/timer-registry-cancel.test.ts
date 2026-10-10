import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimerRegistry } from "./timer-registry.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture(persist: () => Promise<void>, rows: unknown[] = []) {
  const claim = vi.fn(async () => [{ id: "ai_test" }]);
  const db = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    insert: () => ({ values: async () => {} }),
    update: () => ({
      set: (values: { status: string }) => ({
        where: () => (values.status === "cancelled" ? persist() : { returning: claim }),
      }),
    }),
  } as unknown as Database;
  const registry = new TimerRegistry(db, { error: vi.fn(), info: vi.fn() } as unknown as Logger);
  const fire = vi.fn(async () => {});
  const register = () =>
    registry.registerAi({
      timerId: "ai_test",
      botId: "bot-a",
      chatId: 42,
      name: "test",
      seconds: 5,
      onFire: fire,
    });
  return { registry, register, fire, claim };
}

it("rejects failed durable cancellation and retains the timer for a later retry", async () => {
  const failure = new Error("database unavailable");
  const persist = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const { registry, register, fire } = fixture(persist);
  try {
    const id = await register();
    await expect(registry.cancel(id)).rejects.toBe(failure);
    expect(registry.get(id)?.status).toBe("active");
    await expect(registry.cancel(id)).resolves.toBe(true);
    expect(registry.get(id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fire).not.toHaveBeenCalled();
  } finally {
    registry.destroy();
  }
});

it("serializes delivery behind a pending cancellation and only then reports success", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { registry, register, fire, claim } = fixture(() => pending);
  try {
    const id = await register();
    const cancel = registry.cancel(id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(registry.get(id)?.status).toBe("active");
    expect(fire).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    release();
    await expect(cancel).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fire).not.toHaveBeenCalled();
    expect(registry.get(id)).toBeUndefined();
  } finally {
    release();
    registry.destroy();
  }
});

it("does not report cancellation once delivery has already claimed the timer", async () => {
  const persist = vi.fn(async () => {});
  const { registry, register, fire } = fixture(persist);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  fire.mockImplementationOnce(() => pending);
  try {
    const id = await register();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fire).toHaveBeenCalledOnce();
    await expect(registry.cancel(id)).resolves.toBe(false);
    expect(persist).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    release();
    registry.destroy();
  }
});

it("cancels a restored processing timer while it is waiting for its lease", async () => {
  const now = new Date();
  const persist = vi.fn(async () => {});
  const { registry, fire } = fixture(persist, [
    {
      id: "ai_test",
      botId: "bot-a",
      type: "ai",
      name: "restored",
      chatId: 42,
      status: "processing",
      firesAt: now,
      firedAt: now,
      createdAt: now,
      meta: null,
    },
  ]);
  try {
    await expect(registry.resumeBot("bot-a", fire)).resolves.toMatchObject({ recovered: 1 });
    await expect(registry.cancel("ai_test")).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledOnce();
    expect(fire).not.toHaveBeenCalled();
  } finally {
    registry.destroy();
  }
});
