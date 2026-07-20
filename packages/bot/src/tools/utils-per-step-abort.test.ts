import { afterEach, describe, expect, it, vi } from "vitest";
import { createPerStepAbort } from "./utils.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createPerStepAbort", () => {
  it("pauses the model-step deadline while reference-counted tools are running", () => {
    vi.useFakeTimers();
    const overall = new AbortController();
    const perStep = createPerStepAbort(1_000, overall.signal);

    perStep.pause();
    perStep.pause();
    vi.advanceTimersByTime(5_000);
    expect(perStep.signal.aborted).toBe(false);

    perStep.resume();
    vi.advanceTimersByTime(5_000);
    expect(perStep.signal.aborted).toBe(false);

    perStep.resume();
    vi.advanceTimersByTime(999);
    expect(perStep.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(perStep.signal.aborted).toBe(true);
    perStep.cleanup();
  });

  it("keeps overall cancellation active while the step timer is paused", () => {
    const overall = new AbortController();
    const perStep = createPerStepAbort(60_000, overall.signal);
    perStep.pause();

    overall.abort(new Error("stopped"));

    expect(perStep.signal.aborted).toBe(true);
    expect(perStep.signal.reason).toBe(overall.signal.reason);
    perStep.cleanup();
  });
});
