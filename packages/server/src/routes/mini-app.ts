import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import type { MiniAppCapability } from "@cos-tool-bot/shared";
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { tryDecrypt } from "../utils/crypto.js";
import {
  GroupConfigArchivedError,
  GroupConfigConflictError,
  GroupConfigNotFoundError,
  GroupConfigUnavailableError,
  type GroupConfigService,
} from "../services/group-config-service.js";
import {
  ChatAiSelectionError,
  type ChatAiSelectionService,
} from "../services/chat-ai-selection-service.js";
import { BotLifecycleError, type BotLifecycleService } from "../services/bot-lifecycle-service.js";
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
  allowedOrigins?: readonly string[];
  botTokenResolver: MiniAppBotTokenResolver;
  directory: Pick<TelegramDirectoryService, "readAccessSnapshot"> | DirectoryReader;
  membershipVerifier: TelegramMembershipVerifier;
  accessPolicy?: MiniAppAccessPolicy;
  accessService?: Pick<
    MiniAppAccessService,
    "readAccess" | "searchPeople" | "grantChat" | "revokeChat" | "grantOperator" | "revokeOperator"
  >;
  groupConfigService?: Pick<GroupConfigService, "list" | "read" | "patch" | "retryApply">;
  chatAiSelectionService?: Pick<
    ChatAiSelectionService,
    | "listOptions"
    | "readGlobal"
    | "readChat"
    | "setGlobal"
    | "setChat"
    | "resetChat"
    | "setDisplayPolicy"
    | "retryPublish"
  >;
  botLifecycleService?: Pick<BotLifecycleService, "read" | "enable" | "disable" | "restart">;
  rateLimiter?: MiniAppSessionRateLimiter;
  now?: () => Date | number;
}

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });

const groupConfigPatchSchema = z
  .object({
    expectedRevision: z.string().min(1).max(100),
    patch: z
      .object({
        group: z
          .object({
            enabled: z.boolean().optional(),
            whitelisted: z.boolean().optional(),
            trigger: z
              .object({
                replyToBot: z.boolean().optional(),
                mentionBot: z.boolean().optional(),
                triggerWords: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
                randomReplyPercent: z.number().min(0).max(100).optional(),
                randomReplyCooldown: z.number().int().min(0).max(86_400).optional(),
              })
              .strict()
              .optional(),
            conversation: z
              .object({
                enabled: z.boolean().optional(),
                maxContextMessages: z.number().int().min(1).max(100).optional(),
                groupHistoryMaxTokens: z.number().int().min(2_000).max(64_000).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        summary: z
          .object({
            enabled: z.boolean().optional(),
            scheduleHour: z.number().int().min(0).max(23).nullable().optional(),
            scheduleMinute: z.number().int().min(0).max(59).nullable().optional(),
            timezone: timezoneSchema.nullable().optional(),
            windowHours: z.number().int().min(1).max(72).optional(),
            maxMessages: z.number().int().min(10).max(2_000).nullable().optional(),
            cooldownSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((patch) => patch.group !== undefined || patch.summary !== undefined),
  })
  .strict();

const selectionIdSchema = z.string().trim().min(1).max(256);
const selectionRevisionSchema = z.string().min(1).max(512);
const selectionPairSchema = z
  .object({
    expectedRevision: selectionRevisionSchema,
    providerId: selectionIdSchema,
    modelId: selectionIdSchema.nullable(),
  })
  .strict();
const globalSelectionPatchSchema = selectionPairSchema.extend({
  displayDefault: z.enum(["show", "hide"]).optional(),
});
const resetSelectionSchema = z.object({ expectedRevision: selectionRevisionSchema }).strict();
const selectionDisplaySchema = z
  .object({
    expectedRevision: selectionRevisionSchema,
    policy: z.enum(["inherit", "show", "hide"]),
  })
  .strict();

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

async function selectionError(
  error: unknown,
  latest?: () => Promise<unknown>,
): Promise<{
  status: 404 | 409 | 503;
  body: {
    ok: false;
    error: string;
    code: string;
    latest?: unknown;
  };
}> {
  if (!(error instanceof ChatAiSelectionError)) {
    return {
      status: 503,
      body: { ok: false, error: "AI selection is temporarily unavailable", code: "unavailable" },
    };
  }
  if (error.code === "not_found") {
    return { status: 404, body: { ok: false, error: "Not found", code: error.code } };
  }
  if (error.code === "ai_not_configured") {
    return {
      status: 503,
      body: { ok: false, error: "AI selection is unavailable", code: error.code },
    };
  }
  if (error.code === "stale_revision") {
    try {
      return {
        status: 409,
        body: {
          ok: false,
          error: "Stale revision",
          code: error.code,
          ...(latest ? { latest: await latest() } : {}),
        },
      };
    } catch {
      return {
        status: 503,
        body: { ok: false, error: "AI selection is temporarily unavailable", code: "unavailable" },
      };
    }
  }
  const publicError =
    error.code === "archived"
      ? "Archived chats are read-only"
      : error.code === "provider_unavailable"
        ? "Provider is unavailable"
        : "Model is unavailable for this Provider";
  return { status: 409, body: { ok: false, error: publicError, code: error.code } };
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

function chatScopeAllows(
  access: Awaited<ReturnType<MiniAppAccessPolicy["resolve"]>>,
  chatId: number,
): boolean {
  return (
    access.chatScope.kind === "all" ||
    (access.chatScope.kind === "granted" && access.chatScope.chatIds.includes(chatId))
  );
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
    request: Request,
    capability: MiniAppCapability,
    requireCsrf: boolean,
  ) {
    const { headers } = request;
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
      if (requireCsrf) {
        const origin = headers.get("origin");
        const allowedOrigins = options.allowedOrigins ?? [new URL(request.url).origin];
        if (!origin || !allowedOrigins.includes(origin)) {
          return { ok: false as const, status: 403 as const };
        }
        if (!secureEqual(headers.get("x-mini-app-csrf") ?? "", session.csrfToken)) {
          return { ok: false as const, status: 403 as const };
        }
      }
      return { ok: true as const, userId: session.userId, access };
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
      const authorization = await authorize(botId, c.req.raw, "access.manage", false);
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
      const authorization = await authorize(botId, c.req.raw, "access.manage", false);
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
      const authorization = await authorize(botId, c.req.raw, "access.manage", true);
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
      const authorization = await authorize(botId, c.req.raw, "access.manage", true);
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
      const authorization = await authorize(botId, c.req.raw, "access.manage", true);
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
      const authorization = await authorize(botId, c.req.raw, "access.manage", true);
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
    })
    .get("/:botId/groups", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw, "group.config.read", false);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.groupConfigService) {
        return c.json({ ok: false as const, error: "Group configuration is not available" }, 503);
      }
      const scope =
        authorization.access.chatScope.kind === "all"
          ? ("all" as const)
          : authorization.access.chatScope.kind === "granted"
            ? authorization.access.chatScope.chatIds
            : [];
      try {
        const groups = await options.groupConfigService.list(botId, scope);
        return c.json({
          ok: true as const,
          editable: authorization.access.capabilities.includes("group.config.write"),
          groups,
        });
      } catch (error) {
        if (error instanceof GroupConfigNotFoundError) {
          return c.json({ ok: false as const, error: "Not found" }, 404);
        }
        throw error;
      }
    })
    .get("/:botId/groups/:chatId", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "group.config.read", false);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.groupConfigService) {
        return c.json({ ok: false as const, error: "Group configuration is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          editable: authorization.access.capabilities.includes("group.config.write"),
          group: await options.groupConfigService.read(botId, chatId),
        });
      } catch (error) {
        if (error instanceof GroupConfigNotFoundError) {
          return c.json({ ok: false as const, error: "Not found" }, 404);
        }
        throw error;
      }
    })
    .patch("/:botId/groups/:chatId", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "group.config.write", true);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.groupConfigService) {
        return c.json({ ok: false as const, error: "Group configuration is not available" }, 503);
      }
      const parsed = groupConfigPatchSchema.safeParse(await readJsonBody(c.req.raw));
      if (!parsed.success) return c.json({ ok: false as const, error: "Invalid request" }, 400);
      try {
        const result = await options.groupConfigService.patch({
          botId,
          chatId,
          actorTelegramUserId: authorization.userId,
          actorRole: authorization.access.role as "admin" | "operator",
          expectedRevision: parsed.data.expectedRevision,
          patch: parsed.data.patch,
        });
        return c.json({ ok: true as const, ...result });
      } catch (error) {
        if (error instanceof GroupConfigConflictError) {
          return c.json(
            {
              ok: false as const,
              error: "Stale revision",
              code: "stale_revision" as const,
              latest: await options.groupConfigService.read(botId, chatId),
            },
            409,
          );
        }
        if (error instanceof GroupConfigArchivedError) {
          return c.json(
            { ok: false as const, error: error.message, code: "archived" as const },
            409,
          );
        }
        if (error instanceof GroupConfigUnavailableError) {
          return c.json(
            { ok: false as const, error: error.message, code: "ai_not_configured" as const },
            409,
          );
        }
        if (error instanceof GroupConfigNotFoundError) {
          return c.json({ ok: false as const, error: "Not found" }, 404);
        }
        throw error;
      }
    })
    .post("/:botId/groups/:chatId/retry-apply", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "bot.settings.write", true);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.groupConfigService) {
        return c.json({ ok: false as const, error: "Group configuration is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          group: await options.groupConfigService.retryApply(botId, chatId),
        });
      } catch (error) {
        if (error instanceof GroupConfigNotFoundError) {
          return c.json({ ok: false as const, error: "Not found" }, 404);
        }
        if (error instanceof GroupConfigArchivedError) {
          return c.json(
            { ok: false as const, error: error.message, code: "archived" as const },
            409,
          );
        }
        return c.json({ ok: false as const, error: "Runtime apply failed" }, 503);
      }
    })
    .get("/:botId/lifecycle", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw, "bot.settings.read", false);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.botLifecycleService) {
        return c.json({ ok: false as const, error: "Bot lifecycle is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          lifecycle: await options.botLifecycleService.read(botId),
        });
      } catch (error) {
        if (error instanceof BotLifecycleError && error.code === "not_found") {
          return c.json({ ok: false as const, error: "Not found" }, 404);
        }
        return c.json({ ok: false as const, error: "Bot lifecycle is unavailable" }, 503);
      }
    })
    .post("/:botId/lifecycle/:action", async (c) => {
      const botId = c.req.param("botId");
      const action = c.req.param("action");
      if (action !== "enable" && action !== "disable" && action !== "restart") {
        return c.json({ ok: false as const, error: "Not found" }, 404);
      }
      const authorization = await authorize(botId, c.req.raw, "bot.lifecycle.manage", true);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.botLifecycleService) {
        return c.json({ ok: false as const, error: "Bot lifecycle is not available" }, 503);
      }
      try {
        const input = {
          botId,
          actor: { kind: "telegram_user" as const, id: String(authorization.userId) },
        };
        const lifecycle =
          action === "enable"
            ? await options.botLifecycleService.enable(input)
            : action === "disable"
              ? await options.botLifecycleService.disable(input)
              : await options.botLifecycleService.restart(input);
        return c.json({ ok: true as const, lifecycle });
      } catch (error) {
        if (error instanceof BotLifecycleError) {
          const status =
            error.code === "not_found" ? 404 : error.code === "desired_inactive" ? 409 : 503;
          return c.json({ ok: false as const, error: error.message, code: error.code }, status);
        }
        return c.json({ ok: false as const, error: "Bot lifecycle operation failed" }, 503);
      }
    })
    .get("/:botId/ai-selection/options", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", false);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          options: await options.chatAiSelectionService.listOptions(botId),
        });
      } catch (error) {
        const mapped = await selectionError(error);
        return c.json(mapped.body, mapped.status);
      }
    })
    .get("/:botId/ai-selection/global", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", false);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          global: await options.chatAiSelectionService.readGlobal(botId),
        });
      } catch (error) {
        const mapped = await selectionError(error);
        return c.json(mapped.body, mapped.status);
      }
    })
    .patch("/:botId/ai-selection/global", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", true);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      const parsed = globalSelectionPatchSchema.safeParse(await readJsonBody(c.req.raw));
      if (!parsed.success) return c.json({ ok: false as const, error: "Invalid request" }, 400);
      try {
        const result = await options.chatAiSelectionService.setGlobal({
          botId,
          expectedRevision: parsed.data.expectedRevision,
          pair: { providerId: parsed.data.providerId, modelId: parsed.data.modelId },
          ...(parsed.data.displayDefault ? { displayDefault: parsed.data.displayDefault } : {}),
          actor: { kind: "telegram_user", id: String(authorization.userId) },
        });
        return c.json({ ok: true as const, ...result });
      } catch (error) {
        const mapped = await selectionError(error, () =>
          options.chatAiSelectionService!.readGlobal(botId),
        );
        return c.json(mapped.body, mapped.status);
      }
    })
    .post("/:botId/ai-selection/retry", async (c) => {
      const botId = c.req.param("botId");
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", true);
      if (!authorization.ok) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          ...(await options.chatAiSelectionService.retryPublish(botId)),
        });
      } catch (error) {
        const mapped = await selectionError(error);
        return c.json(mapped.body, mapped.status);
      }
    })
    .get("/:botId/groups/:chatId/ai-selection", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.read", false);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          editable: authorization.access.capabilities.includes("chat.ai-selection.write"),
          chat: await options.chatAiSelectionService.readChat(
            botId,
            chatId,
            authorization.access.role === "admin",
          ),
        });
      } catch (error) {
        const mapped = await selectionError(error);
        return c.json(mapped.body, mapped.status);
      }
    })
    .patch("/:botId/groups/:chatId/ai-selection", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", true);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      const parsed = selectionPairSchema.safeParse(await readJsonBody(c.req.raw));
      if (!parsed.success) return c.json({ ok: false as const, error: "Invalid request" }, 400);
      try {
        const result = await options.chatAiSelectionService.setChat({
          botId,
          chatId,
          expectedRevision: parsed.data.expectedRevision,
          pair: { providerId: parsed.data.providerId, modelId: parsed.data.modelId },
          actor: { kind: "telegram_user", id: String(authorization.userId) },
        });
        return c.json({ ok: true as const, ...result });
      } catch (error) {
        const mapped = await selectionError(error, () =>
          options.chatAiSelectionService!.readChat(botId, chatId, true),
        );
        return c.json(mapped.body, mapped.status);
      }
    })
    .delete("/:botId/groups/:chatId/ai-selection", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", true);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      const parsed = resetSelectionSchema.safeParse(await readJsonBody(c.req.raw));
      if (!parsed.success) return c.json({ ok: false as const, error: "Invalid request" }, 400);
      try {
        const result = await options.chatAiSelectionService.resetChat({
          botId,
          chatId,
          expectedRevision: parsed.data.expectedRevision,
          actor: { kind: "telegram_user", id: String(authorization.userId) },
        });
        return c.json({ ok: true as const, ...result });
      } catch (error) {
        const mapped = await selectionError(error, () =>
          options.chatAiSelectionService!.readChat(botId, chatId, true),
        );
        return c.json(mapped.body, mapped.status);
      }
    })
    .patch("/:botId/groups/:chatId/ai-selection/display", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", true);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      const parsed = selectionDisplaySchema.safeParse(await readJsonBody(c.req.raw));
      if (!parsed.success) return c.json({ ok: false as const, error: "Invalid request" }, 400);
      try {
        const result = await options.chatAiSelectionService.setDisplayPolicy({
          botId,
          chatId,
          expectedRevision: parsed.data.expectedRevision,
          policy: parsed.data.policy,
          actor: { kind: "telegram_user", id: String(authorization.userId) },
        });
        return c.json({ ok: true as const, ...result });
      } catch (error) {
        const mapped = await selectionError(error, () =>
          options.chatAiSelectionService!.readChat(botId, chatId, true),
        );
        return c.json(mapped.body, mapped.status);
      }
    })
    .post("/:botId/groups/:chatId/ai-selection/retry", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      if (!isTelegramChatId(chatId)) {
        return c.json({ ok: false as const, error: "Invalid chat ID" }, 400);
      }
      const authorization = await authorize(botId, c.req.raw, "chat.ai-selection.write", true);
      if (!authorization.ok || !chatScopeAllows(authorization.access, chatId)) {
        return c.json(
          {
            ok: false as const,
            error: authorization.status === 401 ? "Unauthorized" : "Forbidden",
          },
          authorization.ok ? 403 : authorization.status,
        );
      }
      if (!options.chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection is not available" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          ...(await options.chatAiSelectionService.retryPublish(botId)),
        });
      } catch (error) {
        const mapped = await selectionError(error);
        return c.json(mapped.body, mapped.status);
      }
    });
}
