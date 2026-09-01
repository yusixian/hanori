import { describe, expect, it } from "vitest";
import { projectMiniAppLogEntry } from "./mini-app-log-service.js";

describe("projectMiniAppLogEntry", () => {
  it("preserves detailed owner-facing messages and metadata", () => {
    const projected = projectMiniAppLogEntry({
      id: 12,
      level: "warn",
      message: "Command rejected",
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      meta: {
        command: "/help",
        chatType: "private",
        updateId: 44,
        messageId: 55,
        text: "private message",
        args: ["private", "arguments"],
        apiKey: "secret-api-key",
        token: "secret-token",
        provider: { credential: "secret-provider-credential" },
        model: { credential: "secret-model-credential" },
        error: new Error("secret error"),
        stack: "secret stack",
      },
    });

    expect(projected).toEqual({
      id: 12,
      level: "warn",
      message: "Command rejected",
      createdAt: "2026-07-28T00:00:00.000Z",
      meta: expect.objectContaining({
        command: "/help",
        text: "private message",
        args: ["private", "arguments"],
        apiKey: "secret-api-key",
      }),
    });
    expect(JSON.stringify(projected)).toContain("private message");
  });

  it("normalizes unknown levels without replacing the stored diagnostic", () => {
    const projected = projectMiniAppLogEntry({
      id: 1,
      level: "unexpected",
      message:
        "token=secret-token Bearer bearer.secret 123456789:telegram_bot_secret_1234567890\nsecret stack",
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      meta: { command: "/help secret args", chatType: "secret", updateId: -1, messageId: 1.5 },
    });

    expect(projected.level).toBe("info");
    expect(projected.message).toContain("secret-token");
    expect(projected.meta).toEqual({
      command: "/help secret args",
      chatType: "secret",
      updateId: -1,
      messageId: 1.5,
    });
  });
});
