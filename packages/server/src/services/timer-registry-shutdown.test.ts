import type { Database } from "@cos-tool-bot/database";
import type { Logger } from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimerRegistry } from "./timer-registry.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const insert = vi.fn(async () => {});
  const select = vi.fn(async (): Promise<unknown[]> => []);
  const write = vi.fn(async (_status: string) => [{ id: "ai_test" }]);
  const cleanup = vi.fn(async () => []);
  const db = {
    insert: () => ({ values: insert }),
    select: () => ({ from: () => ({ where: select }) }),
    update: () => ({
      set: ({ status }: { status: string }) => ({
        where: () => ({ returning: () => write(status) }),
      }),
    }),
    delete: () => ({ where: () => ({ returning: cleanup }) }),
  } as unknown as Database;
  const registry = new TimerRegistry(db, { info: vi.fn(), error: vi.fn() } as unknown as Logger);
  const fire = vi.fn(async () => {});
  const register = () =>
    registry.registerAi({
      timerId: "ai_test",
      botId: "bot-a",
      chatId: 42,
      name: "test",
      seconds: 1,
      onFire: fire,
    });
  return { registry, fire, register, insert, select, write, cleanup };
}
const registries: TimerRegistry[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const r of registries.splice(0)) r.destroy();
  vi.useRealTimers();
});
function fixture() {
  const value = setup();
  registries.push(value.registry);
  return value;
}

it.each([false, true])(
  "waits for delivery and final persistence without reviving retries (failure: %s)",
  async (fails) => {
    const { registry, fire, register, write } = fixture();
    const delivery = gate();
    const persistence = gate();
    fire.mockImplementation(async () => {
      await delivery.promise;
      if (fails) throw new Error("send failed");
    });
    write.mockImplementation(async (status) => {
      if (status !== "processing") await persistence.promise;
      return [{ id: "ai_test" }];
    });
    await register();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fire).toHaveBeenCalledOnce();
    const settled = vi.fn();
    const closing = registry.close();
    void closing.then(settled);
    expect(registry.close()).toBe(closing);
    delivery.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenLastCalledWith(fails ? "active" : "fired");
    expect(settled).not.toHaveBeenCalled();
    persistence.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fire).toHaveBeenCalledOnce();
    expect(registry.get("ai_test")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("waits for pending registration but leaves its durable timer for recovery", async () => {
  const { registry, insert, register, fire } = fixture();
  const pending = gate();
  insert.mockImplementation(() => pending.promise);
  const registration = register();
  await vi.advanceTimersByTimeAsync(0);
  const settled = vi.fn();
  const closing = registry.close();
  void closing.then(settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).not.toHaveBeenCalled();
  pending.resolve();
  await registration;
  await closing;
  await vi.advanceTimersByTimeAsync(2000);
  expect(fire).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await expect(register()).rejects.toThrow("closing");
  expect(insert).toHaveBeenCalledOnce();
});

it("waits for recovery queries and does not claim new reminders after closing", async () => {
  const { registry, select, write, fire } = fixture();
  const pending = gate();
  select.mockImplementation(async () => {
    await pending.promise;
    return [overdue()];
  });
  const recovery = registry.resumeBot("bot-a", fire);
  await vi.advanceTimersByTimeAsync(0);
  const settled = vi.fn();
  const closing = registry.close();
  void closing.then(settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).not.toHaveBeenCalled();
  pending.resolve();
  await recovery;
  await closing;
  expect(write).not.toHaveBeenCalled();
  expect(fire).not.toHaveBeenCalled();
});

function overdue() {
  return {
    id: "ai_test",
    botId: "bot-a",
    name: "test",
    chatId: 42,
    status: "active",
    firesAt: new Date(Date.now() - 1000),
    createdAt: new Date(),
    meta: null,
  };
}

it("rolls back a recovery claim that finishes during closing", async () => {
  const { registry, select, write, fire } = fixture();
  const pending = gate();
  select.mockResolvedValue([overdue()]);
  write.mockImplementation(async (status) => {
    if (status === "processing") await pending.promise;
    return [{ id: "ai_test" }];
  });
  const recovery = registry.resumeBot("bot-a", fire);
  await vi.advanceTimersByTimeAsync(0);
  expect(write).toHaveBeenCalledWith("processing");
  const closing = registry.close();
  pending.resolve();
  await recovery;
  await closing;
  expect(write).toHaveBeenLastCalledWith("active");
  expect(fire).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("returns claimed but not yet dispatched reminders to active on close", async () => {
  const { registry, select, write, fire } = fixture();
  select.mockResolvedValue([overdue()]);
  await registry.resumeBot("bot-a", fire);
  await registry.close();
  expect(write).toHaveBeenLastCalledWith("active");
  await vi.advanceTimersByTimeAsync(1000);
  expect(fire).not.toHaveBeenCalled();
});

it("waits for scheduled database cleanup", async () => {
  const { registry, cleanup } = fixture();
  const pending = gate();
  cleanup.mockImplementation(async () => {
    await pending.promise;
    return [];
  });
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(cleanup).toHaveBeenCalledOnce();
  const settled = vi.fn();
  const closing = registry.close();
  void closing.then(settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).not.toHaveBeenCalled();
  pending.resolve();
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});

it("clears externally supplied handles when registration completes during shutdown", async () => {
  const { registry, insert } = fixture();
  const pending = gate();
  const callback = vi.fn();
  insert.mockImplementation(() => pending.promise);
  const handle = setTimeout(callback, 10_000);
  const registration = registry.registerAi({
    botId: "bot-a",
    chatId: 42,
    name: "legacy",
    seconds: 10,
    handle,
  });
  await vi.advanceTimersByTimeAsync(0);
  const closing = registry.close();
  pending.resolve();
  await registration;
  await closing;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects post-close operations and clears newly supplied handles", async () => {
  const { registry, insert, select, write } = fixture();
  await registry.close();
  const callback = vi.fn();
  await expect(
    registry.registerAi({
      botId: "bot-a",
      chatId: 42,
      name: "late",
      seconds: 10,
      handle: setTimeout(callback, 1000),
    }),
  ).rejects.toThrow("closing");
  registry.setHandle("missing", setTimeout(callback, 1000));
  registry.registerSystem({ name: "late", intervalMs: 1000, handle: setInterval(callback, 1000) });
  await expect(registry.resumeBot("bot-a", async () => {})).rejects.toThrow("closing");
  await expect(registry.markFired("late")).rejects.toThrow("closing");
  await expect(registry.cancel("late")).rejects.toThrow("closing");
  await vi.advanceTimersByTimeAsync(2000);
  expect(callback).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("finishes a delivery whose claim was already in flight at shutdown", async () => {
  const { registry, register, write, fire } = fixture();
  const claim = gate();
  write.mockImplementation(async (status) => {
    if (status === "processing") await claim.promise;
    return [{ id: "ai_test" }];
  });
  await register();
  await vi.advanceTimersByTimeAsync(1000);
  const closing = registry.close();
  claim.resolve();
  await closing;
  expect(fire).toHaveBeenCalledOnce();
  expect(write).toHaveBeenLastCalledWith("fired");
});

it("clears a pending external handle before a failed registration settles", async () => {
  const { registry, insert, fire } = fixture();
  const pending = gate();
  const callback = vi.fn();
  insert.mockImplementation(async () => {
    await pending.promise;
    throw new Error("insert failed");
  });
  const registration = registry.registerAi({
    botId: "bot-a",
    chatId: 42,
    name: "pending",
    seconds: 1,
    handle: setTimeout(callback, 1000),
    onFire: fire,
  });
  const failed = expect(registration).rejects.toThrow("insert failed");
  await vi.advanceTimersByTimeAsync(0);
  const closing = registry.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(callback).not.toHaveBeenCalled();
  pending.resolve();
  await failed;
  await closing;
  expect(vi.getTimerCount()).toBe(0);
  expect(fire).not.toHaveBeenCalled();
});
