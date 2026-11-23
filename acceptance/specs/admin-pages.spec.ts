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

  test("admin-api-test-full-url", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "admin-api-test-full-url",
      feature: "API test full URL",
      severity: "P1",
      steps: [
        "Open API Test",
        "Leave Base URL and API key empty",
        "Enter a complete localhost URL and send",
      ],
      expected: [
        "The full URL can be sent without a Base URL or API key",
        "The response is rendered",
        "The layout has no horizontal overflow",
      ],
    });
    await page.route("**/api/api-test/proxy", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      expect(payload).toMatchObject({
        baseURL: "",
        apiKey: "",
        endpoint: "http://localhost:11434/api/tags",
        method: "GET",
      });
      await route.fulfill({ status: 200, json: { ok: true, status: 200, data: { models: [] } } });
    });

    await page.goto("/api-test");
    await page.getByLabel("Base URL").fill("");
    await page.getByLabel("API Key (optional)").fill("");
    await page.getByLabel("Endpoint or full URL").fill("http://localhost:11434/api/tags");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("treeitem", { name: /models:\[\]/ })).toBeVisible();
    await acceptance.checkpoint("api-test-full-url-response");
  });
});
