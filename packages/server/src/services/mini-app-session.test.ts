import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clearMiniAppSessionCookie,
  createMiniAppSession,
  MINI_APP_SESSION_TTL_SECONDS,
  MiniAppSessionError,
  serializeMiniAppSessionCookie,
  verifyMiniAppSession,
} from "./mini-app-session.js";

const SECRET = "a-secure-test-secret-with-at-least-32-bytes";
const NOW_SECONDS = 1_800_000_000;
const CSRF = "test_csrf_token_1234567890_ABCDEFG";

function session(botId = "bot-a") {
  return createMiniAppSession({
    botId,
    userId: 42,
    signingSecret: SECRET,
    now: NOW_SECONDS * 1000,
    csrfToken: CSRF,
  });
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MiniAppSessionError);
    expect(error).not.toHaveProperty("token");
    return (error as MiniAppSessionError).code;
  }
  throw new Error("Expected session verification to fail");
}

function signRawPayload(payloadJson: string, botId = "bot-a"): string {
  const payload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const key = createHmac("sha256", SECRET).update(`mini-app-session\n${botId}`).digest();
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

describe("Mini App session", () => {
  it("creates a 15 minute Bot-scoped signed session", () => {
    const created = session();
    expect(created.payload).toEqual({
      version: 1,
      botId: "bot-a",
      userId: 42,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + MINI_APP_SESSION_TTL_SECONDS,
      csrfToken: CSRF,
    });
    expect(
      verifyMiniAppSession({
        token: created.token,
        expectedBotId: "bot-a",
        signingSecret: SECRET,
        now: (NOW_SECONDS + 899) * 1000,
      }),
    ).toEqual(created.payload);
  });

  it("rejects tampering, wrong Bot scope, expiry and future issuance", () => {
    const created = session();
    const [payload, signature] = created.token.split(".");
    const tampered = `${payload?.slice(0, -1)}A.${signature}`;
    expect(
      errorCode(() =>
        verifyMiniAppSession({
          token: tampered,
          expectedBotId: "bot-a",
          signingSecret: SECRET,
          now: NOW_SECONDS * 1000,
        }),
      ),
    ).toBe("INVALID_SESSION");
    expect(
      errorCode(() =>
        verifyMiniAppSession({
          token: created.token,
          expectedBotId: "bot-b",
          signingSecret: SECRET,
          now: NOW_SECONDS * 1000,
        }),
      ),
    ).toBe("BOT_SCOPE_MISMATCH");
    expect(
      errorCode(() =>
        verifyMiniAppSession({
          token: created.token,
          expectedBotId: "bot-a",
          signingSecret: SECRET,
          now: (NOW_SECONDS + 900) * 1000,
        }),
      ),
    ).toBe("EXPIRED_SESSION");
    expect(
      errorCode(() =>
        verifyMiniAppSession({
          token: created.token,
          expectedBotId: "bot-a",
          signingSecret: SECRET,
          now: (NOW_SECONDS - 1) * 1000,
        }),
      ),
    ).toBe("FUTURE_SESSION");
  });

  it("serializes and clears a secure bot-path cookie", () => {
    const created = session("bot/a");
    expect(serializeMiniAppSessionCookie("bot/a", created.token)).toBe(
      `cos_mini_app_session=${created.token}; Path=/api/mini-app/bot%2Fa; Max-Age=900; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
    expect(clearMiniAppSessionCookie("bot/a")).toBe(
      "cos_mini_app_session=; Path=/api/mini-app/bot%2Fa; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None; Partitioned",
    );
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe user ID %s", (userId) => {
    expect(
      errorCode(() =>
        createMiniAppSession({
          botId: "bot-a",
          userId,
          signingSecret: SECRET,
          now: NOW_SECONDS * 1000,
        }),
      ),
    ).toBe("INVALID_SESSION_CONFIG");
  });

  it("rejects signed payloads with duplicate fields or unsafe IDs", () => {
    const duplicate = signRawPayload(
      `{"version":1,"botId":"bot-a","userId":42,"userId":43,"issuedAt":${NOW_SECONDS},"expiresAt":${NOW_SECONDS + 900},"csrfToken":"${CSRF}"}`,
    );
    expect(
      errorCode(() =>
        verifyMiniAppSession({
          token: duplicate,
          expectedBotId: "bot-a",
          signingSecret: SECRET,
          now: NOW_SECONDS * 1000,
        }),
      ),
    ).toBe("INVALID_SESSION");

    const unsafeId = signRawPayload(
      JSON.stringify({
        version: 1,
        botId: "bot-a",
        userId: Number.MAX_SAFE_INTEGER + 1,
        issuedAt: NOW_SECONDS,
        expiresAt: NOW_SECONDS + 900,
        csrfToken: CSRF,
      }),
    );
    expect(
      errorCode(() =>
        verifyMiniAppSession({
          token: unsafeId,
          expectedBotId: "bot-a",
          signingSecret: SECRET,
          now: NOW_SECONDS * 1000,
        }),
      ),
    ).toBe("INVALID_SESSION");
  });
});
