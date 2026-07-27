import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_TELEGRAM_INIT_DATA_BYTES,
  TelegramInitDataError,
  verifyTelegramInitData,
} from "./telegram-mini-app-auth.js";

const BOT_TOKEN = "123456:test-token";
const NOW_SECONDS = 1_800_000_000;

function signInitData(
  fields: ReadonlyArray<readonly [string, string]>,
  botToken = BOT_TOKEN,
): string {
  const dataCheckString = [...fields]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams(
    [...fields, ["hash", hash]].map(([key, value]) => [key, value] as [string, string]),
  ).toString();
}

function validFields(user: unknown = { id: 42, first_name: "Ada" }) {
  return [
    ["query_id", "AAEAAAE"],
    ["user", JSON.stringify(user)],
    ["auth_date", String(NOW_SECONDS)],
  ] as const;
}

function captureError(run: () => unknown): TelegramInitDataError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramInitDataError);
    return error as TelegramInitDataError;
  }
  throw new Error("Expected verification to fail");
}

describe("verifyTelegramInitData", () => {
  it("accepts an official-algorithm fixture and projects the signed user", () => {
    const result = verifyTelegramInitData({
      initData: signInitData(validFields()),
      botToken: BOT_TOKEN,
      now: NOW_SECONDS * 1000,
    });

    expect(result).toEqual({
      authDate: NOW_SECONDS,
      queryId: "AAEAAAE",
      user: {
        id: 42,
        isBot: false,
        firstName: "Ada",
        lastName: undefined,
        username: undefined,
        languageCode: undefined,
        allowsWriteToPm: undefined,
      },
    });
  });

  it("rejects missing, malformed and tampered hashes without retaining initData", () => {
    const missingHash = new URLSearchParams(
      validFields().map(([key, value]) => [key, value] as [string, string]),
    ).toString();
    expect(
      captureError(() =>
        verifyTelegramInitData({
          initData: missingHash,
          botToken: BOT_TOKEN,
          now: NOW_SECONDS * 1000,
        }),
      ).code,
    ).toBe("MISSING_HASH");

    const signed = signInitData(validFields());
    const tampered = signed.replace("Ada", "Eve");
    const error = captureError(() =>
      verifyTelegramInitData({ initData: tampered, botToken: BOT_TOKEN, now: NOW_SECONDS * 1000 }),
    );
    expect(error.code).toBe("INVALID_HASH");
    expect(error).not.toHaveProperty("initData");
    expect(error.message).not.toContain(tampered);
    expect(
      captureError(() =>
        verifyTelegramInitData({
          initData: signed,
          botToken: "654321:wrong-bot-token",
          now: NOW_SECONDS * 1000,
        }),
      ).code,
    ).toBe("INVALID_HASH");
  });

  it("rejects duplicate fields before signature verification", () => {
    const signed = signInitData(validFields());
    const duplicate = `${signed}&user=${encodeURIComponent('{"id":99}')}`;
    expect(
      captureError(() =>
        verifyTelegramInitData({
          initData: duplicate,
          botToken: BOT_TOKEN,
          now: NOW_SECONDS * 1000,
        }),
      ).code,
    ).toBe("DUPLICATE_FIELD");
  });

  it("rejects oversized input without retaining it", () => {
    const oversized = `user=${"x".repeat(MAX_TELEGRAM_INIT_DATA_BYTES)}`;
    const error = captureError(() =>
      verifyTelegramInitData({
        initData: oversized,
        botToken: BOT_TOKEN,
        now: NOW_SECONDS * 1000,
      }),
    );
    expect(error.code).toBe("MALFORMED_INIT_DATA");
    expect(error).not.toHaveProperty("initData");
  });

  it("rejects expired and future auth dates", () => {
    const expired = signInitData([
      ["user", '{"id":42}'],
      ["auth_date", String(NOW_SECONDS - 301)],
    ]);
    expect(
      captureError(() =>
        verifyTelegramInitData({ initData: expired, botToken: BOT_TOKEN, now: NOW_SECONDS * 1000 }),
      ).code,
    ).toBe("EXPIRED_AUTH_DATE");

    const future = signInitData([
      ["user", '{"id":42}'],
      ["auth_date", String(NOW_SECONDS + 1)],
    ]);
    expect(
      captureError(() =>
        verifyTelegramInitData({ initData: future, botToken: BOT_TOKEN, now: NOW_SECONDS * 1000 }),
      ).code,
    ).toBe("FUTURE_AUTH_DATE");
  });

  it.each([
    ["missing user", undefined],
    ["invalid JSON", "{"],
    ["bot user", JSON.stringify({ id: 42, is_bot: true })],
    ["zero user ID", JSON.stringify({ id: 0 })],
    ["negative user ID", JSON.stringify({ id: -42 })],
    ["unsafe user ID", JSON.stringify({ id: Number.MAX_SAFE_INTEGER + 1 })],
    ["string user ID", JSON.stringify({ id: "42" })],
  ])("rejects %s", (_label, user) => {
    const fields: Array<readonly [string, string]> = [["auth_date", String(NOW_SECONDS)]];
    if (user != null) fields.push(["user", user]);
    const initData = signInitData(fields);
    const error = captureError(() =>
      verifyTelegramInitData({ initData, botToken: BOT_TOKEN, now: NOW_SECONDS * 1000 }),
    );
    expect(error.code).toBe(user == null ? "MISSING_USER" : "INVALID_USER");
  });
});
