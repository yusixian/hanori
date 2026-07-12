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

  it("preserves provider error diagnostics while redacting sensitive fields", () => {
    const error = Object.assign(new Error("upstream rejected the request"), {
      statusCode: 403,
      url: "https://example.test/v1/chat/completions?token=test-secret",
      responseBody: JSON.stringify({ error: "test-secret is not authorized" }),
      data: { authorization: "Bearer visible", reason: "forbidden" },
      isRetryable: false,
    });

    expect(redactDiagnostic(error, ["test-secret"])).toMatchObject({
      name: "Error",
      message: "upstream rejected the request",
      statusCode: 403,
      url: "https://example.test/v1/chat/completions?token=[REDACTED]",
      responseBody: JSON.stringify({ error: "[REDACTED] is not authorized" }),
      data: { authorization: "[REDACTED]", reason: "forbidden" },
      isRetryable: false,
    });
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
