import { describe, expect, test, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createLogMiddleware } from "./log.js";

describe("createLogMiddleware", () => {
  test("redacts /apikey command arguments", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 1, username: "admin" },
      chat: { id: 1, type: "private" },
      message: {
        text: "/apikey image secret-value",
        entities: [{ type: "bot_command" }],
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Command /apikey from admin",
      meta: {
        userId: 1,
        username: "admin",
        chatId: 1,
        chatType: "private",
        command: "apikey",
        args: "[REDACTED]",
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("secret-value");
    expect(next).toHaveBeenCalledOnce();
  });
});
