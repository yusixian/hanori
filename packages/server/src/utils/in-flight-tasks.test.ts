import { expect, it } from "vitest";
import { InFlightTasks } from "./in-flight-tasks.js";

it("drains child work registered by an admitted operation while closing", async () => {
  const tasks = new InFlightTasks();
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  const parent = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  const child = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  tasks.track(
    parent.then(() => {
      tasks.track(child);
    }),
  );
  let drained = false;
  const drain = tasks.drain().then(() => {
    drained = true;
  });
  releaseParent();
  await parent;
  await Promise.resolve();
  expect(drained).toBe(false);
  releaseChild();
  await drain;
  expect(drained).toBe(true);
});

it("preserves caller results and failures while draining all work", async () => {
  const tasks = new InFlightTasks();
  const success = Promise.resolve(42);
  const failure = Promise.reject(new Error("operation failed"));
  expect(tasks.track(success)).toBe(success);
  expect(tasks.track(failure)).toBe(failure);
  await expect(success).resolves.toBe(42);
  await expect(failure).rejects.toThrow("operation failed");
  await expect(tasks.drain()).resolves.toBeUndefined();
  await expect(tasks.drain()).resolves.toBeUndefined();
});
