import { i18n } from "@/i18n";
import "@/style.css";
import { StrictMode } from "react";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "@/pages/bots/ai-settings/types";

const authState = vi.hoisted(() => ({
  authenticated: false,
  failNextSignOut: false,
  signOutCalls: 0,
  getSessionCalls: 0,
  delayNextSessionCheck: false,
  releaseSessionCheck: null as (() => void) | null,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    getSession: async () => {
      authState.getSessionCalls += 1;
      if (authState.delayNextSessionCheck) {
        authState.delayNextSessionCheck = false;
        await new Promise<void>((resolve) => {
          authState.releaseSessionCheck = resolve;
        });
      }
      return authState.authenticated
        ? { data: { user: { id: "user-1", email: "owner@example.com" } } }
        : { data: null };
    },
    signIn: {
      email: async () => {
        authState.authenticated = true;
        return { data: { user: { id: "user-1", email: "owner@example.com" } } };
      },
      social: vi.fn(),
    },
    signUp: { email: vi.fn() },
    signOut: async () => {
      authState.signOutCalls += 1;
      if (authState.failNextSignOut) {
        authState.failNextSignOut = false;
        return {
          data: null,
          error: {
            status: 500,
            statusText: "Internal Server Error",
            message: "Temporary logout failure",
          },
        };
      }
      authState.authenticated = false;
      return { data: null };
    },
  },
}));

const BOT = {
  id: "test-id",
  name: "Test Bot",
  platform: "telegram",
  tokenMasked: "1234…abcd",
  adminChatIds: [],
  isActive: true,
  miniAppEnabled: false,
  status: "stopped",
  uptime: null,
  aiEnabled: true,
};

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

async function clickLogout() {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
}

beforeEach(async () => {
  authState.authenticated = false;
  authState.failNextSignOut = false;
  authState.signOutCalls = 0;
  authState.getSessionCalls = 0;
  authState.delayNextSessionCheck = false;
  authState.releaseSessionCheck = null;
  await i18n.changeLanguage("en");
  window.history.replaceState({}, "", "/login?returnTo=%2Fbots%2Ftest-id");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/api/authz/me")) {
        return Response.json({ data: { member: { role: "owner" } } });
      }
      if (url.includes("/api/bots/test-id/ai-config")) {
        return Response.json({ ok: true, data: DEFAULT_CONFIG, revision: "revision-1" });
      }
      if (url.includes("/api/bots/test-id/ai-selection")) {
        return Response.json({ ok: false }, { status: 404 });
      }
      if (/\/api\/bots\/test-id(?:\?|$)/.test(url)) {
        return Response.json({ ok: true, data: BOT });
      }
      if (url.includes("/api/bots?")) {
        return Response.json({ ok: true, data: [BOT], total: 1 });
      }
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
});

afterEach(() => {
  authState.releaseSessionCheck?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("keeps auth, admin drafts, history blocking, and Mini App routing under StrictMode", async () => {
  await page.viewport(390, 844);
  const { App } = await import("./App");
  const rendered = await render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  await expect.element(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill("owner@example.com");
  await page.getByLabelText("Password").fill("password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect.element(page.getByRole("heading", { name: "Test Bot" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "AI Settings", exact: true })
    .click();
  await expect.element(page.getByRole("heading", { name: "AI Settings" })).toBeVisible();

  const enableAi = page.getByRole("switch", { name: "Enable AI Replies" });
  await enableAi.click();

  await page.getByRole("button", { name: "Open menu" }).click();
  await clickLogout();
  const leaveDialog = page.getByRole("alertdialog", { name: "Leave with unsaved changes?" });
  await expect.element(leaveDialog).toBeVisible();
  expect(authState.signOutCalls).toBe(0);
  await page.getByRole("button", { name: "Stay and keep editing" }).click();
  await expect.element(enableAi).toBeChecked();
  await expect.element(page.getByRole("button", { name: "Open menu" })).toHaveFocus();

  authState.failNextSignOut = true;
  authState.delayNextSessionCheck = true;
  const sessionChecksBeforeFailedLogout = authState.getSessionCalls;
  await page.getByRole("button", { name: "Open menu" }).click();
  await clickLogout();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await expect.element(leaveDialog).toBeVisible();
  expect(authState.signOutCalls).toBe(1);
  expect(authState.getSessionCalls).toBe(sessionChecksBeforeFailedLogout);
  expect(authState.authenticated).toBe(true);
  await expect.element(enableAi).toBeChecked();
  const stayAfterFailedLogout = page.getByRole("button", { name: "Stay and keep editing" });
  await expect.element(stayAfterFailedLogout).toBeEnabled();
  authState.delayNextSessionCheck = false;
  authState.releaseSessionCheck?.();
  authState.releaseSessionCheck = null;
  await stayAfterFailedLogout.click();
  await expect.element(page.getByRole("button", { name: "Open menu" })).toHaveFocus();
  const errorToast = page.getByText("Operation failed", { exact: true });
  await expect.element(errorToast).toBeVisible();
  const closeToast = errorToast.element().closest("[data-sonner-toast]")?.querySelector("button");
  expect(closeToast).toBeInstanceOf(HTMLButtonElement);
  (closeToast as HTMLButtonElement).click();

  window.history.back();
  await expect.element(leaveDialog).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Stay and keep editing" })).toHaveFocus();
  await page.getByRole("button", { name: "Stay and keep editing" }).click();
  await expect.element(enableAi).toBeChecked();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Back to Bots" }).click();
  await expect.element(leaveDialog).toBeVisible();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await vi.waitFor(() => expect(window.location.pathname).toBe("/"));
  await expect.element(page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();

  await page.getByRole("link", { name: /Test Bot/ }).click();
  await expect.element(page.getByRole("heading", { name: "Test Bot" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "AI Settings", exact: true })
    .click();
  await expect.element(page.getByRole("heading", { name: "AI Settings" })).toBeVisible();
  await page.getByRole("switch", { name: "Enable AI Replies" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await clickLogout();
  await expect.element(leaveDialog).toBeVisible();
  await page.getByRole("button", { name: "Leave without saving" }).click();
  await expect.element(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(authState.signOutCalls).toBe(2);

  await page.getByRole("textbox", { name: "Email" }).fill("owner@example.com");
  await page.getByLabelText("Password").fill("password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect.element(page.getByRole("heading", { name: "Test Bot" })).toBeVisible();
  await page.getByRole("link", { name: /Test Bot/ }).click();
  await expect.element(page.getByRole("heading", { name: "Test Bot" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "AI Settings", exact: true })
    .click();
  await expect.element(page.getByRole("heading", { name: "AI Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await clickLogout();
  await expect.element(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(authState.signOutCalls).toBe(3);

  window.history.pushState({}, "", "/mini-app/test-id/help");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await expect.element(page.getByRole("heading", { name: "Commands", exact: true })).toBeVisible();

  rendered.unmount();
});
