import { describe, expect, it, vi } from "vitest";
import { AiExecutionCoordinator, AiRunCancelledError } from "./ai-execution-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("AiExecutionCoordinator", () => {
  it("does not run work until the caller releases the short ingress phase", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const task = vi.fn(async () => "done");
    const run = coordinator.schedule({ chatId: 1, userId: 2 }, task);

    await Promise.resolve();
    expect(run.queued).toBe(false);
    expect(task).not.toHaveBeenCalled();

    run.start();
    await expect(run.result).resolves.toBe("done");
    expect(coordinator.stats).toMatchObject({
      active: 0,
      queued: 0,
      tracked: 0,
      started: 1,
      completed: 1,
      rejected: 0,
      cancelled: 0,
    });
    expect(coordinator.stats.totalWaitMs).toBeGreaterThanOrEqual(0);
    expect(coordinator.stats.totalRunMs).toBeGreaterThanOrEqual(0);
  });

  it("cancels a queued chat run and waits for its ownership record to settle", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const active = coordinator.schedule({ chatId: 1, userId: 10 }, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    active.start();
    await vi.waitFor(() => expect(coordinator.stats.active).toBe(1));

    const queuedTask = vi.fn(async () => undefined);
    const queued = coordinator.schedule({ chatId: 2, userId: 20 }, queuedTask);
    queued.start();
    expect(queued.queued).toBe(true);

    await expect(coordinator.cancelChat(2)).resolves.toEqual({
      cancelled: 1,
      settled: true,
      timedOut: false,
    });
    await expect(queued.result).rejects.toBeInstanceOf(AiRunCancelledError);
    expect(queuedTask).not.toHaveBeenCalled();
    expect(coordinator.stats.cancelled).toBe(1);

    coordinator.cancelAllNow();
    await expect(active.result).rejects.toBeInstanceOf(AiRunCancelledError);
  });

  it("counts bounded-queue rejections without registering a run", () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1, maxQueued: 0 });
    const active = coordinator.schedule({ chatId: 1 }, async () => undefined);

    expect(() => coordinator.schedule({ chatId: 2 }, async () => undefined)).toThrow(
      "AI reply queue is full",
    );
    expect(coordinator.stats).toMatchObject({ rejected: 1, tracked: 1, queued: 0 });
    coordinator.destroy();
    void active.result.catch(() => {});
  });

  it("keeps identical Chat IDs isolated across Bot-owned coordinators", async () => {
    const firstBot = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const secondBot = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const first = firstBot.schedule({ chatId: 1, userId: 9 }, async () => firstGate.promise);
    const second = secondBot.schedule({ chatId: 1, userId: 9 }, async () => secondGate.promise);

    first.start();
    second.start();
    await vi.waitFor(() => {
      expect(firstBot.stats.active).toBe(1);
      expect(secondBot.stats.active).toBe(1);
    });

    firstGate.resolve(undefined);
    secondGate.resolve(undefined);
    await Promise.all([first.result, second.result]);
  });

  it("lets an unrelated user run while the same user waits across chats", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 2 });
    const activeGate = deferred<void>();
    const activeTask = vi.fn(async () => activeGate.promise);
    const blockedTask = vi.fn(async () => undefined);
    const unrelatedTask = vi.fn(async () => undefined);
    const active = coordinator.schedule({ chatId: 1, userId: 10 }, activeTask);
    active.start();
    await vi.waitFor(() => expect(activeTask).toHaveBeenCalledOnce());

    const blocked = coordinator.schedule({ chatId: 2, userId: 10 }, blockedTask);
    const unrelated = coordinator.schedule({ chatId: 3, userId: 20 }, unrelatedTask);
    blocked.start();
    unrelated.start();

    expect(blocked.queued).toBe(true);
    expect(unrelated.queued).toBe(false);
    await expect(unrelated.result).resolves.toBeUndefined();
    expect(blockedTask).not.toHaveBeenCalled();
    expect(coordinator.stats).toMatchObject({ active: 1, activeUsers: 1, queued: 1 });

    activeGate.resolve();
    await active.result;
    await expect(blocked.result).resolves.toBeUndefined();
    expect(blockedTask).toHaveBeenCalledOnce();
    expect(coordinator.stats).toMatchObject({ active: 0, activeUsers: 0, queued: 0 });
  });

  it("aborts active user runs and invalidates their ownership epoch", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 2 });
    let isCurrent: (() => boolean) | undefined;
    const run = coordinator.schedule({ chatId: 1, userId: 9 }, async (context) => {
      isCurrent = context.isCurrent;
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve()),
      );
      expect(context.isCurrent()).toBe(false);
    });
    run.start();
    await vi.waitFor(() => expect(isCurrent).toBeDefined());

    await expect(coordinator.cancelUser(9)).resolves.toEqual({
      cancelled: 1,
      settled: true,
      timedOut: false,
    });
    await expect(run.result).rejects.toBeInstanceOf(AiRunCancelledError);
    expect(isCurrent?.()).toBe(false);

    const replacementTask = vi.fn(async () => undefined);
    const replacement = coordinator.schedule({ chatId: 2, userId: 9 }, replacementTask);
    expect(replacement.queued).toBe(false);
    replacement.start();
    await expect(replacement.result).resolves.toBeUndefined();
    expect(replacementTask).toHaveBeenCalledOnce();
    expect(coordinator.stats).toMatchObject({ active: 0, activeUsers: 0, queued: 0 });
  });

  it("destroys queued work and rejects future scheduling", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const active = coordinator.schedule({ chatId: 1, userId: 9 }, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    active.start();
    const activeRejection = active.result.catch((error) => error);
    const queued = coordinator.schedule({ chatId: 2, userId: 9 }, async () => undefined);
    queued.start();
    const queuedRejection = queued.result.catch((error) => error);

    coordinator.destroy();

    await expect(activeRejection).resolves.toBeInstanceOf(AiRunCancelledError);
    await expect(queuedRejection).resolves.toBeInstanceOf(AiRunCancelledError);
    expect(coordinator.stats).toMatchObject({ active: 0, activeUsers: 0, queued: 0 });
    expect(() => coordinator.schedule({ chatId: 3 }, async () => undefined)).toThrow(
      "AI runtime has been destroyed",
    );
  });

  it("reports a timeout when a cancelled run does not settle", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const gate = deferred<void>();
    const run = coordinator.schedule({ chatId: 1, userId: 9 }, async () => gate.promise);
    run.start();
    await vi.waitFor(() => expect(coordinator.stats.started).toBe(1));

    await expect(coordinator.cancelChat(1, undefined, 0)).resolves.toEqual({
      cancelled: 1,
      settled: false,
      timedOut: true,
    });

    gate.resolve();
    await expect(run.result).rejects.toBeInstanceOf(AiRunCancelledError);
  });

  it("does not count a cancelled admitted run as started", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const task = vi.fn(async () => undefined);
    const run = coordinator.schedule({ chatId: 1 }, task);

    await expect(coordinator.cancelChat(1)).resolves.toMatchObject({ settled: true });
    await expect(run.result).rejects.toBeInstanceOf(AiRunCancelledError);
    expect(task).not.toHaveBeenCalled();
    expect(coordinator.stats).toMatchObject({ started: 0, completed: 0, totalRunMs: 0 });
  });

  it("destroys and drains active work before reporting settlement", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const run = coordinator.schedule({ chatId: 1 }, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    run.start();
    await vi.waitFor(() => expect(coordinator.stats.started).toBe(1));

    await expect(coordinator.destroyAndDrain()).resolves.toEqual({
      cancelled: 1,
      settled: true,
      timedOut: false,
    });
    await expect(run.result).rejects.toBeInstanceOf(AiRunCancelledError);
  });

  it("reports destroy drain timeouts instead of treating them as settled", async () => {
    const coordinator = new AiExecutionCoordinator({ maxConcurrent: 1 });
    const gate = deferred<void>();
    const run = coordinator.schedule({ chatId: 1 }, async () => gate.promise);
    run.start();
    await vi.waitFor(() => expect(coordinator.stats.started).toBe(1));

    await expect(coordinator.destroyAndDrain(undefined, 0)).resolves.toEqual({
      cancelled: 1,
      settled: false,
      timedOut: true,
    });

    gate.resolve();
    await expect(run.result).rejects.toBeInstanceOf(AiRunCancelledError);
    await expect(coordinator.destroyAndDrain()).resolves.toEqual({
      cancelled: 0,
      settled: true,
      timedOut: false,
    });
  });
});
