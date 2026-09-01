import { describe, expect, it } from "vitest";
import { isWebpageUrlBlocked } from "./web.js";

describe("isWebpageUrlBlocked", () => {
  it("allows public URLs", () => {
    expect(isWebpageUrlBlocked("https://example.com/page")).toBe(false);
  });

  it("allows explicitly trusted private hosts", () => {
    expect(isWebpageUrlBlocked("http://localhost:3000/health", ["localhost"])).toBe(false);
    expect(isWebpageUrlBlocked("http://192.168.1.20/status", ["192.168.1.20"])).toBe(false);
    expect(isWebpageUrlBlocked("http://api.home.arpa/status", ["*.home.arpa"])).toBe(false);
  });

  it("keeps metadata and link-local targets blocked", () => {
    expect(
      isWebpageUrlBlocked("http://169.254.169.254/latest/meta-data", ["169.254.169.254"]),
    ).toBe(true);
    expect(
      isWebpageUrlBlocked("http://metadata.google.internal/", ["metadata.google.internal"]),
    ).toBe(true);
  });
});
