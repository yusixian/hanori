import { describe, expect, it } from "vitest";
import { isTimeoutError } from "./errors.js";

describe("isTimeoutError", () => {
  it.each(["UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"])(
    "recognizes %s inside a generic terminated error",
    (code) => {
      const error = new TypeError("terminated", { cause: { code } });
      expect(isTimeoutError(error)).toBe(true);
    },
  );

  it("keeps socket disconnects and cancellations distinct from timeouts", () => {
    expect(isTimeoutError(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }))).toBe(
      false,
    );
    expect(isTimeoutError(new DOMException("Aborted", "AbortError"))).toBe(false);
  });

  it("recognizes configured deadlines through nested wrappers", () => {
    expect(
      isTimeoutError(
        new Error("model failed", {
          cause: new DOMException("Deadline exceeded", "TimeoutError"),
        }),
      ),
    ).toBe(true);
    expect(isTimeoutError(new Error("Per-step timeout: 600000ms exceeded"))).toBe(true);
  });

  it("bounds cyclic error chains", () => {
    const error = new Error("terminated");
    error.cause = error;
    expect(isTimeoutError(error)).toBe(false);
  });
});
