import { AUTH_STATE_PATH, expect, test } from "../fixtures";

test.describe("language switching (public)", () => {
  test("login page language switcher toggles zh-CN", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "i18n-login-switch",
      feature: "i18n",
      severity: "P2",
      steps: ["Open /login", "Switch language to 简体中文"],
      expected: ["Login copy switches to Chinese", "Layout stays intact"],
    });
    await page.goto("/login");
    const switcher = page.getByRole("combobox").first();
    await expect(switcher).toBeVisible();
    const before = await page.locator("body").innerText();
    await switcher.click();
    await page.getByRole("option", { name: /简体|中文|Chinese/i }).click();
    await page.waitForTimeout(500);
    const after = await page.locator("body").innerText();
    expect(after).not.toBe(before);
    await acceptance.checkpoint("login-switched-language");
  });
});

test.describe("language switching (authenticated)", () => {
  test.use({ storageState: AUTH_STATE_PATH });

  test("authenticated shell renders in zh-CN", async ({ page, acceptance }, testInfo) => {
    acceptance.meta({
      id: "i18n-shell-zh",
      feature: "i18n",
      severity: "P2",
      steps: ["Log in", "Switch language to 简体中文 on the bot list"],
      expected: ["Navigation and page copy switch to Chinese", "Layout stays intact"],
    });
    await page.goto("/");
    await expect(page.locator("aside")).toBeVisible();
    if (testInfo.project.name === "mobile") {
      // The sidebar is a drawer behind the hamburger button on mobile.
      await page.locator("header button").first().click();
    }
    const switcher = page.locator("aside").getByRole("combobox").first();
    await expect(switcher).toBeVisible();
    await switcher.click();
    await page.getByRole("option", { name: /简体|中文|Chinese/i }).click();
    await page.waitForTimeout(500);
    await acceptance.checkpoint("shell-zh");
  });
});
