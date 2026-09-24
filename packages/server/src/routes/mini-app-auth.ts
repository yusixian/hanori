import { timingSafeEqual } from "node:crypto";
import {
  MINI_APP_SESSION_COOKIE_NAME,
  MiniAppSessionError,
  type MiniAppSessionPayload,
  verifyMiniAppSession,
} from "../services/mini-app-session.js";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MiniAppBotTokenResolver {
  resolve(botId: string): Promise<string | null>;
  isEnabled(botId: string): Promise<boolean>;
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export interface MiniAppSessionVerifierOptions {
  sessionSecret: string;
  allowedOrigins?: readonly string[];
  botTokenResolver: Pick<MiniAppBotTokenResolver, "isEnabled">;
  now?: () => Date | number;
}

export type MiniAppSessionCheck =
  | { ok: true; session: MiniAppSessionPayload }
  | { ok: false; status: 401 | 404 };

/** Verifies the signed session cookie for an enabled Mini App Bot; authorization is up to the caller. */
export function createMiniAppSessionVerifier(options: MiniAppSessionVerifierOptions) {
  const now = options.now ?? (() => new Date());
  return {
    async verify(botId: string, request: Request): Promise<MiniAppSessionCheck> {
      if (!UUID_PATTERN.test(botId)) return { ok: false, status: 404 };
      if (!(await options.botTokenResolver.isEnabled(botId))) return { ok: false, status: 404 };
      const token = readCookie(
        request.headers.get("cookie") ?? undefined,
        MINI_APP_SESSION_COOKIE_NAME,
      );
      if (!token || options.sessionSecret.length < 32) return { ok: false, status: 401 };
      try {
        const session = verifyMiniAppSession({
          token,
          expectedBotId: botId,
          signingSecret: options.sessionSecret,
          now: now(),
        });
        return { ok: true, session };
      } catch (error) {
        if (error instanceof MiniAppSessionError) return { ok: false, status: 401 };
        throw error;
      }
    },

    /** Writes must come from an allowed origin and echo the session's CSRF token. */
    checkCsrf(request: Request, session: MiniAppSessionPayload): boolean {
      const origin = request.headers.get("origin");
      const allowedOrigins = options.allowedOrigins ?? [new URL(request.url).origin];
      if (!origin || !allowedOrigins.includes(origin)) return false;
      return secureEqual(request.headers.get("x-mini-app-csrf") ?? "", session.csrfToken);
    },
  };
}

export type MiniAppSessionVerifier = ReturnType<typeof createMiniAppSessionVerifier>;
