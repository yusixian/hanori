import { describe, expect, it } from "vitest";
import { classifyProviderError, redactDiagnostic } from "./run-redaction.js";

describe("redactDiagnostic", () => {
  it("redacts nested keys, bearer values, and known secrets before persistence", () => {
    expect(
      redactDiagnostic(
        {
          authorization: "Bearer visible",
          nested: [{ apiKey: "visible" }, "secret-value appeared in an error"],
        },
        ["secret-value"],
      ),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: [{ apiKey: "[REDACTED]" }, "[REDACTED] appeared in an error"],
    });
  });

  it("serializes error chains without leaking credentials", () => {
    const cause = new Error("Bearer abc.def");
    const error = new Error("request failed", { cause });
    expect(JSON.stringify(redactDiagnostic(error))).not.toContain("abc.def");
  });

  it("marks oversized strings as truncated", () => {
    expect(redactDiagnostic("x".repeat(70_000))).toMatch(/\[truncated\]$/);
  });

  it("handles circular structures and leaves short secret candidates alone", () => {
    const value: Record<string, unknown> = { count: 1, enabled: true, empty: null };
    value["self"] = value;
    expect(redactDiagnostic(value, ["abc"])).toEqual({
      count: 1,
      enabled: true,
      empty: null,
      self: "[Circular]",
    });
  });
});

describe("classifyProviderError", () => {
  it.each([
    [new Error("connect failed"), false, "provider_request_failed"],
    [new Error("stream reset"), true, "provider_stream_failed"],
    [new Error("request timed out"), true, "timed_out"],
    [new DOMException("aborted", "AbortError"), true, "cancelled"],
    [new Error("cancelled by operator"), false, "cancelled"],
    ["plain failure", false, "provider_request_failed"],
  ])("classifies %s", (error, started, expected) => {
    expect(classifyProviderError(error, started)).toBe(expected);
  });
});
