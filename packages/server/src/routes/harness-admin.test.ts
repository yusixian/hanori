import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HarnessAdmin, HarnessAdminError } from "../harness/admin.js";
import { type AuthVariables, ownerOnly, requireRoles } from "../middleware/better-auth.js";
import {
  MINI_APP_SESSION_COOKIE_NAME,
  createMiniAppSession,
} from "../services/mini-app-session.js";
import {
  type HarnessAdminPort,
  harnessAdminRoutes,
  harnessMiniAppRoutes,
} from "./harness-admin.js";
import { createMiniAppSessionVerifier } from "./mini-app-auth.js";

const HARNESS_BOT = "00000000-0000-4000-8000-000000000001";
const OTHER_BOT = "00000000-0000-4000-8000-000000000002";
const SECRET = "mini-app-session-secret-at-least-32-characters";
const ORIGIN = "https://bot.example.test";
const OWNER = 42;
const CSRF = "c".repeat(32);

function fakeAdmin(): HarnessAdminPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    botId: HARNESS_BOT,
    isOwner: (id) => id === OWNER,
    overview: vi.fn(async () => new HarnessAdmin(null).overview()),
    repos: vi.fn(async () => ({ repos: [], installUrl: null })),
    preview: vi.fn(async () => {
      throw new HarnessAdminError("github_unavailable", "GitHub App 未配置");
    }),
    createProject: vi.fn(async (body, actor) => {
      calls.push({ body, actor });
      return { key: "koyori" } as never;
    }),
    updateProject: vi.fn(async () => {
      throw new HarnessAdminError("read_only", "来自 harness.yaml");
    }),
    deleteProject: vi.fn(async () => {}),
    setExecution: vi.fn(async () => ({ execution: {} as never })),
  };
}

function panelApp(role: string, admin = fakeAdmin()) {
  const app = new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      c.set("authMember", { id: "m", userId: "user-1", organizationId: "o", role } as never);
      c.set("authUser", { id: "user-1" } as never);
      await next();
    })
    .use("/api/harness/admin/*", requireRoles(ownerOnly))
    .route("/api/harness/admin", harnessAdminRoutes(admin));
  return { app, admin };
}

describe("web panel harness admin routes", () => {
  it("serves owners and maps admin errors to status codes", async () => {
    const { app, admin } = panelApp("owner");
    const overview = await app.request("/api/harness/admin/overview");
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ ok: true, enabled: false });
    expect(overview.headers.get("cache-control")).toBe("private, no-store");

    const created = await app.request("/api/harness/admin/projects", {
      method: "POST",
      body: JSON.stringify({ key: "koyori" }),
      headers: { "content-type": "application/json" },
    });
    expect(await created.json()).toEqual({ ok: true, project: { key: "koyori" } });
    expect(admin.calls).toEqual([
      { body: { key: "koyori" }, actor: { via: "panel", actorId: null, panelUserId: "user-1" } },
    ]);

    const readOnly = await app.request("/api/harness/admin/projects/sandbox", {
      method: "PATCH",
      body: "{}",
    });
    expect(readOnly.status).toBe(409);
    expect(await readOnly.json()).toEqual({
      ok: false,
      code: "read_only",
      error: "来自 harness.yaml",
    });
    expect((await app.request("/api/harness/admin/preview", { method: "POST" })).status).toBe(503);
  });

  it.each(["admin", "editor"])("rejects %s members", async (role) => {
    const { app, admin } = panelApp(role);
    expect((await app.request("/api/harness/admin/overview")).status).toBe(403);
    const write = await app.request("/api/harness/admin/projects", { method: "POST", body: "{}" });
    expect(write.status).toBe(403);
    expect(admin.createProject).not.toHaveBeenCalled();
  });
});

function miniApp(admin = fakeAdmin()) {
  const sessions = createMiniAppSessionVerifier({
    sessionSecret: SECRET,
    allowedOrigins: [ORIGIN],
    botTokenResolver: { isEnabled: async (botId) => botId === HARNESS_BOT || botId === OTHER_BOT },
  });
  const app = new Hono().route("/api/mini-app", harnessMiniAppRoutes(admin, sessions));
  return { app, admin };
}

function cookie(botId: string, userId: number) {
  const { token } = createMiniAppSession({ botId, userId, signingSecret: SECRET, csrfToken: CSRF });
  return `${MINI_APP_SESSION_COOKIE_NAME}=${token}`;
}

describe("Mini App harness admin routes", () => {
  const url = (botId: string, path: string) => `/api/mini-app/${botId}/harness/${path}`;

  it("lets harness owners read and write with the session's CSRF token", async () => {
    const { app, admin } = miniApp();
    const headers = { cookie: cookie(HARNESS_BOT, OWNER) };
    expect((await app.request(url(HARNESS_BOT, "overview"), { headers })).status).toBe(200);
    const created = await app.request(url(HARNESS_BOT, "projects"), {
      method: "POST",
      body: JSON.stringify({ key: "koyori" }),
      headers: { ...headers, origin: ORIGIN, "x-mini-app-csrf": CSRF },
    });
    expect(created.status).toBe(200);
    expect(admin.calls).toEqual([
      { body: { key: "koyori" }, actor: { via: "mini-app", actorId: OWNER } },
    ]);
  });

  it("rejects writes without the CSRF token or from another origin", async () => {
    const { app, admin } = miniApp();
    const headers = { cookie: cookie(HARNESS_BOT, OWNER) };
    for (const extra of [
      { origin: ORIGIN } as Record<string, string>,
      { origin: "https://evil.example", "x-mini-app-csrf": CSRF },
      { "x-mini-app-csrf": CSRF },
    ]) {
      const response = await app.request(url(HARNESS_BOT, "projects"), {
        method: "POST",
        body: "{}",
        headers: { ...headers, ...extra },
      });
      expect(response.status).toBe(403);
    }
    const put = await app.request(url(HARNESS_BOT, "execution"), {
      method: "PUT",
      body: "{}",
      headers,
    });
    expect(put.status).toBe(403);
    expect(admin.createProject).not.toHaveBeenCalled();
    expect(admin.setExecution).not.toHaveBeenCalled();
  });

  it("hides the API from other Bots, non-owners, and missing sessions", async () => {
    const { app } = miniApp();
    const otherBot = await app.request(url(OTHER_BOT, "overview"), {
      headers: { cookie: cookie(OTHER_BOT, OWNER) },
    });
    expect(otherBot.status).toBe(404);
    const stranger = await app.request(url(HARNESS_BOT, "overview"), {
      headers: { cookie: cookie(HARNESS_BOT, 7) },
    });
    expect(stranger.status).toBe(403);
    const anonymous = await app.request(url(HARNESS_BOT, "overview"));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("set-cookie")).toContain(`${MINI_APP_SESSION_COOKIE_NAME}=;`);
    const forged = await app.request(url(HARNESS_BOT, "overview"), {
      headers: { cookie: cookie(OTHER_BOT, OWNER) },
    });
    expect(forged.status).toBe(401);
    expect((await app.request(url("not-a-uuid", "overview"))).status).toBe(404);
  });
});
