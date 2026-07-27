import { describe, expect, it } from "vitest";
import { projectMiniAppLogEntry } from "./mini-app-log-service.js";

describe("projectMiniAppLogEntry", () => {
  it("returns only the explicitly safe Mini App projection", () => {
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
      message: "Command received",
      createdAt: "2026-07-28T00:00:00.000Z",
      meta: { command: "help", chatType: "private", updateId: 44, messageId: 55 },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /private message|arguments|secret-api-key|secret-token|credential|secret error|secret stack/,
    );
  });

  it("drops unsafe metadata values without echoing the stored message", () => {
    const projected = projectMiniAppLogEntry({
      id: 1,
      level: "unexpected",
      message:
        "token=secret-token Bearer bearer.secret 123456789:telegram_bot_secret_1234567890\nsecret stack",
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      meta: { command: "/help secret args", chatType: "secret", updateId: -1, messageId: 1.5 },
    });

    expect(projected.level).toBe("info");
    expect(projected.message).toBe("Runtime event");
    expect(projected.meta).toEqual({});
  });

  it("never echoes arbitrary credential-shaped provider errors", () => {
    const projected = projectMiniAppLogEntry({
      id: 1,
      level: "error",
      message:
        'Authorization: Basic dXNlcjpwYXNz password="two words" https://user:pass@example.test sk-proj-abcdefghijklmnop AIzaabcdefghijklmnopqrstuv AKIAIOSFODNN7EXAMPLE',
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      meta: null,
    });

    expect(projected.message).toBe("Runtime error");
    expect(projected.message).not.toMatch(/dXNlcj|two words|user:pass|sk-proj|AIza|AKIA/);
  });

  it("maps private captions, filenames, and sticker packs to a fixed Telegram event", () => {
    const projected = projectMiniAppLogEntry({
      id: 1,
      level: "info",
      message: "Photo: private caption; Document: secret.pdf; Sticker (private-pack)",
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      meta: { chatType: "private", updateId: 9, messageId: 10 },
    });

    expect(projected.message).toBe("Telegram update received");
    expect(projected.message).not.toMatch(/private caption|secret\.pdf|private-pack/);
  });

  it("preserves only explicitly allowlisted static lifecycle messages", () => {
    const projected = projectMiniAppLogEntry({
      id: 1,
      level: "info",
      message: "Bot started",
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      meta: null,
    });

    expect(projected.message).toBe("Bot started");
  });
});
