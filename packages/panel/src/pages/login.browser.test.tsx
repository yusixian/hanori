import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";

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
