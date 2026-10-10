import { expect, it, vi } from "vitest";
import { REQUEST_STATES as S } from "./states.js";
import { bug, onlyRequest, setup } from "./work-test-helpers.js";

it("close during machine discovery leaves queued work unstarted", async () => {
  const ctx = await setup();
  await bug(ctx);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = ctx.lody.listMachines.bind(ctx.lody);
  const discovery = vi.spyOn(ctx.lody, "listMachines").mockImplementationOnce(async () => {
    await pending;
    return original();
  });
  const tick = ctx.service.work.scheduler.tick();
  await vi.waitFor(() => expect(discovery).toHaveBeenCalledOnce());
  const closing = ctx.service.close();
  const closed = vi.fn();
  void closing.then(closed);
  expect(ctx.service.close()).toBe(closing);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  release();
  await tick;
  await closing;
  expect(ctx.lody.created).toHaveLength(0);
  expect(onlyRequest(ctx).state).toBe(S.queued);
  await ctx.service.work.scheduler.tick();
  expect(discovery).toHaveBeenCalledOnce();
});

it("close waits for a submitted session to be persisted and skips later scheduler steps", async () => {
  const ctx = await setup();
  await bug(ctx);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = ctx.lody.createSession.bind(ctx.lody);
  const create = vi.spyOn(ctx.lody, "createSession").mockImplementationOnce(async (input) => {
    const result = await original(input);
    await pending;
    return result;
  });
  const resync = vi.spyOn(ctx.service.prFlow, "resyncDue");
  const tick = ctx.service.work.scheduler.tick();
  expect(ctx.service.work.scheduler.tick()).toBe(tick);
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const closing = ctx.service.close();
  const closed = vi.fn();
  void closing.then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  expect(onlyRequest(ctx).state).toBe(S.starting);
  release();
  await closing;
  expect(onlyRequest(ctx).state).toBe(S.running);
  expect((await ctx.store.latestJob(onlyRequest(ctx).id))?.sessionId).toBeTruthy();
  expect(ctx.lody.created).toHaveLength(1);
  expect(resync).not.toHaveBeenCalled();
});

it("stop remains restartable while close permanently disables scheduling", async () => {
  const ctx = await setup();
  ctx.service.stop();
  vi.useFakeTimers();
  try {
    const scheduler = ctx.service.work.scheduler;
    const tick = vi.spyOn(scheduler, "tick");
    scheduler.start();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledOnce();
    await ctx.service.close();
    scheduler.start();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    ctx.service.stop();
    vi.useRealTimers();
  }
});

it("close waits for the accepted session ID write before finishing", async () => {
  const ctx = await setup();
  await bug(ctx);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = vi.fn();
  const original = ctx.store.updateJob.bind(ctx.store);
  vi.spyOn(ctx.store, "updateJob").mockImplementation(async (id, patch) => {
    if (patch.sessionId) {
      writing();
      await pending;
    }
    return original(id, patch);
  });
  const tick = ctx.service.work.scheduler.tick();
  await vi.waitFor(() => expect(writing).toHaveBeenCalledOnce());
  const closing = ctx.service.close();
  const closed = vi.fn();
  void closing.then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  expect(ctx.lody.created).toHaveLength(1);
  release();
  await tick;
  await closing;
  expect(onlyRequest(ctx).state).toBe(S.running);
  expect((await ctx.store.latestJob(onlyRequest(ctx).id))?.sessionId).toBeTruthy();
});
