import { describe, expect, it } from "vitest";
import { classifyProviderError, redactDiagnostic } from "./run-redaction.js";

describe("redactDiagnostic", () => {
  it("scrubs pasted deployment settings while preserving diagnostic context", () => {
    const input = [
      "ENCRYPTION_KEY=fixture-encryption-value",
      "DATABASE_URL=postgresql://service:fixture%40password@db.example/app",
      "BETTER_AUTH_SECRET='fixture secret'",
      "input_token=9",
    ].join("\n");
    expect(redactDiagnostic({ text: input })).toEqual({
      text: [
        "ENCRYPTION_KEY=[REDACTED]",
        "DATABASE_URL=postgresql://service:[REDACTED]@db.example/app",
        "BETTER_AUTH_SECRET='[REDACTED]'",
        "input_token=9",
      ].join("\n"),
    });
  });

  it("redacts complete quoted assignments while preserving surrounding diagnostics", () => {
    expect(redactDiagnostic('password: "alpha beta gamma"; status=403')).toBe(
      'password: "[REDACTED]"; status=403',
    );
    expect(redactDiagnostic("api_key='alpha beta'; reason=forbidden")).toBe(
      "api_key='[REDACTED]'; reason=forbidden",
    );
    const raw = JSON.stringify({ password: 'alpha"beta gamma', reason: "forbidden" });
    expect(JSON.parse(redactDiagnostic(raw) as string)).toEqual({
      password: "[REDACTED]",
      reason: "forbidden",
    });
  });

  it("keeps redacted headers stable across repeated logging", () => {
    const raw = "Authorization: Bearer test-secret\nstatus=403";
    const expected = "Authorization: [REDACTED]\nstatus=403";
    expect(redactDiagnostic(raw)).toBe(expected);
    expect(redactDiagnostic(expected)).toBe(expected);
  });

  it("redacts prefixed headers and unterminated quoted values", () => {
    expect(redactDiagnostic("X-Api-Key: fake-provider-key\nstatus=403")).toBe(
      "X-Api-Key: [REDACTED]\nstatus=403",
    );
    expect(redactDiagnostic("x-access-token=fake-token&status=403")).toBe(
      "x-access-token=[REDACTED]&status=403",
    );
    expect(redactDiagnostic('password: "alpha beta gamma')).toBe('password: "[REDACTED]"');
    expect(redactDiagnostic("password='alpha beta\\")).toBe("password='[REDACTED]'");
  });

  it.each(['alpha\\"beta gamma', "alpha\\\\beta gamma", "alpha\nbeta gamma"])(
    "preserves JSON diagnostics while redacting escaped credential %j",
    (password) => {
      const raw = JSON.stringify({ password, reason: "forbidden", inputTokens: 12 });
      const expected = JSON.stringify({
        password: "[REDACTED]",
        reason: "forbidden",
        inputTokens: 12,
      });
      expect(redactDiagnostic(raw)).toBe(expected);
      expect(redactDiagnostic(expected)).toBe(expected);
    },
  );

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

  it("redacts credential assignments without erasing token usage metrics", () => {
    expect(
      redactDiagnostic({
        inputTokens: 120,
        promptToken: 88,
        output_tokens: 8,
        maxTokens: 4_096,
        tokenUsage: { cached: 32 },
        accessToken: "credential",
        detail: 'api_key=test-key token=second password: "third"',
      }),
    ).toEqual({
      inputTokens: 120,
      promptToken: 88,
      output_tokens: 8,
      maxTokens: 4_096,
      tokenUsage: { cached: 32 },
      accessToken: "[REDACTED]",
      detail: 'api_key=[REDACTED] token=[REDACTED] password: "[REDACTED]"',
    });
  });

  it("serializes error chains without leaking credentials", () => {
    const cause = new Error("Bearer abc.def");
    const error = new Error("request failed", { cause });
    const redacted = redactDiagnostic(error) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain("abc.def");
    expect(redacted).toMatchObject({
      name: "Error",
      message: "request failed",
      stack: expect.stringContaining("request failed"),
      cause: {
        name: "Error",
        message: "Bearer [REDACTED]",
        stack: expect.stringContaining("Bearer [REDACTED]"),
      },
    });
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

  it("redacts and bounds error names like other diagnostic text", () => {
    const error = new Error("request failed");
    error.name = "Provider test-secret token=credential";
    expect(redactDiagnostic(error, ["test-secret"])).toMatchObject({
      name: "Provider [REDACTED] token=[REDACTED]",
      message: "request failed",
    });
    error.name = "x".repeat(70_000);
    const result = redactDiagnostic(error) as { name: string };
    expect(result.name.length).toBeLessThan(66_000);
    expect(result.name).toMatch(/\[truncated: diagnostic text limit\]$/);
  });

  it.each([
    [Buffer.from("synthetic binary payload"), "Buffer", 24],
    [new Uint16Array([1, 2, 3]), "Uint16Array", 6],
    [new DataView(new ArrayBuffer(20), 4, 8), "DataView", 8],
    [new ArrayBuffer(12), "ArrayBuffer", 12],
  ])("summarizes %s without serializing its bytes", (bytes, type, byteLength) => {
    expect(redactDiagnostic({ payload: bytes, statusCode: 200 })).toEqual({
      payload: { type, byteLength },
      statusCode: 200,
    });
    expect(redactDiagnostic({ apiKey: bytes })).toEqual({ apiKey: "[REDACTED]" });
  });

  it("marks oversized strings as truncated", () => {
    expect(redactDiagnostic("x".repeat(70_000))).toMatch(/\[truncated: diagnostic text limit\]$/);
  });

  it("bounds collections and marks omitted values explicitly", () => {
    const redacted = redactDiagnostic(
      Array.from({ length: 250 }, (_, index) => index),
    ) as unknown[];
    expect(redacted).toHaveLength(201);
    expect(redacted.at(-1)).toBe("[truncated: 50 items omitted]");
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
    [new TypeError("terminated", { cause: { code: "UND_ERR_BODY_TIMEOUT" } }), true, "timed_out"],
    [
      new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }),
      true,
      "provider_stream_failed",
    ],
    [
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      true,
      "timed_out",
    ],
    [new DOMException("aborted", "AbortError"), true, "cancelled"],
    [new Error("cancelled by operator"), false, "cancelled"],
    ["plain failure", false, "provider_request_failed"],
  ])("classifies %s", (error, started, expected) => {
    expect(classifyProviderError(error, started)).toBe(expected);
  });
});
