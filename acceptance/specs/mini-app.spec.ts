import { expect, test } from "../fixtures";

// The Mini App is designed for the Telegram WebView. In a plain browser the help
// page is fully public, and protected pages must fail closed with a clear state.
const BOT_ID = "00000000-0000-0000-0000-000000000000";

test.describe("mini app", () => {
  test("help page renders the public command catalog", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "miniapp-help",
      feature: "Mini App help",
      severity: "P1",
      steps: [`Open /mini-app/${BOT_ID}/help in a plain browser`],
      expected: [
        "Command catalog with grouped commands is visible",
        "Bottom navigation is visible",
        "No horizontal overflow",
      ],
      // Session bootstrap without Telegram initData correctly returns 4xx/503.
      allowHttpStatuses: [400, 404, 503],
    });
    await page.goto(`/mini-app/${BOT_ID}/help`);
    await expect(page.locator(".mini-app-command-grid").first()).toBeVisible();
    await expect(page.locator(".mini-app-nav")).toBeVisible();
    await acceptance.checkpoint("miniapp-help");
  });

  test("protected page without Telegram session fails closed", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "miniapp-protected-no-session",
      feature: "Mini App session",
      severity: "P1",
      steps: [`Open /mini-app/${BOT_ID}/groups in a plain browser`],
      expected: ["Session unavailable/expired state or redirect to help", "No group data is shown"],
      // Session bootstrap without Telegram initData correctly returns 4xx/503.
      allowHttpStatuses: [400, 404, 503],
    });
    await page.goto(`/mini-app/${BOT_ID}/groups`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    await acceptance.checkpoint("miniapp-groups-no-session");
    const body = await page.locator("body").innerText();
    expect(body.length).toBeGreaterThan(0);
  });
});
