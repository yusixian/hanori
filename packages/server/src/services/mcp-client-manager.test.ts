import { describe, expect, it } from "vitest";
import { isAdminOnlyMcpServer } from "./mcp-client-manager.js";

describe("isAdminOnlyMcpServer", () => {
  it.each([
    [null, "https://github.com/mcp"],
    [null, "https://api.github.com/mcp"],
    [null, "https://API.GITHUB.COM/mcp"],
    [null, "https://githubcopilot.com/mcp"],
    [null, "https://api.githubcopilot.com/mcp"],
    ["github", "https://example.com/mcp"],
    ["github", "not a url"],
  ])("keeps presetId %s at %s for admins", (presetId, url) => {
    expect(isAdminOnlyMcpServer({ presetId, url })).toBe(true);
  });

  it.each([
    [null, "https://github.com.evil.example/mcp"],
    [null, "https://evil-github.com/mcp"],
    [null, "https://notgithub.com/mcp"],
    [null, "not a url"],
    ["other", "https://example.com/mcp"],
  ])("offers presetId %s at %s to everyone", (presetId, url) => {
    expect(isAdminOnlyMcpServer({ presetId, url })).toBe(false);
  });
});
