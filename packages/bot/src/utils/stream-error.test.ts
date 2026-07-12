import { describe, expect, it } from "vitest";
import { throwCapturedStreamError } from "./stream-error.js";

describe("throwCapturedStreamError", () => {
  it("preserves the actionable stream failure before aggregate text is read", () => {
    const providerError = new Error("upstream returned invalid SSE data");
    expect(() => throwCapturedStreamError(providerError, false)).toThrow(providerError);
  });

  it("allows fallback output that was already sent", () => {
    expect(() => throwCapturedStreamError(new Error("draft transport failed"), true)).not.toThrow();
  });
});
