import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { watchDaemon } from "./server.mjs";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("clears timeout handles when status and restart both fail to spawn", async () => {
  vi.useFakeTimers();
  const children = [];
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    children.push(child);
    return child;
  });
  const watch = watchDaemon({
    command: ["missing-lody"],
    machineName: "test",
    intervalMs: 0,
    log: vi.fn(),
  });
  const tick = watch.tick();
  expect(vi.getTimerCount()).toBe(1);
  children[0].emit("error", Object.assign(new Error("missing binary"), { code: "ENOENT" }));
  await Promise.resolve();
  expect(children).toHaveLength(2);
  children[1].emit("error", Object.assign(new Error("missing binary"), { code: "ENOENT" }));
  await tick;
  await watch.idle();
  expect(watch.state.daemon).toBe("down");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(children.every((child) => child.kill.mock.calls.length === 0)).toBe(true);
  watch.stop();
});
