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

  await expect
    .element(page.getByRole("heading", { name: "Your Telegram companion, explained." }))
    .toBeVisible();
  await expect.element(page.getByText("/help", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("navigation").getByText("Help")).toBeVisible();
  expect(page.getByRole("navigation").getByText("Groups").query()).toBeNull();
  expect(document.body.textContent).not.toContain("providers configured");
  expect(document.body.textContent).not.toContain("runtime status: ");
});

test("uses the explicit role navigation matrix", () => {
  expect(navigationForRole("admin")).toEqual(["groups", "settings", "access", "help"]);
  expect(navigationForRole("operator")).toEqual(["groups", "help"]);
  expect(navigationForRole("viewer")).toEqual(["groups", "help"]);
  expect(navigationForRole("none")).toEqual(["help"]);
});

test("renders the admin navigation returned by the Bot-scoped session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ok: true,
        user: { id: 42 },
        session: { expiresAt: 1_800_000_900, csrfToken: "csrf" },
        access: { role: "admin", capabilities: [], chatScope: { kind: "all" } },
      }),
    ),
  );
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/groups`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  for (const label of ["Groups", "Settings", "Access", "Help"]) {
    await expect.element(page.getByRole("navigation").getByText(label)).toBeVisible();
  }
  await expect.element(page.getByRole("heading", { name: "Groups are next" })).toBeVisible();
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
  await expect
    .element(page.getByRole("heading", { name: "Your Telegram companion, explained." }))
    .toBeVisible();
});
