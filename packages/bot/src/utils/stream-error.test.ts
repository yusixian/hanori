import { describe, expect, it } from "vitest";
import { resolveCompleteStreamText, throwCapturedStreamError } from "./stream-error.js";

describe("throwCapturedStreamError", () => {
  it("preserves the actionable stream failure before aggregate text is read", () => {
    const providerError = new Error("upstream returned invalid SSE data");
    expect(() => throwCapturedStreamError(providerError, false)).toThrow(providerError);
  });

  it("allows fallback output that was already sent", () => {
    expect(() => throwCapturedStreamError(new Error("draft transport failed"), true)).not.toThrow();
  });
});

describe("resolveCompleteStreamText", () => {
  it("waits for the complete provider result after a delivery stream fails", async () => {
    let resolveText!: (text: string) => void;
    const textResult = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    let settled = false;
    const completeText = resolveCompleteStreamText(
      textResult,
      new Error("draft transport failed"),
    ).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveText("  first second third  ");
    await expect(completeText).resolves.toBe("first second third");
  });

  it("keeps the original stream error when aggregate text rejects", async () => {
    const providerError = new Error("provider disconnected");

    await expect(
      resolveCompleteStreamText(Promise.reject(new Error("No output generated")), providerError),
    ).rejects.toBe(providerError);
  });
});
