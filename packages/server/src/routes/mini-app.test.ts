import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MINI_APP_SESSION_COOKIE_NAME } from "../services/mini-app-session.js";
import { MiniAppAccessError } from "../services/mini-app-access-service.js";
import { GroupConfigConflictError } from "../services/group-config-service.js";
import type { TelegramAccessSnapshot } from "../services/telegram-directory-service.js";
import { miniAppRoutes, type MiniAppRoutesOptions } from "./mini-app.js";

const BOT_A = "00000000-0000-4000-8000-000000000001";
const BOT_B = "00000000-0000-4000-8000-000000000002";
const BOT_TOKEN = "123456:test-token";
const SECRET = "mini-app-session-secret-at-least-32-characters";
const NOW_SECONDS = 1_800_000_000;
const ORIGIN = "http://localhost";

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
  const accessService = {
    readAccess: vi.fn(async () => ({
      bot: { username: "example_chat_bot", displayName: "Example Bot" },
      chats: [],
      operators: [],
      activity: [],
    })),
    searchPeople: vi.fn(async () => []),
    grantChat: vi.fn(async () => {}),
    revokeChat: vi.fn(async () => {}),
    grantOperator: vi.fn(async () => {}),
    revokeOperator: vi.fn(async () => {}),
  };
  const group = {
    chatId: -1001,
    type: "supergroup" as const,
    title: "Build Room",
    username: "build_room",
    botMembershipStatus: "administrator",
    membershipObservedAt: "2026-07-27T00:00:00.000Z",
    lastObservedAt: "2026-07-27T00:00:00.000Z",
    archived: false,
    config: {
      revision: "rev-1",
      aiConfigured: true,
      group: {
        enabled: true,
        whitelisted: false,
        trigger: {
          replyToBot: true,
          mentionBot: true,
          triggerWords: [],
          randomReplyPercent: 0,
          randomReplyCooldown: 0,
        },
        conversation: { enabled: true, maxContextMessages: 20, groupHistoryMaxTokens: 12_000 },
      },
      summary: {
        enabled: false,
        scheduleHour: null,
        scheduleMinute: null,
        timezone: "Asia/Shanghai",
        windowHours: 24,
        maxMessages: 2_000,
        cooldownSeconds: 300,
      },
    },
    applyState: "applied" as const,
  };
  const groupConfigService = {
    list: vi.fn(async () => [group]),
    read: vi.fn(async () => group),
    patch: vi.fn(async () => ({ persisted: true, applied: true, group })),
    retryApply: vi.fn(async () => group),
  };
  const options: MiniAppRoutesOptions = {
    sessionSecret: SECRET,
    allowedOrigins: [ORIGIN],
    botTokenResolver: {
      resolve: vi.fn(async (botId: string) => (botId === BOT_A ? BOT_TOKEN : null)),
    },
    directory,
    membershipVerifier: { isMember: vi.fn(async () => false) },
    accessService,
    groupConfigService,
    now: () => NOW_SECONDS * 1000,
    ...overrides,
  };
  return {
    app: new Hono().route("/mini-app", miniAppRoutes(options)),
    directory,
    accessService,
    groupConfigService,
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

describe("Mini App Access routes", () => {
  async function adminSession(app: Hono) {
    const created = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    const body = (await created.clone().json()) as { session: { csrfToken: string } };
    return { cookie: cookieFrom(created), csrfToken: body.session.csrfToken as string };
  }

  it("allows only current admins to read the Bot-scoped Access projection", async () => {
    const { app, accessService } = testApp();
    const session = await adminSession(app);
    const response = await app.request(`/mini-app/${BOT_A}/access`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      bot: { username: "example_chat_bot" },
      chats: [],
      operators: [],
    });
    expect(accessService.readAccess).toHaveBeenCalledWith(BOT_A, {
      actorTelegramUserId: undefined,
      action: undefined,
      resource: undefined,
    });

    const operatorSnapshot: TelegramAccessSnapshot = {
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [42],
      grantedChatIds: [-1001],
    };
    const deniedService = {
      ...accessService,
      readAccess: vi.fn(async () => ({
        bot: { username: "example_chat_bot", displayName: "Example Bot" },
        chats: [],
        operators: [],
        activity: [],
      })),
    };
    const operator = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => operatorSnapshot) },
      accessService: deniedService,
    }).app;
    const operatorSession = await adminSession(operator);
    const denied = await operator.request(`/mini-app/${BOT_A}/access`, {
      headers: { cookie: operatorSession.cookie },
    });
    expect(denied.status).toBe(403);
    expect(deniedService.readAccess).not.toHaveBeenCalled();
  });

  it("requires the signed session CSRF token and forwards only validated grant input", async () => {
    const { app, accessService } = testApp();
    const session = await adminSession(app);
    const endpoint = `/mini-app/${BOT_A}/access/operator-grants`;
    const request = {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ telegramUserId: 73, note: "  trusted helper  " }),
    };
    expect((await app.request(endpoint, request)).status).toBe(403);
    expect(accessService.grantOperator).not.toHaveBeenCalled();

    const accepted = await app.request(endpoint, {
      ...request,
      headers: {
        ...request.headers,
        origin: ORIGIN,
        "x-mini-app-csrf": session.csrfToken,
      },
    });
    expect(accepted.status).toBe(200);
    expect(accessService.grantOperator).toHaveBeenCalledWith({
      botId: BOT_A,
      actorTelegramUserId: 42,
      telegramUserId: 73,
      note: "trusted helper",
    });
  });

  it("re-resolves authorization before revocation and rejects invalid resource IDs", async () => {
    const { app, directory, accessService } = testApp();
    const session = await adminSession(app);
    directory.readAccessSnapshot.mockResolvedValueOnce({
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [],
      grantedChatIds: [],
    });
    const revoked = await app.request(`/mini-app/${BOT_A}/access/operator-grants/73`, {
      method: "DELETE",
      headers: { cookie: session.cookie, origin: ORIGIN, "x-mini-app-csrf": session.csrfToken },
    });
    expect(revoked.status).toBe(403);
    expect(accessService.revokeOperator).not.toHaveBeenCalled();

    const invalid = await app.request(`/mini-app/${BOT_A}/access/chat-grants/42`, {
      method: "DELETE",
      headers: { cookie: session.cookie, origin: ORIGIN, "x-mini-app-csrf": session.csrfToken },
    });
    expect(invalid.status).toBe(400);
  });

  it("maps administrator verification failures without leaking internals", async () => {
    const { app, accessService } = testApp();
    accessService.grantChat.mockRejectedValueOnce(
      new MiniAppAccessError("bot_admin_required", "The Bot must currently be an administrator"),
    );
    const session = await adminSession(app);
    const response = await app.request(`/mini-app/${BOT_A}/access/chat-grants`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-mini-app-csrf": session.csrfToken,
      },
      body: JSON.stringify({ chatId: -1001 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "The Bot must currently be an administrator",
      code: "bot_admin_required",
    });
  });
});

describe("Mini App group configuration routes", () => {
  async function sessionFor(app: Hono) {
    const created = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    const body = (await created.clone().json()) as { session: { csrfToken: string } };
    return { cookie: cookieFrom(created), csrfToken: body.session.csrfToken };
  }

  it("projects only the current role's chat scope", async () => {
    const snapshot: TelegramAccessSnapshot = {
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [42],
      grantedChatIds: [-1001],
    };
    const { app, groupConfigService } = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => snapshot) },
    });
    const session = await sessionFor(app);
    const response = await app.request(`/mini-app/${BOT_A}/groups`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, editable: true });
    expect(groupConfigService.list).toHaveBeenCalledWith(BOT_A, [-1001]);

    const outsideScope = await app.request(`/mini-app/${BOT_A}/groups/-2002`, {
      headers: { cookie: session.cookie },
    });
    expect(outsideScope.status).toBe(403);
  });

  it("rejects viewers and over-posting, then accepts an allowed field PATCH with CSRF", async () => {
    const viewerSnapshot: TelegramAccessSnapshot = {
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [],
      grantedChatIds: [-1001],
    };
    const viewer = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => viewerSnapshot) },
      membershipVerifier: { isMember: vi.fn(async () => true) },
    }).app;
    const viewerSession = await sessionFor(viewer);
    const viewerWrite = await viewer.request(`/mini-app/${BOT_A}/groups/-1001`, {
      method: "PATCH",
      headers: {
        cookie: viewerSession.cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-mini-app-csrf": viewerSession.csrfToken,
      },
      body: JSON.stringify({ expectedRevision: "rev-1", patch: { group: { enabled: false } } }),
    });
    expect(viewerWrite.status).toBe(403);

    const operatorSnapshot: TelegramAccessSnapshot = {
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [42],
      grantedChatIds: [-1001],
    };
    const { app, groupConfigService } = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => operatorSnapshot) },
    });
    const session = await sessionFor(app);
    const endpoint = `/mini-app/${BOT_A}/groups/-1001`;
    const headers = {
      cookie: session.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-mini-app-csrf": session.csrfToken,
    };
    const overPosted = await app.request(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: "rev-1",
        patch: { group: { systemPrompt: "must not pass" } },
      }),
    });
    expect(overPosted.status).toBe(400);
    expect(groupConfigService.patch).not.toHaveBeenCalled();

    const crossOrigin = await app.request(endpoint, {
      method: "PATCH",
      headers: { ...headers, origin: "https://attacker.example" },
      body: JSON.stringify({
        expectedRevision: "rev-1",
        patch: { group: { enabled: false } },
      }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(groupConfigService.patch).not.toHaveBeenCalled();

    const accepted = await app.request(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: "rev-1",
        patch: { group: { enabled: false }, summary: { timezone: "UTC" } },
      }),
    });
    expect(accepted.status).toBe(200);
    expect(groupConfigService.patch).toHaveBeenCalledWith({
      botId: BOT_A,
      chatId: -1001,
      actorTelegramUserId: 42,
      actorRole: "operator",
      expectedRevision: "rev-1",
      patch: { group: { enabled: false }, summary: { timezone: "UTC" } },
    });
  });

  it("returns 409 with the latest safe projection for stale writes", async () => {
    const { app, groupConfigService } = testApp();
    groupConfigService.patch.mockRejectedValueOnce(new GroupConfigConflictError());
    const session = await sessionFor(app);
    const response = await app.request(`/mini-app/${BOT_A}/groups/-1001`, {
      method: "PATCH",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-mini-app-csrf": session.csrfToken,
      },
      body: JSON.stringify({ expectedRevision: "stale", patch: { group: { enabled: false } } }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "stale_revision",
      latest: { chatId: -1001, config: { revision: "rev-1" } },
    });
  });
});
