import { expect, it, vi } from "vitest";
import { abortable } from "./abortable.js";

it("preserves operation results and failures and removes the abort listener", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  await expect(abortable(Promise.resolve(42), controller.signal)).resolves.toBe(42);
  const error = new Error("operation failed");
  await expect(abortable(Promise.reject(error), controller.signal)).rejects.toBe(error);
  expect(remove).toHaveBeenCalledTimes(2);
});

it("stops waiting promptly and consumes a late operation rejection", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  let fail!: (reason: Error) => void;
  const operation = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const result = abortable(operation, controller.signal);
  const expected = expect(result).rejects.toBe("cancelled");
  controller.abort("cancelled");
  await expected;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  fail(new Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

it("handles an already-started rejection even when the signal was aborted first", async () => {
  const controller = new AbortController();
  const reason = new Error("already stopped");
  controller.abort(reason);
  await expect(
    abortable(Promise.reject(new Error("operation failed")), controller.signal),
  ).rejects.toBe(reason);
  await new Promise((resolve) => setImmediate(resolve));
});
