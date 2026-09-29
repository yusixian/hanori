import { describe, expect, it } from "vitest";
import { AI_SETTING_BOUNDS, clampToBounds, isWithinBounds } from "./bounds.js";

const { randomReplyCooldown, randomReplyPercent } = AI_SETTING_BOUNDS;

describe("AI setting bounds", () => {
  it("accepts only in-range values, and only whole numbers for integer settings", () => {
    expect(isWithinBounds(86_400, randomReplyCooldown)).toBe(true);
    expect(isWithinBounds(86_401, randomReplyCooldown)).toBe(false);
    expect(isWithinBounds(1.5, randomReplyCooldown)).toBe(false);
    expect(isWithinBounds(-1, randomReplyCooldown)).toBe(false);
    expect(isWithinBounds("60", randomReplyCooldown)).toBe(false);
    expect(isWithinBounds(0.5, randomReplyPercent)).toBe(true);
    expect(isWithinBounds(Number.NaN, randomReplyPercent)).toBe(false);
  });

  it("rounds integer settings and clamps values into range", () => {
    expect(clampToBounds(90_000, randomReplyCooldown)).toBe(86_400);
    expect(clampToBounds(1.5, randomReplyCooldown)).toBe(2);
    expect(clampToBounds(-5, randomReplyCooldown)).toBe(0);
    expect(clampToBounds(0.5, randomReplyPercent)).toBe(0.5);
    expect(clampToBounds(0.4, AI_SETTING_BOUNDS.maxContextMessages)).toBe(1);
  });
});
