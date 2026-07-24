import { describe, expect, it } from "vitest";
import { isTextCoveredByDeliveries } from "./delivery.js";

describe("delivery coverage", () => {
  it("recognizes a trailing response already sent across multiple messages", () => {
    expect(
      isTextCoveredByDeliveries("result one\nresult two", [
        "ack one",
        "ack two",
        "result one",
        "result two",
      ]),
    ).toBe(true);
  });

  it("keeps a final response that was not confirmed as delivered", () => {
    expect(isTextCoveredByDeliveries("result one\nresult two", ["ack one", "ack two"])).toBe(false);
  });
});
