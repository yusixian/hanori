import { expect, test } from "../fixtures";

const OWNER_EMAIL = process.env.ACCEPTANCE_OWNER_EMAIL ?? "owner@acceptance.test";
const OWNER_PASSWORD = process.env.ACCEPTANCE_OWNER_PASSWORD ?? "acceptance-password-123";

test.describe("public auth pages", () => {
  test("login page renders", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "auth-login-page",
      feature: "Login",
      severity: "P0",
      steps: ["Open /login"],
      expected: [
        "Login card with email and password fields is visible",
        "Submit and Google sign-in buttons are present",
        "No horizontal overflow",
      ],
    });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in|log in|登录/i }).first()).toBeVisible();
    await acceptance.checkpoint("login-page");
  });

  test("login with invalid credentials shows an error", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "auth-login-invalid",
      feature: "Login",
      severity: "P1",
      steps: ["Open /login", "Submit a wrong password"],
      expected: ["An error message is shown", "User stays on /login"],
      // The wrong password deliberately triggers a 401 from sign-in.
      allowHttpStatuses: [401],
    });
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(OWNER_EMAIL);
    await page.locator('input[type="password"]').fill("definitely-wrong-password");
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await acceptance.checkpoint("login-invalid");
  });

  test("login with valid credentials lands on the bot list", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "auth-login-success",
      feature: "Login",
      severity: "P0",
      steps: ["Open /login", "Submit the acceptance owner credentials"],
      expected: ["Redirect to / (bot list)", "Authenticated app shell is visible"],
    });
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(OWNER_EMAIL);
    await page.locator('input[type="password"]').fill(OWNER_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByText("Acceptance Bot").first()).toBeVisible({ timeout: 15_000 });
    await acceptance.checkpoint("login-success-bot-list");
  });

  test("accept-invitation and reset-password pages render", async ({ page, acceptance }) => {
    acceptance.meta({
      id: "auth-public-pages",
      feature: "Auth",
      severity: "P2",
      steps: ["Open /accept-invitation", "Open /reset-password"],
      expected: ["Both public pages render their forms without runtime errors"],
    });
    await page.goto("/accept-invitation");
    // Without an invitation id the page must show its explicit error state.
    await expect(page.locator("body")).toContainText(/invitation|邀请/i);
    await acceptance.checkpoint("accept-invitation");
    await page.goto("/reset-password");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await acceptance.checkpoint("reset-password");
  });
});
