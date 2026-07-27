import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import type { MiniAppCapability } from "@cos-tool-bot/shared";
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { tryDecrypt } from "../utils/crypto.js";
import {
  MiniAppAccessError,
  type MiniAppAccessService,
} from "../services/mini-app-access-service.js";
import {
  MiniAppAccessPolicy,
  type TelegramMembershipVerifier,
} from "../services/mini-app-access-policy.js";
import {
  clearMiniAppSessionCookie,
  createMiniAppSession,
  MINI_APP_SESSION_COOKIE_NAME,
  MiniAppSessionError,
  serializeMiniAppSessionCookie,
  verifyMiniAppSession,
} from "../services/mini-app-session.js";
import type {
  TelegramAccessSnapshot,
  TelegramDirectoryService,
} from "../services/telegram-directory-service.js";
import {
  TelegramInitDataError,
  verifyTelegramInitData,
} from "../services/telegram-mini-app-auth.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MiniAppSessionRateLimiter {
  consume(key: string): boolean;
}

export class InMemoryMiniAppSessionRateLimiter implements MiniAppSessionRateLimiter {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly now = () => Date.now(),
  ) {}

  consume(key: string): boolean {
    const now = this.now();
    const current = this.#entries.get(key);
    if (!current || current.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}

export interface MiniAppBotTokenResolver {
  resolve(botId: string): Promise<string | null>;
}

export function createMiniAppBotTokenResolver(
  db: Database,
  encryptionKey: string,
): MiniAppBotTokenResolver {
  return {
    async resolve(botId) {
      const [row] = await db
        .select({ encryptedToken: bots.encryptedToken })
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
      if (!row) return null;
      const token = tryDecrypt(row.encryptedToken, encryptionKey);
      if (!token) throw new Error("Telegram bot token is unavailable");
      return token;
    },
  };
}

interface DirectoryReader {
  readAccessSnapshot(botId: string): Promise<TelegramAccessSnapshot | null>;
}

export interface MiniAppRoutesOptions {
  sessionSecret: string;
  botTokenResolver: MiniAppBotTokenResolver;
  directory: Pick<TelegramDirectoryService, "readAccessSnapshot"> | DirectoryReader;
  membershipVerifier: TelegramMembershipVerifier;
  accessPolicy?: MiniAppAccessPolicy;
  accessService?: Pick<
    MiniAppAccessService,
    "readAccess" | "searchPeople" | "grantChat" | "revokeChat" | "grantOperator" | "revokeOperator"
  >;
  rateLimiter?: MiniAppSessionRateLimiter;
  now?: () => Date | number;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isTelegramUserId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTelegramChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}

function parseNote(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const note = value.trim();
  return note.length <= 200 ? note || null : undefined;
}

function accessError(error: MiniAppAccessError): {
  status: 404 | 409 | 503;
  body: { ok: false; error: string; code: string };
} {
  const status =
    error.code === "not_found" ? 404 : error.code === "verification_unavailable" ? 503 : 409;
  return { status, body: { ok: false, error: error.message, code: error.code } };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function clientKey(headers: Headers, botId: string): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const address = forwarded && forwarded.length <= 128 ? forwarded : "unknown";
  return `${botId}:${address}`;
}

function publicAccess(decision: Awaited<ReturnType<MiniAppAccessPolicy["resolve"]>>) {
  return {
    role: decision.role,
    capabilities: [...decision.capabilities],
    chatScope:
      decision.chatScope.kind === "granted"
        ? { kind: "granted" as const, chatIds: [...decision.chatScope.chatIds] }
        : decision.chatScope,
  };
}

export function miniAppRoutes(options: MiniAppRoutesOptions) {
  const accessPolicy = options.accessPolicy ?? new MiniAppAccessPolicy();
  const rateLimiter = options.rateLimiter ?? new InMemoryMiniAppSessionRateLimiter();
  const now = options.now ?? (() => new Date());

  async function resolveAccess(botId: string, userId: number) {
    const snapshot = await options.directory.readAccessSnapshot(botId);
    if (!snapshot) return null;
    return accessPolicy.resolve({
      botId,
      telegramUserId: userId,
      adminTelegramUserIds: snapshot.adminTelegramUserIds,
      operatorTelegramUserIds: snapshot.operatorTelegramUserIds,
      grantedChatIds: snapshot.grantedChatIds,
      membershipVerifier: options.membershipVerifier,
    });
  }

  async function authorize(
    botId: string,
    headers: Headers,
    capability: MiniAppCapability,
    requireCsrf: boolean,
  ) {
    if (!UUID_PATTERN.test(botId)) return { ok: false as const, status: 404 as const };
    const token = readCookie(headers.get("cookie") ?? undefined, MINI_APP_SESSION_COOKIE_NAME);
    if (!token || options.sessionSecret.length < 32) {
      return { ok: false as const, status: 401 as const };
    }
    try {
      const session = verifyMiniAppSession({
        token,
        expectedBotId: botId,
        signingSecret: options.sessionSecret,
        now: now(),
      });
      const access = await resolveAccess(botId, session.userId);
      if (!access) return { ok: false as const, status: 401 as const };
      if (!access.capabilities.includes(capability)) {
        return { ok: false as const, status: 403 as const };
      }
      if (requireCsrf && !secureEqual(headers.get("x-mini-app-csrf") ?? "", session.csrfToken)) {
        return { ok: false as const, status: 403 as const };
      }
      return { ok: true as const, userId: session.userId };
    } catch (error) {
      if (error instanceof MiniAppSessionError) {
        return { ok: false as const, status: 401 as const };
      }
      throw error;
    }
  }

  async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
    try {
      const body: unknown = await request.json();
      return body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return new Hono()
    .post("/:botId/session", async (c) => {
      const botId = c.req.param("botId");
      if (!UUID_PATTERN.test(botId)) return c.json({ ok: false as const, error: "Not found" }, 404);
      if (!rateLimiter.consume(clientKey(c.req.raw.headers, botId))) {
        return c.json({ ok: false as const, error: "Too many requests" }, 429);
      }
      if (options.sessionSecret.length < 32) {
        return c.json({ ok: false as const, error: "Mini App is not configured" }, 503);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false as const, error: "Invalid request" }, 400);
      }
      if (
        body == null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as { initData?: unknown }).initData !== "string"
      ) {
        return c.json({ ok: false as const, error: "Invalid request" }, 400);
      }

      const botToken = await options.botTokenResolver.resolve(botId);
      if (!botToken) return c.json({ ok: false as const, error: "Not found" }, 404);

      try {
        const requestNow = now();
        const verified = verifyTelegramInitData({
          initData: (body as { initData: string }).initData,
          botToken,
          now: requestNow,
        });
        const session = createMiniAppSession({
          botId,
          userId: verified.user.id,
          signingSecret: options.sessionSecret,
          now: requestNow,
        });
        const access = await resolveAccess(botId, verified.user.id);
        if (!access) return c.json({ ok: false as const, error: "Not found" }, 404);

        c.header("Set-Cookie", serializeMiniAppSessionCookie(botId, session.token));
        return c.json({
          ok: true as const,
          user: verified.user,
          session: {
            expiresAt: session.payload.expiresAt,
            csrfToken: session.payload.csrfToken,
          },
          access: publicAccess(access),
        });
      } catch (error) {
        if (error instanceof TelegramInitDataError || error instanceof MiniAppSessionError) {
          return c.json({ ok: false as const, error: "Unauthorized" }, 401);
        }
        throw error;
      }
    })
    .get("/:botId/session", async (c) => {
      const botId = c.req.param("botId");
      if (!UUID_PATTERN.test(botId))
        return c.json({ ok: false as const, error: "Unauthorized" }, 401);
      const token = readCookie(c.req.header("cookie"), MINI_APP_SESSION_COOKIE_NAME);
      if (!token || options.sessionSecret.length < 32) {
        c.header("Set-Cookie", clearMiniAppSessionCookie(botId));
        return c.json({ ok: false as const, error: "Unauthorized" }, 401);
      }

      try {
        const session = verifyMiniAppSession({
          token,
          expectedBotId: botId,
          signingSecret: options.sessionSecret,
          now: now(),
        });
        const access = await resolveAccess(botId, session.userId);
        if (!access) return c.json({ ok: false as const, error: "Unauthorized" }, 401);
        return c.json({
          ok: true as const,
          user: { id: session.userId },
          session: { expiresAt: session.expiresAt, csrfToken: session.csrfToken },
          access: publicAccess(access),
        });
      } catch (error) {
        if (error instanceof MiniAppSessionError) {
          c.header("Set-Cookie", clearMiniAppSessionCookie(botId));
          return c.json({ ok: false as const, error: "Unauthorized" }, 401);
        }
        throw error;
      }
    })
    .delete("/:botId/session", (c) => {
      const botId = c.req.param("botId");
      if (!UUID_PATTERN.test(botId)) return c.json({ ok: false as const, error: "Not found" }, 404);
      c.header("Set-Cookie", clearMiniAppSessionCookie(botId));
      return c.json({ ok: true as const });
    })
    .get("/:botId/access", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw.headers, "access.manage", false);
      if (!authorization.ok) {
        if (authorization.status === 401) {
          c.header("Set-Cookie", clearMiniAppSessionCookie(botId));
        }
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.accessService) {
        return c.json({ ok: false as const, error: "Mini App access is not configured" }, 503);
      }
      const actor = c.req.query("actor");
      const actorTelegramUserId = actor === undefined ? undefined : Number(actor);
      if (actor !== undefined && !isTelegramUserId(actorTelegramUserId)) {
        return c.json({ ok: false as const, error: "Invalid actor filter" }, 400);
      }
      const action = c.req.query("action")?.trim();
      const resource = c.req.query("resource")?.trim();
      if ((action && action.length > 64) || (resource && resource.length > 64)) {
        return c.json({ ok: false as const, error: "Invalid activity filter" }, 400);
      }
      const view = await options.accessService.readAccess(botId, {
        actorTelegramUserId,
        action: action || undefined,
        resource: resource || undefined,
      });
      return c.json({ ok: true as const, ...view });
    })
    .get("/:botId/access/people", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw.headers, "access.manage", false);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.accessService) {
        return c.json({ ok: false as const, error: "Mini App access is not configured" }, 503);
      }
      const query = c.req.query("query") ?? "";
      if (query.length > 64) return c.json({ ok: false as const, error: "Invalid query" }, 400);
      return c.json({
        ok: true as const,
        people: await options.accessService.searchPeople(botId, query),
      });
    })
    .post("/:botId/access/chat-grants", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw.headers, "access.manage", true);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.accessService) {
        return c.json({ ok: false as const, error: "Mini App access is not configured" }, 503);
      }
      const body = await readJsonBody(c.req.raw);
      const note = parseNote(body?.["note"]);
      if (!body || !isTelegramChatId(body["chatId"]) || note === undefined) {
        return c.json({ ok: false as const, error: "Invalid request" }, 400);
      }
      try {
        await options.accessService.grantChat({
          botId,
          actorTelegramUserId: authorization.userId,
          chatId: body["chatId"],
          note,
        });
        return c.json({ ok: true as const });
      } catch (error) {
        if (error instanceof MiniAppAccessError) {
          const mapped = accessError(error);
          return c.json(mapped.body, mapped.status);
        }
        throw error;
      }
    })
    .delete("/:botId/access/chat-grants/:chatId", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw.headers, "access.manage", true);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.accessService) {
        return c.json({ ok: false as const, error: "Mini App access is not configured" }, 503);
      }
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      try {
        await options.accessService.revokeChat({
          botId,
          actorTelegramUserId: authorization.userId,
          chatId,
        });
        return c.json({ ok: true as const });
      } catch (error) {
        if (error instanceof MiniAppAccessError) {
          const mapped = accessError(error);
          return c.json(mapped.body, mapped.status);
        }
        throw error;
      }
    })
    .post("/:botId/access/operator-grants", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw.headers, "access.manage", true);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.accessService) {
        return c.json({ ok: false as const, error: "Mini App access is not configured" }, 503);
      }
      const body = await readJsonBody(c.req.raw);
      const note = parseNote(body?.["note"]);
      if (!body || !isTelegramUserId(body["telegramUserId"]) || note === undefined) {
        return c.json({ ok: false as const, error: "Invalid request" }, 400);
      }
      try {
        await options.accessService.grantOperator({
          botId,
          actorTelegramUserId: authorization.userId,
          telegramUserId: body["telegramUserId"],
          note,
        });
        return c.json({ ok: true as const });
      } catch (error) {
        if (error instanceof MiniAppAccessError) {
          const mapped = accessError(error);
          return c.json(mapped.body, mapped.status);
        }
        throw error;
      }
    })
    .delete("/:botId/access/operator-grants/:telegramUserId", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw.headers, "access.manage", true);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.accessService) {
        return c.json({ ok: false as const, error: "Mini App access is not configured" }, 503);
      }
      const telegramUserId = Number(c.req.param("telegramUserId"));
      if (!isTelegramUserId(telegramUserId)) {
        return c.json({ ok: false as const, error: "Invalid Telegram user ID" }, 400);
      }
      try {
        await options.accessService.revokeOperator({
          botId,
          actorTelegramUserId: authorization.userId,
          telegramUserId,
        });
        return c.json({ ok: true as const });
      } catch (error) {
        if (error instanceof MiniAppAccessError) {
          const mapped = accessError(error);
          return c.json(mapped.body, mapped.status);
        }
        throw error;
      }
    });
}
