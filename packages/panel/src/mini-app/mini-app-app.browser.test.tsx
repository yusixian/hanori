import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { MiniAppApp, navigationForRole } from "./mini-app-app";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("renders public Help without Telegram SDK or a working session API", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );

  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/help`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("heading", { name: "Commands", exact: true })).toBeVisible();
  await expect.element(page.getByText("/help", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Privacy boundary" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect.element(page.getByRole("navigation").getByText("Help")).toBeVisible();
  expect(page.getByRole("navigation").getByText("Groups").query()).toBeNull();
  expect(document.querySelector(".mini-app-header")).toBeNull();
  expect(page.getByText("Telegram control deck", { exact: true }).query()).toBeNull();
  expect(page.getByText("Hanori", { exact: true }).query()).toBeNull();
  expect(document.querySelector(".mini-app-hero")).toBeNull();
  expect(document.querySelector(".mini-app-command-section")).not.toBeNull();
  expect(document.body.textContent).not.toContain("providers configured");
  expect(document.body.textContent).not.toContain("runtime status: ");
  expect(document.body.textContent).not.toMatch(/羽衣|Hagoromo|HGRM/);
});

test("switches language from the Help heading without a custom app header", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );

  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/help`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  const languageButton = page.getByRole("button", { name: "Language" });
  await expect.element(languageButton).toBeVisible();
  await languageButton.click();
  await expect.element(page.getByRole("heading", { name: "命令", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "语言" })).toBeVisible();
});

test("uses the explicit role navigation matrix", () => {
  expect(navigationForRole("admin")).toEqual(["groups", "settings", "access", "logs", "help"]);
  expect(navigationForRole("operator")).toEqual(["groups", "help"]);
  expect(navigationForRole("viewer")).toEqual(["groups", "help"]);
  expect(navigationForRole("none")).toEqual(["help"]);
});

test("renders the admin navigation returned by the Bot-scoped session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (String(input).endsWith("/groups")) {
        return Response.json({ ok: true, editable: true, groups: [] });
      }
      return Response.json({
        ok: true,
        user: { id: 42 },
        session: { expiresAt: 1_800_000_900, csrfToken: "csrf" },
        access: { role: "admin", capabilities: [], chatScope: { kind: "all" } },
      });
    }),
  );
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/groups`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  for (const label of ["Groups", "Settings", "Access", "Logs", "Help"]) {
    await expect.element(page.getByRole("navigation").getByText(label)).toBeVisible();
  }
  await expect.element(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
});

test("keeps Logs unmounted for a non-admin session", async () => {
  const fetcher = vi.fn(async (input) => {
    if (String(input).endsWith("/groups")) {
      return Response.json({ ok: true, editable: true, groups: [] });
    }
    return Response.json({
      ok: true,
      user: { id: 42 },
      session: { expiresAt: 1_800_000_900, csrfToken: "csrf" },
      access: { role: "operator", capabilities: [], chatScope: { kind: "all" } },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/logs`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  expect(page.getByRole("navigation").getByText("Logs").query()).toBeNull();
  expect(fetcher.mock.calls.some(([input]) => String(input).includes("/logs"))).toBe(false);
});

test("keeps Access unmounted for a non-admin session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (String(input).endsWith("/groups")) {
        return Response.json({ ok: true, editable: true, groups: [] });
      }
      return Response.json({
        ok: true,
        user: { id: 42 },
        session: { expiresAt: 1_800_000_900, csrfToken: "csrf" },
        access: { role: "operator", capabilities: [], chatScope: { kind: "all" } },
      });
    }),
  );
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/access`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  expect(page.getByRole("heading", { name: "Access control" }).query()).toBeNull();
  expect(page.getByRole("navigation").getByText("Access").query()).toBeNull();
});

test("shows an expired state for 401", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/groups`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );
  await expect.element(page.getByRole("heading", { name: "Session expired" })).toBeVisible();
});

test("returns a 403 session to public Help", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/groups`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );
  await expect.element(page.getByRole("heading", { name: "Commands", exact: true })).toBeVisible();
});
