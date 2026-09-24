import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { MiniAppApp, navigationForRole, readStartPage } from "./mini-app-app";

const BOT_ID = "00000000-0000-4000-8000-000000000001";
const SESSION = {
  ok: true,
  user: { id: 42 },
  session: { expiresAt: 1_800_000_900, csrfToken: "csrf" },
  access: { role: "admin", capabilities: [], chatScope: { kind: "all" } },
};
const OVERVIEW = {
  ok: true,
  enabled: true,
  configError: null,
  chatId: -100,
  projects: [],
  machines: [{ key: "mbp", lodyName: "mbp", online: true }],
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(harness: () => Response) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/harness/")) return harness();
    if (url.endsWith("/groups")) return Response.json({ ok: true, editable: true, groups: [] });
    return Response.json(SESSION);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

test("adds Harness before Help only when enabled", () => {
  expect(navigationForRole("admin", true)).toEqual([
    "groups",
    "settings",
    "access",
    "logs",
    "harness",
    "help",
  ]);
  expect(navigationForRole("viewer", true)).toEqual(["groups", "harness", "help"]);
  expect(navigationForRole("none", true)).toEqual(["help"]);
});

test("maps Telegram start_param to a Mini App page", () => {
  expect(readStartPage("query_id=1&start_param=harness", "")).toBe("harness");
  expect(readStartPage("", "?tgWebAppStartParam=harness")).toBe("harness");
  expect(readStartPage("start_param=unknown", "")).toBeNull();
});

test("shows the Harness page and nav item when the overview succeeds", async () => {
  const fetcher = stubFetch(() => Response.json(OVERVIEW));
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/harness`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await expect.element(page.getByRole("navigation").getByText("Harness")).toBeVisible();
  expect(
    fetcher.mock.calls.some(([input]) =>
      String(input).endsWith(`/api/mini-app/${BOT_ID}/harness/overview`),
    ),
  ).toBe(true);
});

test("hides the nav item when the Bot is not the harness Bot", async () => {
  const fetcher = stubFetch(() =>
    Response.json({ ok: false, error: "Not found" }, { status: 404 }),
  );
  render(
    <MemoryRouter initialEntries={[`/mini-app/${BOT_ID}/groups`]}>
      <MiniAppApp />
    </MemoryRouter>,
  );

  await expect.element(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  await vi.waitFor(() =>
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/harness/"))).toBe(true),
  );
  await expect.element(page.getByRole("navigation").getByText("Help")).toBeVisible();
  expect(page.getByRole("navigation").getByText("Harness").query()).toBeNull();
});
