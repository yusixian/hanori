import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PluginLoginState } from "@cos-tool-bot/shared";
import { ownerOrAdmin, requireRoles, type AuthVariables } from "../middleware/better-auth.js";
import { PluginLoginError } from "../services/plugins/login.js";
import { pluginLoginRoutes } from "./plugin-login.js";

const botId = "2f7dbe7d-fba7-402c-a8af-6856a2a1b7bc";
const sessionId = "3f7dbe7d-fba7-402c-a8af-6856a2a1b7bc";
const path = `/plugins/example.plugin/bots/${botId}/login`;
const state: PluginLoginState = {
  id: sessionId,
  status: "waiting",
  expiresAt: "2026-10-02T12:00:00.000Z",
  qrUrl: "https://example.com/login?code=synthetic",
};
function setup(role = "owner", authenticated = true) {
  const service = {
    start: vi.fn(async () => state),
    poll: vi.fn(async () => state),
    cancel: vi.fn(async () => ({ ...state, status: "cancelled" as const })),
  };
  const app = new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      if (authenticated) {
        c.set("authUser", { id: "user-1" } as AuthVariables["authUser"]);
        c.set("authSession", { id: "session-1" } as AuthVariables["authSession"]);
      }
      c.set("authMember", { role, organizationId: "org-1" } as AuthVariables["authMember"]);
      await next();
    })
    .use("/plugins/*", requireRoles(ownerOrAdmin))
    .route("/plugins", pluginLoginRoutes(service));
  return { app, service };
}
const request = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const start = { expectedRevision: 0, manifestHash: "a".repeat(64) };

describe("plugin login routes", () => {
  it("binds login to the authenticated workspace, user and web session", async () => {
    const { app, service } = setup();
    const response = await app.request(path, request(start));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.start).toHaveBeenCalledWith(
      JSON.stringify(["org-1", "user-1", "session-1"]),
      "example.plugin",
      botId,
      start,
    );
    await app.request(`${path}/${sessionId}/poll`, request({}));
    await app.request(`${path}/${sessionId}/cancel`, request({}));
    for (const operation of [service.poll, service.cancel])
      expect(operation).toHaveBeenCalledWith(
        JSON.stringify(["org-1", "user-1", "session-1"]),
        "example.plugin",
        botId,
        sessionId,
      );
  });

  it.each(["member", "viewer"])("denies %s before any provider execution", async (role) => {
    const { app, service } = setup(role);
    for (const url of [path, `${path}/${sessionId}/poll`, `${path}/${sessionId}/cancel`])
      expect((await app.request(url, request(start))).status).toBe(403);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.poll).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it("fails closed without a web session and requires JSON for mutating polls", async () => {
    const anonymous = setup("owner", false);
    expect((await anonymous.app.request(path, request(start))).status).toBe(404);
    expect(anonymous.service.start).not.toHaveBeenCalled();
    const { app, service } = setup();
    expect((await app.request(`${path}/${sessionId}/poll`)).status).toBe(404);
    expect((await app.request(`${path}/${sessionId}/poll`, { method: "POST" })).status).toBe(400);
    expect((await app.request(path, request({ ...start, cookie: "synthetic" }))).status).toBe(400);
    expect(service.poll).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });

  it("returns bounded errors without provider exception secrets", async () => {
    const { app, service } = setup();
    service.start.mockRejectedValueOnce(new Error("Cookie=synthetic-private-value"));
    const failed = await app.request(path, request(start));
    expect(await failed.json()).toEqual({ ok: false, error: "login_failed" });
    service.poll.mockRejectedValueOnce(new PluginLoginError("not_found"));
    expect((await app.request(`${path}/${sessionId}/poll`, request({}))).status).toBe(404);
  });
});
