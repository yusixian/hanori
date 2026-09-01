import { AUTH_STATE_PATH, expect, test } from "../fixtures";

test.use({ storageState: AUTH_STATE_PATH });

test.describe("app shell navigation", () => {
  test("sidebar links navigate to every global page", async ({ page, acceptance }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "covered by shell-mobile-drawer on mobile");
    acceptance.meta({
      id: "shell-nav-links",
      feature: "App shell",
      severity: "P0",
      steps: ["Log in", "Click each sidebar navigation link"],
      expected: [
        "Every link navigates to its route",
        "The active link is visually highlighted",
        "Content renders for each route",
      ],
    });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const targets = ["/usage", "/data", "/backup", "/timers", "/mcp-servers", "/api-test", "/logs"];
    for (const path of targets) {
      await page.locator(`aside a[href="${path}"]`).first().click();
      await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
      await expect(page.locator("main").first()).toBeVisible();
    }
    await acceptance.checkpoint("shell-nav-logs-active");
  });

  test("mobile drawer opens, navigates, and closes", async ({ page, acceptance }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile-only case");
    acceptance.meta({
      id: "shell-mobile-drawer",
      feature: "App shell",
      severity: "P0",
      steps: ["Open the hamburger menu", "Tap Logs", "Observe the drawer"],
      expected: [
        "Drawer opens with backdrop",
        "Navigation works from the drawer",
        "Drawer closes after navigation",
      ],
    });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.locator("header button").first().click();
    const aside = page.locator("aside");
    await expect(aside).toBeVisible();
    await acceptance.checkpoint("mobile-drawer-open");
    await aside.locator('a[href="/logs"]').first().click();
    await expect(page).toHaveURL(/\/logs$/);
    await expect(aside).toHaveClass(/-translate-x-full/);
    await acceptance.checkpoint("mobile-after-nav");
  });
});
