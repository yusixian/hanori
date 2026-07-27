import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MINI_APP_SESSION_COOKIE_NAME } from "../services/mini-app-session.js";
import { MiniAppAccessError } from "../services/mini-app-access-service.js";
import { GroupConfigConflictError } from "../services/group-config-service.js";
import { ChatAiSelectionError } from "../services/chat-ai-selection-service.js";
import type { TelegramAccessSnapshot } from "../services/telegram-directory-service.js";
import {
  InMemoryMiniAppSessionRateLimiter,
  miniAppRoutes,
  type MiniAppRoutesOptions,
} from "./mini-app.js";

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
  const selection = {
    revision: "selection-rev-1",
    source: "chat" as const,
    archived: false,
    applyState: "applied" as const,
    display: { defaultPolicy: "show" as const, overridePolicy: "inherit" as const, visible: true },
    selection: {
      providerId: "provider-a",
      modelId: "model-a",
      providerLabel: "Provider A",
      modelLabel: "Model A",
    },
    options: [],
  };
  const globalSelection = {
    revision: "global-rev-1",
    applyState: "applied" as const,
    displayDefault: "show" as const,
    selection: selection.selection,
    options: [],
  };
  const chatAiSelectionService = {
    listOptions: vi.fn(async () => []),
    readGlobal: vi.fn(async () => globalSelection),
    readChat: vi.fn(async () => selection),
    setGlobal: vi.fn(async () => ({
      persisted: true as const,
      applied: true,
      applyState: "applied" as const,
      global: globalSelection,
    })),
    setChat: vi.fn(async () => ({
      persisted: true as const,
      applied: true,
      applyState: "applied" as const,
      chat: selection,
    })),
    resetChat: vi.fn(async () => ({
      persisted: true as const,
      applied: true,
      applyState: "applied" as const,
      chat: selection,
    })),
    setDisplayPolicy: vi.fn(async () => ({
      persisted: true as const,
      applied: true,
      applyState: "applied" as const,
      chat: selection,
    })),
    retryPublish: vi.fn(async () => ({
      persisted: true as const,
      applied: true,
      applyState: "applied" as const,
    })),
  };
  const lifecycle = {
    desiredActive: true,
    runtimeStatus: "running" as const,
    reconciled: true,
  };
  const botLifecycleService = {
    read: vi.fn(async () => lifecycle),
    enable: vi.fn(async () => ({ ...lifecycle, persisted: true as const, applied: true })),
    disable: vi.fn(async () => ({
      desiredActive: false,
      runtimeStatus: "stopped" as const,
      reconciled: true,
      persisted: true as const,
      applied: true,
    })),
    restart: vi.fn(async () => ({ ...lifecycle, persisted: true as const, applied: true })),
  };
  const settings = {
    revision: "settings-rev-1",
    ai: { enabled: true, systemPrompt: "You are helpful." },
  };
  const botSettingsService = {
    read: vi.fn(async () => settings),
    patch: vi.fn(async () => ({
      persisted: true as const,
      applied: true,
      applyState: "applied" as const,
      settings,
    })),
  };
  const logService = {
    read: vi.fn(async () => ({
      logs: [
        {
          id: 11,
          level: "info" as const,
          message: "Bot started",
          createdAt: "2026-07-28T00:00:00.000Z",
          meta: {},
        },
      ],
      nextCursor: null,
    })),
  };
  const options: MiniAppRoutesOptions = {
    sessionSecret: SECRET,
    allowedOrigins: [ORIGIN],
    botTokenResolver: {
      resolve: vi.fn(async (botId: string) => (botId === BOT_A ? BOT_TOKEN : null)),
      isEnabled: vi.fn(async (botId: string) => botId === BOT_A),
    },
    directory,
    membershipVerifier: { isMember: vi.fn(async () => false) },
    accessService,
    groupConfigService,
    chatAiSelectionService,
    botLifecycleService,
    botSettingsService,
    logService,
    now: () => NOW_SECONDS * 1000,
    ...overrides,
  };
  return {
    app: new Hono().route("/mini-app", miniAppRoutes(options)),
    directory,
    accessService,
    groupConfigService,
    chatAiSelectionService,
    botLifecycleService,
    botSettingsService,
    logService,
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
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      user: { id: 42, firstName: "Ada" },
      access: { role: "admin", chatScope: { kind: "all" } },
    });
    expect(body).not.toHaveProperty("token");
    expect(response.headers.get("set-cookie")).toContain(
      `Path=/api/mini-app/${BOT_A}; Max-Age=900; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it("rejects tampered initData, unknown bots, and exhausted rate limits", async () => {
    const denied = { consume: vi.fn(() => false), reserve: vi.fn(() => null), release: vi.fn() };
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

  it("protects disabled Bot lookups without allocating per-Bot limiter state", async () => {
    const rateLimiter = {
      consume: vi.fn(() => true),
      reserve: vi.fn(() => 60_000),
      release: vi.fn(),
    };
    const disabled = testApp({
      rateLimiter,
      botTokenResolver: {
        resolve: vi.fn(async () => null),
        isEnabled: vi.fn(async () => false),
      },
    }).app;

    const response = await disabled.request(`/mini-app/${BOT_B}/session`, { method: "POST" });

    expect(response.status).toBe(404);
    expect(rateLimiter.reserve).toHaveBeenCalledOnce();
    expect(rateLimiter.reserve).toHaveBeenCalledWith("session:global", 3_000);
    expect(rateLimiter.release).not.toHaveBeenCalled();
  });

  it("isolates pre-auth exhaustion to one enabled Bot after the global circuit breaker", async () => {
    const consume = vi.fn((key: string) => key !== `session:${BOT_A}:preauth`);
    const reserve = vi.fn(() => 60_000);
    const release = vi.fn();
    const { app, options } = testApp({ rateLimiter: { consume, reserve, release } });

    const response = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });

    expect(response.status).toBe(429);
    expect(options.botTokenResolver.isEnabled).toHaveBeenCalledWith(BOT_A);
    expect(reserve).toHaveBeenCalledWith("session:global", 3_000);
    expect(release).toHaveBeenCalledWith("session:global", 60_000);
    expect(consume).toHaveBeenCalledWith(`session:${BOT_A}:preauth`, 120);
  });

  it("bounds high-cardinality session limiter state and reclaims expired entries", () => {
    let now = 1_000;
    const limiter = new InMemoryMiniAppSessionRateLimiter(2, 100, () => now, 2);

    const reservation = limiter.reserve("a");
    expect(reservation).toBe(1_100);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.consume("c")).toBe(false);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);

    limiter.release("a", reservation!);
    expect(limiter.consume("a")).toBe(true);

    now += 101;
    expect(limiter.consume("c")).toBe(true);
  });

  it("does not release a reservation from an expired limiter window", () => {
    let now = 1_000;
    const limiter = new InMemoryMiniAppSessionRateLimiter(1, 100, () => now, 2);
    const oldReservation = limiter.reserve("global");
    expect(oldReservation).toBe(1_100);

    now = 1_101;
    expect(limiter.reserve("global")).toBe(1_201);
    limiter.release("global", oldReservation!);

    expect(limiter.consume("global")).toBe(false);
  });

  it("keeps Mini App APIs dark when the per-Bot feature flag is disabled", async () => {
    const enabled = testApp();
    const sessionResponse = await enabled.app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    const cookie = cookieFrom(sessionResponse);
    const resolve = vi.fn(async () => null);
    const disabled = testApp({
      botTokenResolver: { resolve, isEnabled: vi.fn(async () => false) },
    }).app;

    const create = await disabled.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    expect(create.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();

    const existing = await disabled.request(`/mini-app/${BOT_A}/access`, {
      headers: { cookie },
    });
    expect(existing.status).toBe(404);

    const session = await disabled.request(`/mini-app/${BOT_A}/session`, {
      headers: { cookie },
    });
    expect(session.status).toBe(404);
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
    const resolver = {
      resolve: vi.fn(async () => BOT_TOKEN),
      isEnabled: vi.fn(async () => true),
    };
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

describe("Mini App log routes", () => {
  async function sessionFor(app: Hono, userId = 42) {
    const created = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData(userId) }),
    });
    return cookieFrom(created);
  }

  it("returns only the current Bot page to an admin and validates bounded filters", async () => {
    const { app, logService } = testApp();
    const cookie = await sessionFor(app);
    const response = await app.request(`/mini-app/${BOT_A}/logs?limit=20&before=30&level=warn`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      logs: [
        {
          id: 11,
          level: "info",
          message: "Bot started",
          createdAt: "2026-07-28T00:00:00.000Z",
          meta: {},
        },
      ],
      nextCursor: null,
    });
    expect(logService.read).toHaveBeenCalledWith(BOT_A, {
      limit: 20,
      before: 30,
      level: "warn",
    });

    const invalid = await app.request(`/mini-app/${BOT_A}/logs?limit=500`, {
      headers: { cookie },
    });
    expect(invalid.status).toBe(400);
    expect(logService.read).toHaveBeenCalledOnce();
  });

  it.each([
    {
      role: "operator",
      snapshot: {
        botId: BOT_A,
        adminTelegramUserIds: [],
        operatorTelegramUserIds: [42],
        grantedChatIds: [-1001],
      } satisfies TelegramAccessSnapshot,
      member: false,
    },
    {
      role: "viewer",
      snapshot: {
        botId: BOT_A,
        adminTelegramUserIds: [],
        operatorTelegramUserIds: [],
        grantedChatIds: [-1001],
      } satisfies TelegramAccessSnapshot,
      member: true,
    },
    {
      role: "none",
      snapshot: {
        botId: BOT_A,
        adminTelegramUserIds: [],
        operatorTelegramUserIds: [],
        grantedChatIds: [],
      } satisfies TelegramAccessSnapshot,
      member: false,
    },
  ])("denies $role before reading logs", async ({ snapshot, member }) => {
    const { app, logService } = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => snapshot) },
      membershipVerifier: { isMember: vi.fn(async () => member) },
    });
    const cookie = await sessionFor(app);
    const response = await app.request(`/mini-app/${BOT_A}/logs`, { headers: { cookie } });

    expect(response.status).toBe(403);
    expect(logService.read).not.toHaveBeenCalled();
  });

  it("keeps disabled Bots dark and rejects a Bot A cookie on Bot B", async () => {
    const enabled = testApp({
      botTokenResolver: {
        resolve: vi.fn(async () => BOT_TOKEN),
        isEnabled: vi.fn(async () => true),
      },
    });
    const cookie = await sessionFor(enabled.app);
    const crossBot = await enabled.app.request(`/mini-app/${BOT_B}/logs`, {
      headers: { cookie },
    });
    expect(crossBot.status).toBe(401);
    expect(enabled.logService.read).not.toHaveBeenCalled();

    const disabled = testApp({
      botTokenResolver: { resolve: vi.fn(async () => null), isEnabled: vi.fn(async () => false) },
    });
    const hidden = await disabled.app.request(`/mini-app/${BOT_A}/logs`, {
      headers: { cookie },
    });
    expect(hidden.status).toBe(404);
    expect(disabled.logService.read).not.toHaveBeenCalled();
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

describe("Mini App lifecycle routes", () => {
  async function sessionFor(app: Hono) {
    const response = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    const body = (await response.json()) as { session: { csrfToken: string } };
    return { cookie: cookieFrom(response), csrfToken: body.session.csrfToken };
  }

  it("exposes reconciled state and requires CSRF for Admin lifecycle mutations", async () => {
    const { app, botLifecycleService } = testApp();
    const session = await sessionFor(app);

    const read = await app.request(`/mini-app/${BOT_A}/lifecycle`, {
      headers: { cookie: session.cookie },
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      lifecycle: { desiredActive: true, runtimeStatus: "running", reconciled: true },
    });

    const denied = await app.request(`/mini-app/${BOT_A}/lifecycle/disable`, {
      method: "POST",
      headers: { cookie: session.cookie },
    });
    expect(denied.status).toBe(403);

    const accepted = await app.request(`/mini-app/${BOT_A}/lifecycle/disable`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "x-mini-app-csrf": session.csrfToken,
      },
    });
    expect(accepted.status).toBe(200);
    expect(botLifecycleService.disable).toHaveBeenCalledWith({
      botId: BOT_A,
      actor: { kind: "telegram_user", id: "42" },
    });
  });

  it("reads and updates only the common Admin settings contract", async () => {
    const { app, botSettingsService } = testApp();
    const session = await sessionFor(app);
    const read = await app.request(`/mini-app/${BOT_A}/settings`, {
      headers: { cookie: session.cookie },
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      settings: { ai: { enabled: true, systemPrompt: "You are helpful." } },
    });

    const denied = await app.request(`/mini-app/${BOT_A}/settings`, {
      method: "PATCH",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: "settings-rev-1",
        patch: { enabled: false },
      }),
    });
    expect(denied.status).toBe(403);

    const accepted = await app.request(`/mini-app/${BOT_A}/settings`, {
      method: "PATCH",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "content-type": "application/json",
        "x-mini-app-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        expectedRevision: "settings-rev-1",
        patch: { enabled: false, systemPrompt: "Updated" },
      }),
    });
    expect(accepted.status).toBe(200);
    expect(botSettingsService.patch).toHaveBeenCalledWith({
      botId: BOT_A,
      expectedRevision: "settings-rev-1",
      patch: { enabled: false, systemPrompt: "Updated" },
      actor: { kind: "telegram_user", id: "42" },
    });
  });

  it("keeps lifecycle management Admin-only", async () => {
    const operatorSnapshot: TelegramAccessSnapshot = {
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [42],
      grantedChatIds: [-1001],
    };
    const { app, botLifecycleService } = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => operatorSnapshot) },
    });
    const session = await sessionFor(app);

    const response = await app.request(`/mini-app/${BOT_A}/lifecycle/restart`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "x-mini-app-csrf": session.csrfToken,
      },
    });
    expect(response.status).toBe(403);
    expect(botLifecycleService.restart).not.toHaveBeenCalled();
  });
});

describe("Mini App AI selection routes", () => {
  async function sessionFor(app: Hono) {
    const created = await app.request(`/mini-app/${BOT_A}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: signInitData() }),
    });
    const body = (await created.clone().json()) as { session: { csrfToken: string } };
    return { cookie: cookieFrom(created), csrfToken: body.session.csrfToken };
  }

  it("allows Admin options/global reads and forwards only strict global selection input", async () => {
    const { app, chatAiSelectionService } = testApp();
    const session = await sessionFor(app);

    const optionsResponse = await app.request(`/mini-app/${BOT_A}/ai-selection/options`, {
      headers: { cookie: session.cookie },
    });
    expect(optionsResponse.status).toBe(200);
    expect(chatAiSelectionService.listOptions).toHaveBeenCalledWith(BOT_A);

    const globalResponse = await app.request(`/mini-app/${BOT_A}/ai-selection/global`, {
      headers: { cookie: session.cookie },
    });
    expect(globalResponse.status).toBe(200);
    expect(chatAiSelectionService.readGlobal).toHaveBeenCalledWith(BOT_A);

    const endpoint = `/mini-app/${BOT_A}/ai-selection/global`;
    const headers = {
      cookie: session.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-mini-app-csrf": session.csrfToken,
    };
    const invalid = await app.request(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: "global-rev-1",
        providerId: "provider-a",
        modelId: "model-a",
        baseURL: "https://must-not-pass.example",
      }),
    });
    expect(invalid.status).toBe(400);
    expect(chatAiSelectionService.setGlobal).not.toHaveBeenCalled();

    const accepted = await app.request(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: "global-rev-1",
        providerId: "provider-a",
        modelId: "model-a",
        displayDefault: "hide",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(chatAiSelectionService.setGlobal).toHaveBeenCalledWith({
      botId: BOT_A,
      expectedRevision: "global-rev-1",
      pair: { providerId: "provider-a", modelId: "model-a" },
      displayDefault: "hide",
      actor: { kind: "telegram_user", id: "42" },
    });
  });

  it("passes Admin state to the server projection and enforces non-Admin chat scope", async () => {
    const operatorSnapshot: TelegramAccessSnapshot = {
      botId: BOT_A,
      adminTelegramUserIds: [],
      operatorTelegramUserIds: [42],
      grantedChatIds: [-1001],
    };
    const { app, chatAiSelectionService } = testApp({
      directory: { readAccessSnapshot: vi.fn(async () => operatorSnapshot) },
    });
    const session = await sessionFor(app);

    const visible = await app.request(`/mini-app/${BOT_A}/groups/-1001/ai-selection`, {
      headers: { cookie: session.cookie },
    });
    expect(visible.status).toBe(200);
    expect(chatAiSelectionService.readChat).toHaveBeenCalledWith(BOT_A, -1001, false);

    const outside = await app.request(`/mini-app/${BOT_A}/groups/-2002/ai-selection`, {
      headers: { cookie: session.cookie },
    });
    expect(outside.status).toBe(403);

    const deniedGlobal = await app.request(`/mini-app/${BOT_A}/ai-selection/global`, {
      headers: { cookie: session.cookie },
    });
    expect(deniedGlobal.status).toBe(403);
  });

  it("requires Origin and CSRF for every Admin mutation and forwards validated inputs", async () => {
    const { app, chatAiSelectionService } = testApp();
    const session = await sessionFor(app);
    const commonHeaders = {
      cookie: session.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-mini-app-csrf": session.csrfToken,
    };
    const mutations = [
      {
        path: `/mini-app/${BOT_A}/ai-selection/retry`,
        method: "POST",
        body: undefined,
      },
      {
        path: `/mini-app/${BOT_A}/groups/-1001/ai-selection`,
        method: "PATCH",
        body: {
          expectedRevision: "selection-rev-1",
          providerId: "provider-a",
          modelId: null,
        },
      },
      {
        path: `/mini-app/${BOT_A}/groups/-1001/ai-selection`,
        method: "DELETE",
        body: { expectedRevision: "selection-rev-1" },
      },
      {
        path: `/mini-app/${BOT_A}/groups/-1001/ai-selection/display`,
        method: "PATCH",
        body: { expectedRevision: "selection-rev-1", policy: "inherit" },
      },
      {
        path: `/mini-app/${BOT_A}/groups/-1001/ai-selection/retry`,
        method: "POST",
        body: undefined,
      },
    ];

    for (const mutation of mutations) {
      const denied = await app.request(mutation.path, {
        method: mutation.method,
        headers: { cookie: session.cookie, "content-type": "application/json" },
        ...(mutation.body ? { body: JSON.stringify(mutation.body) } : {}),
      });
      expect(denied.status).toBe(403);

      const accepted = await app.request(mutation.path, {
        method: mutation.method,
        headers: commonHeaders,
        ...(mutation.body ? { body: JSON.stringify(mutation.body) } : {}),
      });
      expect(accepted.status).toBe(200);
    }

    expect(chatAiSelectionService.setChat).toHaveBeenCalledWith({
      botId: BOT_A,
      chatId: -1001,
      expectedRevision: "selection-rev-1",
      pair: { providerId: "provider-a", modelId: null },
      actor: { kind: "telegram_user", id: "42" },
    });
    expect(chatAiSelectionService.resetChat).toHaveBeenCalledTimes(1);
    expect(chatAiSelectionService.setDisplayPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ policy: "inherit" }),
    );
    expect(chatAiSelectionService.retryPublish).toHaveBeenCalledTimes(2);
    expect(chatAiSelectionService.retryPublish).toHaveBeenCalledWith(BOT_A);
  });

  it("maps stale writes with a latest safe projection and hides unexpected errors", async () => {
    const { app, chatAiSelectionService } = testApp();
    const session = await sessionFor(app);
    const headers = {
      cookie: session.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-mini-app-csrf": session.csrfToken,
    };
    chatAiSelectionService.setChat.mockRejectedValueOnce(
      new ChatAiSelectionError("stale_revision", "database details must not escape"),
    );
    const stale = await app.request(`/mini-app/${BOT_A}/groups/-1001/ai-selection`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: "stale",
        providerId: "provider-a",
        modelId: "model-a",
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      ok: false,
      code: "stale_revision",
      latest: { revision: "selection-rev-1" },
    });

    chatAiSelectionService.listOptions.mockRejectedValueOnce(
      new Error("secret API key and database trace"),
    );
    const unavailable = await app.request(`/mini-app/${BOT_A}/ai-selection/options`, {
      headers: { cookie: session.cookie },
    });
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toMatch(/secret API key|database trace/);
  });
});
