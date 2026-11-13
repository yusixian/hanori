import { describe, expect, it } from "vitest";
import { normalizeQuoteColor, parseQuoteSource } from "./quote.js";
describe("quote contracts", () => {
  it.each(["constructor", "toString", "__proto__", "#fff", "red"])(
    "rejects unsupported color %s",
    (value) => expect(normalizeQuoteColor(value)).toBeUndefined(),
  );
  it("normalizes presets and hex", () => {
    expect(normalizeQuoteColor(" AI ")).toBe("#251D3A");
    expect(normalizeQuoteColor("#aabbcc")).toBe("#AABBCC");
  });
  it("requires explicit topic and strips arbitrary update fields", () => {
    const value = {
      version: 1,
      messageId: 1,
      capturedAt: 1,
      text: "a",
      entities: [],
      author: { key: "u", name: "A" },
      privacyUserIds: [],
      rawUpdate: "secret",
    };
    expect(parseQuoteSource(value)).toBeUndefined();
    expect(parseQuoteSource({ ...value, threadId: null })).not.toHaveProperty("rawUpdate");
    expect(
      parseQuoteSource({
        ...value,
        threadId: null,
        entities: [{ type: "bold", offset: 1, length: 1 }],
      }),
    ).toBeUndefined();
  });
});
