import { describe, expect, it } from "vitest";
import { APP_SECURITY_HEADERS, staticCacheControl } from "./http-policy.js";

describe("production HTTP policy", () => {
  it("allows the Telegram SDK while denying object and unexpected framing origins", () => {
    const csp = APP_SECURITY_HEADERS["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self' https://telegram.org");
    expect(csp).toContain("frame-ancestors https://web.telegram.org https://*.telegram.org");
    expect(csp).toContain("object-src 'none'");
    expect(APP_SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("caches hashed assets immutably but always revalidates HTML routes", () => {
    expect(staticCacheControl("/assets/index-C4F9A.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(staticCacheControl("/mini-app/bot/help")).toBe("no-cache, no-store, must-revalidate");
    expect(staticCacheControl("/index.html")).toBe("no-cache, no-store, must-revalidate");
  });
});
