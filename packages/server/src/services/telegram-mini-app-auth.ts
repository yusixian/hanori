import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 5 * 60;
export const MAX_TELEGRAM_INIT_DATA_BYTES = 16 * 1024;
const MAX_TELEGRAM_INIT_DATA_FIELDS = 100;

export type TelegramInitDataErrorCode =
  | "MALFORMED_INIT_DATA"
  | "MISSING_HASH"
  | "DUPLICATE_FIELD"
  | "INVALID_HASH"
  | "INVALID_AUTH_DATE"
  | "EXPIRED_AUTH_DATE"
  | "FUTURE_AUTH_DATE"
  | "MISSING_USER"
  | "INVALID_USER";

/** Safe for structured logging: it never retains the submitted initData. */
export class TelegramInitDataError extends Error {
  readonly code: TelegramInitDataErrorCode;

  constructor(code: TelegramInitDataErrorCode) {
    super(code);
    this.name = "TelegramInitDataError";
    this.code = code;
  }
}

export interface TelegramMiniAppUser {
  id: number;
  isBot: false;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  allowsWriteToPm?: boolean;
}

export interface VerifiedTelegramInitData {
  authDate: number;
  queryId?: string;
  user: TelegramMiniAppUser;
}

export interface VerifyTelegramInitDataInput {
  initData: string;
  botToken: string;
  now?: Date | number;
  maxAgeSeconds?: number;
}

function toUnixSeconds(now: Date | number | undefined): number {
  const milliseconds = now instanceof Date ? now.getTime() : (now ?? Date.now());
  if (!Number.isFinite(milliseconds)) {
    throw new TelegramInitDataError("MALFORMED_INIT_DATA");
  }
  return Math.floor(milliseconds / 1000);
}

function readUniqueFields(initData: string): Map<string, string> {
  if (
    initData.length === 0 ||
    initData.length > MAX_TELEGRAM_INIT_DATA_BYTES ||
    Buffer.byteLength(initData, "utf8") > MAX_TELEGRAM_INIT_DATA_BYTES
  ) {
    throw new TelegramInitDataError("MALFORMED_INIT_DATA");
  }

  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(initData)) {
    if (fields.has(key)) {
      throw new TelegramInitDataError("DUPLICATE_FIELD");
    }
    fields.set(key, value);
    if (fields.size > MAX_TELEGRAM_INIT_DATA_FIELDS) {
      throw new TelegramInitDataError("MALFORMED_INIT_DATA");
    }
  }

  if (fields.size === 0) {
    throw new TelegramInitDataError("MALFORMED_INIT_DATA");
  }
  return fields;
}

function verifyHash(fields: ReadonlyMap<string, string>, botToken: string): void {
  const receivedHex = fields.get("hash");
  if (receivedHex == null || receivedHex.length === 0) {
    throw new TelegramInitDataError("MISSING_HASH");
  }
  if (!/^[0-9a-f]{64}$/i.test(receivedHex)) {
    throw new TelegramInitDataError("INVALID_HASH");
  }
  if (botToken.length === 0) {
    throw new TelegramInitDataError("INVALID_HASH");
  }

  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const received = Buffer.from(receivedHex, "hex");

  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new TelegramInitDataError("INVALID_HASH");
  }
}

function parseAuthDate(fields: ReadonlyMap<string, string>): number {
  const value = fields.get("auth_date");
  if (value == null || !/^[0-9]+$/.test(value)) {
    throw new TelegramInitDataError("INVALID_AUTH_DATE");
  }
  const authDate = Number(value);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new TelegramInitDataError("INVALID_AUTH_DATE");
  }
  return authDate;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseUser(fields: ReadonlyMap<string, string>): TelegramMiniAppUser {
  const encodedUser = fields.get("user");
  if (encodedUser == null) {
    throw new TelegramInitDataError("MISSING_USER");
  }

  let value: unknown;
  try {
    value = JSON.parse(encodedUser);
  } catch {
    throw new TelegramInitDataError("INVALID_USER");
  }

  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramInitDataError("INVALID_USER");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record["id"]) ||
    (record["id"] as number) <= 0 ||
    record["is_bot"] === true
  ) {
    throw new TelegramInitDataError("INVALID_USER");
  }

  return {
    id: record["id"] as number,
    isBot: false,
    firstName: readOptionalString(record["first_name"]),
    lastName: readOptionalString(record["last_name"]),
    username: readOptionalString(record["username"]),
    languageCode: readOptionalString(record["language_code"]),
    allowsWriteToPm:
      typeof record["allows_write_to_pm"] === "boolean" ? record["allows_write_to_pm"] : undefined,
  };
}

export function verifyTelegramInitData(
  input: VerifyTelegramInitDataInput,
): VerifiedTelegramInitData {
  const fields = readUniqueFields(input.initData);
  verifyHash(fields, input.botToken);

  const authDate = parseAuthDate(fields);
  const now = toUnixSeconds(input.now);
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_TELEGRAM_INIT_DATA_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new TelegramInitDataError("MALFORMED_INIT_DATA");
  }
  if (authDate > now) {
    throw new TelegramInitDataError("FUTURE_AUTH_DATE");
  }
  if (now - authDate > maxAgeSeconds) {
    throw new TelegramInitDataError("EXPIRED_AUTH_DATE");
  }

  return {
    authDate,
    queryId: fields.get("query_id") || undefined,
    user: parseUser(fields),
  };
}
