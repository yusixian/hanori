import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";

const authMocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
  signOut: vi.fn(),
  authFetch: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: authMocks.signInEmail, social: authMocks.signInSocial },
    signOut: authMocks.signOut,
  },
}));

vi.mock("@/lib/client", () => ({ authFetch: authMocks.authFetch }));

import { LoginPage } from "./login";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  authMocks.signInEmail.mockResolvedValue({ data: {}, error: null });
  authMocks.authFetch.mockRejectedValue(new Error("network unavailable"));
});

afterEach(() => {
  vi.clearAllMocks();
});

test("recovers and shows an error when the post-login membership request fails", async () => {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );

  await page.getByLabelText("Email").fill("owner@example.com");
  await page.getByLabelText("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Sign-in failed");
  await expect.element(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("returns to the requested generation detail after login", async () => {
  authMocks.authFetch.mockReset().mockResolvedValue({ ok: true });
  render(
    <MemoryRouter
      initialEntries={["/login?returnTo=%2Fbots%2Fbot-a%2Fgenerations%2Funified%2Fgeneration-a"]}
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/bots/:botId/generations/:source/:generationId"
          element={<div>Generation detail restored</div>}
        />
      </Routes>
    </MemoryRouter>,
  );

  await page.getByLabelText("Email").fill("owner@example.com");
  await page.getByLabelText("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect.element(page.getByText("Generation detail restored")).toBeVisible();
});

test("exposes public documentation links before authentication", async () => {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );

  await expect
    .element(page.getByRole("link", { name: "Documentation" }))
    .toHaveAttribute("href", "/docs/");
  await expect
    .element(page.getByRole("link", { name: "Changelog" }))
    .toHaveAttribute("href", "/docs/changelog/");
});

test("switches the companion copy without losing credentials on a narrow screen", async () => {
  await page.viewport(320, 844);
  try {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await page.getByLabelText("Email").fill("owner@example.test");
    await page.getByLabelText("Password").fill("synthetic-password");
    await page.getByRole("combobox", { name: "Language" }).click();
    await page.getByRole("option", { name: "简体中文", exact: true }).click();
    await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("聊聊日常");
    await expect.element(page.getByLabelText("邮箱")).toHaveValue("owner@example.test");
    await expect.element(page.getByLabelText("密码")).toHaveValue("synthetic-password");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } finally {
    await page.viewport(1024, 768);
  }
});
