import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MINI_APP_SESSION_COOKIE_NAME } from "../services/mini-app-session.js";
import type { TelegramAccessSnapshot } from "../services/telegram-directory-service.js";
import { miniAppRoutes, type MiniAppRoutesOptions } from "./mini-app.js";

const BOT_A = "00000000-0000-4000-8000-000000000001";
const BOT_B = "00000000-0000-4000-8000-000000000002";
const BOT_TOKEN = "123456:test-token";
const SECRET = "mini-app-session-secret-at-least-32-characters";
const NOW_SECONDS = 1_800_000_000;

function signInitData(userId = 42, authDate = NOW_SECONDS) {
  const fields: [string, string][] = [
    ["auth_date", String(authDate)],
    ["query_id", "query-a"],
    ["user", JSON.stringify({ id: userId, first_name: "Ada" })],
  ];
  const check = [...fields]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(check).digest("hex");
  return new URLSearchParams([...fields, ["hash", hash]]).toString();
}

function testApp(overrides: Partial<MiniAppRoutesOptions> = {}) {
  const snapshot: TelegramAccessSnapshot = {
    botId: BOT_A,
    adminTelegramUserIds: [42],
    operatorTelegramUserIds: [],
    grantedChatIds: [-1001],
  };
  const directory = {
    readAccessSnapshot: vi.fn(async (): Promise<TelegramAccessSnapshot | null> => snapshot),
  };
  const options: MiniAppRoutesOptions = {
    sessionSecret: SECRET,
    botTokenResolver: {
      resolve: vi.fn(async (botId: string) => (botId === BOT_A ? BOT_TOKEN : null)),
    },
    directory,
    membershipVerifier: { isMember: vi.fn(async () => false) },
    now: () => NOW_SECONDS * 1000,
    ...overrides,
  };
  return {
    app: new Hono().route("/mini-app", miniAppRoutes(options)),
    directory,
    options,
  };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Expected Set-Cookie");
  return setCookie.split(";", 1)[0]!;
}

describe("Mini App session routes", () => {
  it("creates a Bot-scoped session and returns current admin access", async () => {
    const { app } = testApp();
    const response = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify({ initData: signInitData() }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      user: { id: 42, firstName: "Ada" },
      access: { role: "admin", chatScope: { kind: "all" } },
    });
    expect(body).not.toHaveProperty("token");
    expect(response.headers.get("set-cookie")).toContain(
      `Path=/api/mini-app/${BOT_A}; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("rejects tampered initData, unknown bots, and exhausted rate limits", async () => {
    const denied = { consume: vi.fn(() => false) };
    const limited = testApp({ rateLimiter: denied }).app;
    expect((await limited.request(`/mini-app/${BOT_A}/session`, { method: "POST" })).status).toBe(
      429,
    );

    const { app } = testApp();
    const invalid = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData().replace("Ada", "Eve") }),
    });
    expect(invalid.status).toBe(401);

    const unknown = await app.request(`/mini-app/${BOT_B}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    expect(unknown.status).toBe(404);
  });

  it("rejects expired and future initData and fails closed when sessions are not configured", async () => {
    const { app } = testApp();
    for (const authDate of [NOW_SECONDS - 301, NOW_SECONDS + 1]) {
      const response = await app.request(`/mini-app/${BOT_A}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData: signInitData(42, authDate) }),
      });
      expect(response.status).toBe(401);
    }

    const unavailable = testApp({ sessionSecret: "" }).app;
    expect(
      (await unavailable.request(`/mini-app/${BOT_A}/session`, { method: "POST" })).status,
    ).toBe(503);
  });

  it("derives viewer access from current Telegram membership on every request", async () => {
    const snapshot: TelegramAccessSnapshot = {
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [],
      grantedChatIds: [-1001],
    };
    const membershipVerifier = { isMember: vi.fn(async () => true) };
    const { app } = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => snapshot) },
      membershipVerifier,
    });
    const created = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    expect(await created.clone().json()).toMatchObject({
      access: { role: "viewer", chatScope: { kind: "granted", chatIds: [-1001] } },
    });

    membershipVerifier.isMember.mockResolvedValueOnce(false);
    const revoked = await app.request(`/mini-app/${BOT_A}/session`, {
      headers: { cookie: cookieFrom(created) },
    });
    expect(await revoked.json()).toMatchObject({
      access: { role: "none", chatScope: { kind: "none" } },
    });
    expect(membershipVerifier.isMember).toHaveBeenCalledTimes(2);
  });

  it("re-resolves grants on every session read so revocation takes effect immediately", async () => {
    const { app, directory } = testApp();
    const created = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    const cookie = cookieFrom(created);

    directory.readAccessSnapshot.mockResolvedValueOnce({
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [42],
      grantedChatIds: [-1001],
    });
    const operator = await app.request(`/mini-app/${BOT_A}/session`, {
      headers: { cookie },
    });
    expect(await operator.json()).toMatchObject({ access: { role: "operator" } });

    directory.readAccessSnapshot.mockResolvedValueOnce({
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [],
      grantedChatIds: [],
    });
    const revoked = await app.request(`/mini-app/${BOT_A}/session`, {
      headers: { cookie },
    });
    expect(await revoked.json()).toMatchObject({ access: { role: "none" } });
    expect(directory.readAccessSnapshot).toHaveBeenCalledTimes(3);
  });

  it("rejects a valid Bot A cookie on Bot B and clears invalid sessions", async () => {
    const resolver = { resolve: vi.fn(async () => BOT_TOKEN) };
    const { app } = testApp({ botTokenResolver: resolver });
    const created = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    const response = await app.request(`/mini-app/${BOT_B}/session`, {
      headers: { cookie: cookieFrom(created) },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain(`${MINI_APP_SESSION_COOKIE_NAME}=;`);
  });

  it("clears the Bot-scoped cookie without requiring an active session", async () => {
    const { app } = testApp();
    const response = await app.request(`/mini-app/${BOT_A}/session`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
