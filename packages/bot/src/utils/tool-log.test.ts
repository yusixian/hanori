import { describe, expect, it } from "vitest";
import { toToolLogValue } from "./tool-log.js";

describe("toToolLogValue", () => {
  it("preserves tool queries and structured results", () => {
    expect(
      toToolLogValue({
        query: "博丽灵梦",
        limit: 8,
        result: { tags: [{ name: "hakurei_reimu", postCount: 42_000 }] },
      }),
    ).toEqual({
      query: "博丽灵梦",
      limit: 8,
      result: { tags: [{ name: "hakurei_reimu", postCount: 42_000 }] },
    });
  });

  it("redacts credential fields and bearer values", () => {
    expect(
      toToolLogValue({
        query: "safe",
        apiKey: "secret-key",
        nested: { authorization: "Bearer abc.def", cookie: "session=secret" },
        note: "request used Bearer visible-token",
      }),
    ).toEqual({
      query: "safe",
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
      note: "request used Bearer [REDACTED]",
    });
  });

  it("keeps diagnostic token counters", () => {
    expect(toToolLogValue({ maxTokens: 4096, tokenCount: 123 })).toEqual({
      maxTokens: 4096,
      tokenCount: 123,
    });
  });

  it("normalizes circular and binary values for JSON storage", () => {
    const value: Record<string, unknown> = { bytes: new Uint8Array(12) };
    value["self"] = value;

    expect(toToolLogValue(value)).toEqual({
      bytes: { type: "Uint8Array", byteLength: 12 },
      self: "[Circular]",
    });
  });
});
