import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MINI_APP_SESSION_VERSION = 1;
export const MINI_APP_SESSION_TTL_SECONDS = 15 * 60;
export const MINI_APP_SESSION_COOKIE_NAME = "cos_mini_app_session";

export type MiniAppSessionErrorCode =
  | "INVALID_SESSION"
  | "INVALID_SESSION_CONFIG"
  | "BOT_SCOPE_MISMATCH"
  | "EXPIRED_SESSION"
  | "FUTURE_SESSION";

/** Safe for structured logging: it never retains the submitted session token. */
export class MiniAppSessionError extends Error {
  readonly code: MiniAppSessionErrorCode;

  constructor(code: MiniAppSessionErrorCode) {
    super(code);
    this.name = "MiniAppSessionError";
    this.code = code;
  }
}

export interface MiniAppSessionPayload {
  version: typeof MINI_APP_SESSION_VERSION;
  botId: string;
  userId: number;
  issuedAt: number;
  expiresAt: number;
  csrfToken: string;
}

export interface CreateMiniAppSessionInput {
  botId: string;
  userId: number;
  signingSecret: string;
  now?: Date | number;
  csrfToken?: string;
}

export interface VerifyMiniAppSessionInput {
  token: string;
  expectedBotId: string;
  signingSecret: string;
  now?: Date | number;
}

function unixSeconds(now: Date | number | undefined): number {
  const milliseconds = now instanceof Date ? now.getTime() : (now ?? Date.now());
  if (!Number.isFinite(milliseconds)) {
    throw new MiniAppSessionError("INVALID_SESSION_CONFIG");
  }
  return Math.floor(milliseconds / 1000);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertBotId(botId: string): void {
  if (botId.length === 0 || botId.length > 256 || hasControlCharacters(botId)) {
    throw new MiniAppSessionError("INVALID_SESSION_CONFIG");
  }
}

function assertSigningSecret(signingSecret: string): void {
  if (signingSecret.length < 32) {
    throw new MiniAppSessionError("INVALID_SESSION_CONFIG");
  }
}

function deriveBotSigningKey(signingSecret: string, botId: string): Buffer {
  return createHmac("sha256", signingSecret).update(`mini-app-session\n${botId}`).digest();
}

function sign(encodedPayload: string, signingSecret: string, botId: string): Buffer {
  return createHmac("sha256", deriveBotSigningKey(signingSecret, botId))
    .update(encodedPayload)
    .digest();
}

function decodeBase64Url(value: string): Buffer | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function isValidPayload(value: unknown): value is MiniAppSessionPayload {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 6 ||
    !["version", "botId", "userId", "issuedAt", "expiresAt", "csrfToken"].every((key) =>
      Object.hasOwn(record, key),
    )
  ) {
    return false;
  }
  return (
    record["version"] === MINI_APP_SESSION_VERSION &&
    typeof record["botId"] === "string" &&
    record["botId"].length > 0 &&
    Number.isSafeInteger(record["userId"]) &&
    (record["userId"] as number) > 0 &&
    Number.isSafeInteger(record["issuedAt"]) &&
    (record["issuedAt"] as number) > 0 &&
    Number.isSafeInteger(record["expiresAt"]) &&
    (record["expiresAt"] as number) > 0 &&
    typeof record["csrfToken"] === "string" &&
    /^[A-Za-z0-9_-]{32,}$/.test(record["csrfToken"])
  );
}

export function createMiniAppSession(input: CreateMiniAppSessionInput): {
  token: string;
  payload: MiniAppSessionPayload;
} {
  assertBotId(input.botId);
  assertSigningSecret(input.signingSecret);
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new MiniAppSessionError("INVALID_SESSION_CONFIG");
  }

  const issuedAt = unixSeconds(input.now);
  const csrfToken = input.csrfToken ?? randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,}$/.test(csrfToken)) {
    throw new MiniAppSessionError("INVALID_SESSION_CONFIG");
  }
  const payload: MiniAppSessionPayload = {
    version: MINI_APP_SESSION_VERSION,
    botId: input.botId,
    userId: input.userId,
    issuedAt,
    expiresAt: issuedAt + MINI_APP_SESSION_TTL_SECONDS,
    csrfToken,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(encodedPayload, input.signingSecret, input.botId).toString("base64url");
  return { token: `${encodedPayload}.${signature}`, payload };
}

export function verifyMiniAppSession(input: VerifyMiniAppSessionInput): MiniAppSessionPayload {
  assertBotId(input.expectedBotId);
  assertSigningSecret(input.signingSecret);
  if (input.token.length === 0 || input.token.length > 4096) {
    throw new MiniAppSessionError("INVALID_SESSION");
  }

  const parts = input.token.split(".");
  if (parts.length !== 2) throw new MiniAppSessionError("INVALID_SESSION");
  const encodedPayload = parts[0] ?? "";
  const encodedSignature = parts[1] ?? "";
  const payloadBytes = decodeBase64Url(encodedPayload);
  const receivedSignature = decodeBase64Url(encodedSignature);
  if (payloadBytes == null || receivedSignature == null) {
    throw new MiniAppSessionError("INVALID_SESSION");
  }

  let value: unknown;
  try {
    value = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new MiniAppSessionError("INVALID_SESSION");
  }
  if (!isValidPayload(value)) throw new MiniAppSessionError("INVALID_SESSION");
  if (value.botId.length > 256 || hasControlCharacters(value.botId)) {
    throw new MiniAppSessionError("INVALID_SESSION");
  }
  if (Buffer.from(JSON.stringify(value), "utf8").toString("base64url") !== encodedPayload) {
    throw new MiniAppSessionError("INVALID_SESSION");
  }
  const expectedSignature = sign(encodedPayload, input.signingSecret, value.botId);
  if (
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new MiniAppSessionError("INVALID_SESSION");
  }
  if (value.botId !== input.expectedBotId) {
    throw new MiniAppSessionError("BOT_SCOPE_MISMATCH");
  }
  if (
    value.expiresAt !== value.issuedAt + MINI_APP_SESSION_TTL_SECONDS ||
    value.expiresAt <= value.issuedAt
  ) {
    throw new MiniAppSessionError("INVALID_SESSION");
  }

  const now = unixSeconds(input.now);
  if (value.issuedAt > now) throw new MiniAppSessionError("FUTURE_SESSION");
  if (value.expiresAt <= now) throw new MiniAppSessionError("EXPIRED_SESSION");
  return value;
}

function cookiePath(botId: string): string {
  assertBotId(botId);
  return `/api/mini-app/${encodeURIComponent(botId)}`;
}

export function serializeMiniAppSessionCookie(botId: string, token: string): string {
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new MiniAppSessionError("INVALID_SESSION_CONFIG");
  }
  return `${MINI_APP_SESSION_COOKIE_NAME}=${token}; Path=${cookiePath(botId)}; Max-Age=${MINI_APP_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearMiniAppSessionCookie(botId: string): string {
  return `${MINI_APP_SESSION_COOKIE_NAME}=; Path=${cookiePath(botId)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}
