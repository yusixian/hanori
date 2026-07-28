import { describe, expect, test } from "vitest";
import type { BotContext } from "../context.js";
import { getUpdateConstraint } from "./update-constraint.js";

function createContext(chatId: number, command?: string): BotContext {
  return {
    chat: { id: chatId },
    message: command
      ? { entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }] }
      : { entities: [] },
    command: { name: command ?? "", args: [], original_msg: "" },
  } as unknown as BotContext;
}

describe("getUpdateConstraint", () => {
  test("keeps normal messages serialized only through their short ingress phase", () => {
    expect(getUpdateConstraint(createContext(42))).toBe("42");
    expect(getUpdateConstraint(createContext(7))).toBe("7");
  });

  test.each(["stop", "resume", "clear", "privacy", "md2tg", "unknown"])(
    "lets /%s bypass AI ingress serialization",
    (command) => {
      expect(getUpdateConstraint(createContext(42, command))).toBeUndefined();
    },
  );

  test.each(["apikey", "mcp", "model", "provider", "replymode", "richtext"])(
    "serializes /%s with other Bot configuration writes without joining the AI queue",
    (command) => {
      expect(getUpdateConstraint(createContext(42, command))).toBe("command:config");
    },
  );

  test.each(["backup", "draw", "summary"])(
    "serializes /%s in a per-chat operation lane",
    (command) => {
      expect(getUpdateConstraint(createContext(42, command))).toBe("command:operation:42");
      expect(getUpdateConstraint(createContext(7, command))).toBe("command:operation:7");
    },
  );

  test("normalizes commands addressed to a specific Bot username", () => {
    const ctx = createContext(42, "model@sample_bot");
    expect(getUpdateConstraint(ctx)).toBe("command:config");
  });
});
