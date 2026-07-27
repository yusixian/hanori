import { describe, expect, it } from "vitest";
import {
  getMiniAppCapabilities,
  hasMiniAppCapability,
  MINI_APP_CAPABILITIES,
  MINI_APP_ROLE_CAPABILITIES,
} from "./mini-app-access.js";

describe("Mini App capabilities", () => {
  it("maps capabilities according to the role hierarchy", () => {
    expect(hasMiniAppCapability("admin", "bot.lifecycle.manage")).toBe(true);
    expect(hasMiniAppCapability("operator", "group.config.write")).toBe(true);
    expect(hasMiniAppCapability("operator", "bot.settings.read")).toBe(false);
    expect(hasMiniAppCapability("operator", "chat.ai-selection.write")).toBe(false);
    expect(hasMiniAppCapability("viewer", "group.config.read")).toBe(true);
    expect(hasMiniAppCapability("viewer", "group.config.write")).toBe(false);
    expect(getMiniAppCapabilities("none")).toEqual([]);
  });

  it("denies unknown and reserved capabilities by default", () => {
    expect(hasMiniAppCapability("admin", "unknown.manage")).toBe(false);
    expect(hasMiniAppCapability("admin", "credentials.manage")).toBe(false);
    expect(hasMiniAppCapability("admin", "data.export")).toBe(false);
    expect(hasMiniAppCapability("admin", "data.delete")).toBe(false);

    const mapped = new Set<string>(Object.values(MINI_APP_ROLE_CAPABILITIES).flat());
    expect(MINI_APP_CAPABILITIES.filter((capability) => mapped.has(capability))).not.toContain(
      "credentials.manage",
    );
  });
});
