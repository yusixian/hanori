import { describe, expect, it } from "vitest";
import { resolveApiTestUrl } from "./api-test.js";

describe("resolveApiTestUrl", () => {
  it("joins a relative endpoint to the configured base URL", () => {
    expect(resolveApiTestUrl("https://api.example.com/v1/", "/models")).toBe(
      "https://api.example.com/v1/models",
    );
  });

  it("accepts a complete request URL", () => {
    expect(resolveApiTestUrl("https://api.example.com/v1", "http://localhost:11434/api/tags")).toBe(
      "http://localhost:11434/api/tags",
    );
  });

  it("does not require a base URL for a complete request URL", () => {
    expect(resolveApiTestUrl("", "http://localhost:11434/api/tags")).toBe(
      "http://localhost:11434/api/tags",
    );
  });
});
