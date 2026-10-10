import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationRetention } from "./conversation-retention.js";
const hour = 60 * 60 * 1000;
const active = [
  { id: "a", retentionDays: 30 },
  { id: "disabled", retentionDays: 0 },
];
const schedulers: ConversationRetention[] = [];
function setup() {
  vi.useFakeTimers();
  const cleanup = vi.fn(async (_id: string, _days: number) => {});
  const listActiveBots = vi.fn(async () => active);
  const warn = vi.fn();
  const retention = new ConversationRetention({ cleanup, listActiveBots, warn });
  schedulers.push(retention);
  return { retention, cleanup, listActiveBots, warn };
}
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((s) => s.stop()));
  vi.useRealTimers();
});

describe("conversation retention", () => {
  it("throttles per bot, preserves disabled retention and expires the throttle", async () => {
    const { retention, cleanup } = setup();
    await retention.trigger("a", 30);
    await retention.trigger("a", 30);
    await retention.trigger("b", 7);
    await retention.trigger("disabled", 0);
    expect(cleanup.mock.calls).toEqual([
      ["a", 30],
      ["b", 7],
    ]);
    await vi.advanceTimersByTimeAsync(hour);
    await retention.trigger("a", 30);
    expect(cleanup).toHaveBeenCalledTimes(3);
  });
  it("permits the next message to retry a failed cleanup", async () => {
    const { retention, cleanup } = setup();
    cleanup.mockRejectedValueOnce(new Error("offline"));
    await retention.trigger("a", 30);
    await retention.trigger("a", 30);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it("runs a nonblocking startup sweep and drains one shared task on stop", async () => {
    const { retention, cleanup } = setup();
    const task = deferred<void>();
    cleanup.mockReturnValue(task.promise);
    retention.start(active);
    const duplicate = retention.trigger("a", 30);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = vi.fn();
    const stopping = retention.stop().then(stopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(stopped).not.toHaveBeenCalled();
    await retention.trigger("b", 7);
    expect(cleanup).toHaveBeenCalledOnce();
    task.resolve();
    await Promise.all([stopping, duplicate]);
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses one timer and reloads policies every sweep", async () => {
    const { retention, cleanup, listActiveBots } = setup();
    retention.start(active);
    retention.start(active);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith("a", 30);
    listActiveBots.mockResolvedValue([{ id: "a", retentionDays: 5 }]);
    await vi.advanceTimersByTimeAsync(hour);
    expect(cleanup).toHaveBeenLastCalledWith("a", 5);
    expect(vi.getTimerCount()).toBe(1);
    await retention.stop();
    await vi.advanceTimersByTimeAsync(hour * 2);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it("recovers from query failure and never cleans a late query after stop", async () => {
    const { retention, cleanup, listActiveBots, warn } = setup();
    retention.start([]);
    listActiveBots.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(hour);
    expect(warn).toHaveBeenCalledOnce();
    const query = deferred<typeof active>();
    listActiveBots.mockReturnValueOnce(query.promise);
    await vi.advanceTimersByTimeAsync(hour * 2);
    expect(listActiveBots).toHaveBeenCalledTimes(2);
    const stopping = retention.stop();
    query.resolve(active);
    await stopping;
    expect(cleanup).not.toHaveBeenCalled();
    retention.start(active);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith("a", 30);
  });
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
