import { describe, expect, it } from "vitest";
import { TELEGRAM_COMMAND_CATALOG, TELEGRAM_COMMAND_LOCALES } from "./telegram-command-catalog.js";

describe("TELEGRAM_COMMAND_CATALOG", () => {
  it("contains unique Telegram-compatible command names", () => {
    const commands = TELEGRAM_COMMAND_CATALOG.map(({ command }) => command);

    expect(new Set(commands).size).toBe(commands.length);
    for (const command of commands) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  it("has a non-empty, Telegram-compatible description for every locale", () => {
    for (const metadata of TELEGRAM_COMMAND_CATALOG) {
      expect(metadata.capability.trim()).not.toBe("");
      for (const locale of TELEGRAM_COMMAND_LOCALES) {
        const description = metadata.description[locale];
        expect(description.trim()).toBe(description);
        expect(description.length).toBeGreaterThan(0);
        expect(description.length).toBeLessThanOrEqual(256);
      }
    }
  });
});
