import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  APP_SECURITY_HEADERS,
  MINI_APP_SECURITY_HEADERS,
  securityHeaders,
  staticCacheControl,
} from "./http-policy.js";
import { RuntimeHealth } from "./runtime-health.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.AUTH_OWNER_EMAIL ??= "owner@example.com";

let createApp: (typeof import("./app.js"))["createApp"];
const TEST_SHA = "0123456789abcdef0123456789abcdef01234567";

beforeAll(async () => {
  ({ createApp } = await import("./app.js"));
});

describe("production HTTP policy", () => {
  it("isolates Telegram framing and SDK permissions to Mini App HTML routes", () => {
    const adminCsp = APP_SECURITY_HEADERS["Content-Security-Policy"];
    const miniAppCsp = MINI_APP_SECURITY_HEADERS["Content-Security-Policy"];
    expect(adminCsp).toContain("script-src 'self'");
    expect(adminCsp).not.toContain("https://telegram.org");
    expect(adminCsp).toContain("frame-ancestors 'none'");
    expect(miniAppCsp).toContain("script-src 'self' https://telegram.org");
    expect(miniAppCsp).toContain("frame-ancestors https://web.telegram.org https://*.telegram.org");
    expect(miniAppCsp).toContain("object-src 'none'");
    expect(securityHeaders("/mini-app/bot/help")).toBe(MINI_APP_SECURITY_HEADERS);
    expect(securityHeaders("/api/mini-app/bot/session")).toBe(APP_SECURITY_HEADERS);
    expect(APP_SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("caches hashed assets immutably but always revalidates HTML routes", () => {
    expect(staticCacheControl("/assets/index-C4F9A.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(staticCacheControl("/mini-app/bot/help")).toBe("no-cache, no-store, must-revalidate");
    expect(staticCacheControl("/index.html")).toBe("no-cache, no-store, must-revalidate");
  });

  it("keeps unmatched API requests out of the SPA fallback", async () => {
    const app = createApp({
      db: {} as never,
      auth: { handler: vi.fn() } as never,
      baseURL: "https://bot.example.test",
      botPool: {} as never,
      encryptionKey: "test-key",
      backupService: {} as never,
      modelCapabilityService: {} as never,
      timerRegistry: {} as never,
      rssFeedService: {} as never,
      mcpClientManager: {} as never,
      summaryService: {} as never,
      summaryConfigService: {} as never,
      githubAppService: {} as never,
      miniAppSessionSecret: "x".repeat(32),
      telegramDirectoryService: {} as never,
      telegramMembershipVerifier: {} as never,
      miniAppAccessService: {} as never,
      groupConfigService: {} as never,
      chatAiSelectionService: {} as never,
      botLifecycleService: {} as never,
      botSettingsService: {} as never,
      imageGenerationService: {} as never,
      imageMcpConnectionService: {} as never,
      usageGovernor: {} as never,
      runtimeHealth: new RuntimeHealth(TEST_SHA),
    });

    const response = await app.request("/api/not-a-real-route");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-security-policy")).toBe(
      APP_SECURITY_HEADERS["Content-Security-Policy"],
    );
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Not found" });
  });

  it("reports liveness separately from runtime readiness", async () => {
    const runtimeHealth = new RuntimeHealth(TEST_SHA);
    const app = createApp({
      db: {} as never,
      auth: { handler: vi.fn() } as never,
      baseURL: "https://bot.example.test",
      botPool: {} as never,
      encryptionKey: "test-key",
      backupService: {} as never,
      modelCapabilityService: {} as never,
      timerRegistry: {} as never,
      rssFeedService: {} as never,
      mcpClientManager: {} as never,
      summaryService: {} as never,
      summaryConfigService: {} as never,
      githubAppService: {} as never,
      miniAppSessionSecret: "x".repeat(32),
      telegramDirectoryService: {} as never,
      telegramMembershipVerifier: {} as never,
      miniAppAccessService: {} as never,
      groupConfigService: {} as never,
      chatAiSelectionService: {} as never,
      botLifecycleService: {} as never,
      botSettingsService: {} as never,
      imageGenerationService: {} as never,
      imageMcpConnectionService: {} as never,
      usageGovernor: {} as never,
      runtimeHealth,
    });

    await expect((await app.request("/api/health")).json()).resolves.toEqual({ ok: true });
    await expect((await app.request("/api/health/live")).json()).resolves.toEqual({
      ok: true,
      status: "live",
      version: TEST_SHA,
    });

    const starting = await app.request("/api/health/ready");
    expect(starting.status).toBe(503);
    await expect(starting.json()).resolves.toEqual({
      ok: false,
      status: "starting",
      version: TEST_SHA,
    });

    runtimeHealth.markReady();
    const ready = await app.request("/api/health/ready");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      ok: true,
      status: "ready",
      version: TEST_SHA,
    });

    runtimeHealth.markStopping();
    const stopping = await app.request("/api/health/ready");
    expect(stopping.status).toBe(503);
    await expect(stopping.json()).resolves.toEqual({
      ok: false,
      status: "stopping",
      version: TEST_SHA,
    });
  });
});
