import { describe, expect, test, vi } from "vitest";
import type { BotContext } from "../context.js";
import { getUpdateConstraint } from "./update-constraint.js";

function createContext(chatId: number, command?: string): BotContext {
  return {
    chat: { id: chatId },
    hasCommand: vi.fn((trigger: string | string[]) =>
      Array.isArray(trigger) ? trigger.includes(command ?? "") : trigger === command,
    ),
  } as unknown as BotContext;
}

describe("getUpdateConstraint", () => {
  test("serializes all apikey updates without joining the normal chat queues", () => {
    expect(getUpdateConstraint(createContext(42, "apikey"))).toBe("apikey");
    expect(getUpdateConstraint(createContext(42, "apikey"))).toBe("apikey");
    expect(getUpdateConstraint(createContext(42))).toBe("42");
    expect(getUpdateConstraint(createContext(7, "apikey"))).toBe("apikey");
  });

  test.each(["stop", "resume"])("lets /%s bypass chat serialization", (command) => {
    expect(getUpdateConstraint(createContext(42, command))).toBeUndefined();
  });
});
