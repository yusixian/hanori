import { AUTH_STATE_PATH, expect, test } from "../fixtures";

test.use({ storageState: AUTH_STATE_PATH });

const PAGES = [
  {
    id: "admin-bots-list",
    path: "/",
    feature: "Bots",
    severity: "P0",
    expected: ["Bot list shows the seeded Acceptance Bot", "App shell with navigation is visible"],
  },
  {
    id: "admin-bot-create",
    path: "/bots/new",
    feature: "Bots",
    severity: "P1",
    expected: ["Create-bot form renders with token input"],
  },
  {
    id: "admin-logs",
    path: "/logs",
    feature: "Logs",
    severity: "P1",
    expected: ["Logs page renders (list or empty state)"],
  },
  {
    id: "admin-usage",
    path: "/usage",
    feature: "Usage",
    severity: "P1",
    expected: ["Usage page renders (charts or empty state)"],
  },
  {
    id: "admin-timers",
    path: "/timers",
    feature: "Timers",
    severity: "P1",
    expected: ["Timers page renders (list or empty state)"],
  },
  {
    id: "admin-mcp-servers",
    path: "/mcp-servers",
    feature: "MCP servers",
    severity: "P1",
    expected: ["MCP servers page renders"],
  },
  {
    id: "admin-settings",
    path: "/settings",
    feature: "Settings",
    severity: "P1",
    expected: ["Settings page renders"],
  },
  {
    id: "admin-backup",
    path: "/backup",
    feature: "Backup",
    severity: "P1",
    expected: ["Backup page renders"],
  },
  {
    id: "admin-data",
    path: "/data",
    feature: "Data",
    severity: "P2",
    expected: ["Data page renders"],
  },
  {
    id: "admin-api-test",
    path: "/api-test",
    feature: "API test",
    severity: "P2",
    expected: ["API test page renders"],
  },
  {
    id: "admin-guide-lark",
    path: "/guides/lark-setup",
    feature: "Guides",
    severity: "P2",
    expected: ["Lark setup guide renders"],
  },
] as const;

test.describe("admin pages", () => {
  for (const p of PAGES) {
    test(`${p.id}`, async ({ page, acceptance }) => {
      acceptance.meta({
        id: p.id,
        feature: p.feature,
        severity: p.severity,
        steps: [`Log in`, `Open ${p.path}`],
        expected: [...p.expected, "No horizontal overflow", "No runtime errors"],
      });
      const response = await page.goto(p.path);
      expect(response?.status(), `navigation to ${p.path}`).toBeLessThan(400);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("main").first()).toBeVisible();
      await acceptance.checkpoint(p.id);
    });
  }
});
