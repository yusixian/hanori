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
process.env.ENCRYPTION_KEY ||= "test-encryption-key";

let createApp: (typeof import("./app.js"))["createApp"];
const TEST_SHA = "0123456789abcdef0123456789abcdef01234567";
const TEST_BOT_ID = "00000000-0000-4000-8000-000000000001";

// Cold transformation of the full app graph can exceed 10s on the shared CI runner.
beforeAll(async () => {
  ({ createApp } = await import("./app.js"));
}, 30_000);

function createRoleApp(role: string) {
  let selectCalls = 0;
  const db = {
    select: vi.fn(() => {
      selectCalls += 1;
      if (selectCalls === 1) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: async () => [
                  {
                    memberId: "member-1",
                    userId: "user-1",
                    organizationId: "org-1",
                    role,
                    organizationName: "Test",
                    organizationSlug: "cos-tool-bot",
                  },
                ],
              }),
            }),
          }),
        };
      }
      if (selectCalls === 2) {
        return {
          from: () => ({ where: () => ({ limit: async () => [{ id: TEST_BOT_ID }] }) }),
        };
      }
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [{ id: -1001, name: "Operations", username: "operations" }],
            }),
          }),
        }),
      };
    }),
  };
  return createApp({
    db: db as never,
    auth: {
      api: {
        getSession: vi.fn(async () => ({
          user: { id: "user-1" },
          session: { id: "session-1" },
        })),
      },
      handler: vi.fn(),
    } as never,
    baseURL: "https://bot.example.test",
    botPool: { getGenerationLibraryService: () => ({}) } as never,
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
    engagementSampleService: {
      list: vi.fn(async () => ({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        metrics: { total: 0 },
      })),
      updateLabel: vi.fn(),
    } as never,
    runtimeHealth: new RuntimeHealth(TEST_SHA),
  });
}

describe("production HTTP policy", () => {
  it("preserves the existing owner and admin API boundaries at app composition", async () => {
    const admin = createRoleApp("admin");
    const adminGroups = await admin.request(`/api/bots/${TEST_BOT_ID}/cos-inside/groups?query=ops`);
    expect(adminGroups.status).toBe(200);
    await expect(adminGroups.json()).resolves.toEqual({
      ok: true,
      subjects: [{ id: "-1001", name: "Operations", username: "operations" }],
    });

    const editor = createRoleApp("editor");
    const editorGroups = await editor.request(
      `/api/bots/${TEST_BOT_ID}/cos-inside/groups?query=ops`,
    );
    expect(editorGroups.status).toBe(403);

    const adminGovernance = await createRoleApp("admin").request(
      `/api/bots/${TEST_BOT_ID}/governance/subjects?kind=chat&query=ops`,
    );
    expect(adminGovernance.status).toBe(403);

    const adminSamples = await createRoleApp("admin").request(
      `/api/bots/${TEST_BOT_ID}/engagement-samples`,
    );
    expect(adminSamples.status).toBe(200);

    const adminRuns = await createRoleApp("admin").request(`/api/bots/${TEST_BOT_ID}/runs`);
    expect(adminRuns.status).toBe(403);

    const adminDebug = await createRoleApp("admin").request(
      `/api/bots/${TEST_BOT_ID}/debug/rich-messages`,
      { method: "POST" },
    );
    expect(adminDebug.status).toBe(403);

    const editorSamples = await createRoleApp("editor").request(
      `/api/bots/${TEST_BOT_ID}/engagement-samples`,
    );
    expect(editorSamples.status).toBe(403);

    const ownerHarness = await createRoleApp("owner").request("/api/harness/admin/overview");
    expect(ownerHarness.status).toBe(200);
    await expect(ownerHarness.json()).resolves.toMatchObject({ ok: true, enabled: false });
    const adminHarness = await createRoleApp("admin").request("/api/harness/admin/overview");
    expect(adminHarness.status).toBe(403);
  });

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
      botPool: { getGenerationLibraryService: () => ({}) } as never,
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
      botPool: { getGenerationLibraryService: () => ({}) } as never,
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
