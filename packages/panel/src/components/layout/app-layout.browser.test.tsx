import { sidebarCollapsedAtom, sidebarOpenAtom } from "@/atoms/sidebar";
import { i18n } from "@/i18n";
import "@/style.css";
import { Provider, createStore } from "jotai";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AppLayout } from "./app-layout";

vi.mock("@refinedev/core", () => ({
  useLogout: () => ({ mutateAsync: vi.fn(), isLoading: false }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    getSession: vi.fn(async () => ({
      data: { user: { name: "Test Owner", email: "owner@example.com" } },
    })),
  },
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

async function renderLayout(path = "/bots/test-id", collapsed = false) {
  const store = createStore();
  store.set(sidebarCollapsedAtom, collapsed);
  store.set(sidebarOpenAtom, false);
  await render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="*" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
  return store;
}

beforeEach(async () => {
  await page.viewport(1024, 768);
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await page.viewport(1024, 768);
  vi.restoreAllMocks();
});

test("groups Bot pages and searches Bot and global destinations in English and Chinese", async () => {
  await renderLayout();

  for (const group of ["Frequent", "Content & memory", "Automation", "Management & diagnostics"]) {
    await expect.element(page.getByText(group, { exact: true })).toBeVisible();
  }

  const search = page.getByRole("searchbox", { name: "Search navigation" });
  await search.fill("summary");
  await expect.element(page.getByText("Chat Summaries", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Bot", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Clear search" }).click();
  await i18n.changeLanguage("zh-CN");
  const chineseSearch = page.getByRole("searchbox", { name: "搜索导航" });
  await chineseSearch.fill("用量");
  await expect.element(page.getByText("用量", { exact: true })).toBeVisible();
  await expect.element(page.getByText("全局", { exact: true })).toBeVisible();
});

test("opens global management from a Bot and navigates directly to a global route", async () => {
  await renderLayout("/bots/test-id/ai");

  await page.getByRole("button", { name: "Global management" }).click();
  await expect.element(page.getByText("Data & integrations", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Usage", exact: true }).click();
  await expect.element(page.getByTestId("location")).toHaveTextContent("/usage");
});

test("shows an empty search state that can restore the navigation", async () => {
  await renderLayout();

  await page.getByRole("searchbox", { name: "Search navigation" }).fill("no-such-page");
  await expect.element(page.getByText("No matching pages", { exact: true })).toBeVisible();
  await page.getByText("Clear search", { exact: true }).click();
  await expect.element(page.getByText("Frequent", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("searchbox", { name: "Search navigation" })).toHaveFocus();
});

test("marks only the most specific Bot route as current", async () => {
  await renderLayout("/bots/test-id/generations/original/42");

  const currentLinks = document.querySelectorAll('[aria-current="page"]');
  expect(currentLinks).toHaveLength(1);
  expect(currentLinks[0]?.textContent).toContain("Generations");
});

test("expands a collapsed desktop sidebar from its search shortcut and focuses search", async () => {
  await renderLayout("/bots/test-id", true);

  await page.getByRole("button", { name: "Search navigation" }).click();
  await expect.element(page.getByRole("searchbox", { name: "Search navigation" })).toHaveFocus();
  await expect.element(page.getByText("Frequent", { exact: true })).toBeVisible();
});

test("shows only an avatar in the collapsed desktop footer and expands account options on click", async () => {
  await renderLayout("/bots/test-id", true);

  const account = page.getByRole("button", { name: "Account menu" });
  await expect.element(account).toBeVisible();
  expect(account.element().querySelector("span")?.textContent).toBe("TO");
  await account.click();
  await expect.element(page.getByRole("group", { name: "Account options" })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  expect(document.querySelector<HTMLElement>('nav[aria-label="Primary navigation"]')?.inert).toBe(
    true,
  );
  await userEvent.tab({ shift: true });
  await expect.element(page.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(account).toHaveFocus();
  await userEvent.tab();
  await expect.element(page.getByRole("link", { name: "Settings", exact: true })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(account).toHaveFocus();
  expect(document.querySelector<HTMLElement>('nav[aria-label="Primary navigation"]')?.inert).toBe(
    false,
  );
  await expect
    .element(page.getByRole("group", { name: "Account options" }))
    .not.toBeInTheDocument();
});

test("keeps the mobile drawer labeled and modal despite a stored desktop collapse state", async () => {
  await page.viewport(390, 844);
  await renderLayout("/bots/test-id/ai", true);

  const menu = document.querySelector<HTMLElement>("#app-sidebar");
  expect(menu?.inert).toBe(true);
  await page.getByRole("button", { name: "Open menu" }).click();

  await expect.element(page.getByRole("dialog", { name: "Navigation menu" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Close menu" }).last()).toHaveFocus();
  await expect.element(page.getByText("Frequent", { exact: true })).toBeVisible();
  expect(menu?.inert).toBe(false);

  const account = page.getByRole("button", { name: "Account menu" });
  await userEvent.tab({ shift: true });
  await expect.element(account).toHaveFocus();
  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "Close menu" }).last()).toHaveFocus();

  await account.click();
  await expect.element(page.getByRole("group", { name: "Account options" })).toBeVisible();
  await userEvent.tab();
  await expect.element(page.getByRole("link", { name: "Settings", exact: true })).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(account).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(page.getByRole("button", { name: "Close menu" }).last()).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(page.getByRole("button", { name: "Log out" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "Close menu" }).last()).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.element(account).toHaveFocus();
  await expect
    .element(page.getByRole("group", { name: "Account options" }))
    .not.toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  expect(menu?.inert).toBe(true);
  await expect.element(page.getByRole("button", { name: "Open menu" })).toHaveFocus();
});

test("keeps the language picker usable in its portal while account options are open", async () => {
  await page.viewport(390, 844);
  await renderLayout();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("combobox", { name: "Language" }).click();
  await expect.element(page.getByRole("option", { name: "简体中文" })).toBeVisible();
  await page.getByRole("option", { name: "简体中文" }).click();
  await expect.element(page.getByRole("group", { name: "账户选项" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "账户菜单" })).toBeVisible();
});

test.each([
  ["en", "Account menu", "Account options", "Language"],
  ["zh-CN", "账户菜单", "账户选项", "界面语言"],
])(
  "closes the language picker, account options, and mobile drawer in order (%s)",
  async (locale, accountLabel, optionsLabel, languageLabel) => {
    await page.viewport(390, 844);
    await i18n.changeLanguage(locale);
    await renderLayout();

    await page.getByRole("button", { name: i18n.t("navigation.openMenu") }).click();
    const account = page.getByRole("button", { name: accountLabel });
    await account.click();
    const language = page.getByRole("combobox", { name: languageLabel });
    await language.click();
    await expect.element(page.getByRole("option", { name: "English" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("option", { name: "English" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("group", { name: optionsLabel })).toBeVisible();
    await expect.element(account).toHaveAttribute("aria-expanded", "true");
    await expect.element(language).toHaveFocus();

    language.element().blur();
    expect(document.activeElement).toBe(document.body);

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("group", { name: optionsLabel })).not.toBeInTheDocument();
    await expect.element(account).toHaveFocus();
    await expect.element(account).toHaveAttribute("aria-expanded", "false");

    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("button", { name: i18n.t("navigation.openMenu") }))
      .toHaveFocus();
    expect(document.querySelector<HTMLElement>("#app-sidebar")?.inert).toBe(true);
  },
);

test("closes the desktop language picker before account options even when focus falls to the page", async () => {
  await renderLayout();

  const account = page.getByRole("button", { name: "Account menu" });
  await account.click();
  const language = page.getByRole("combobox", { name: "Language" });
  await language.click();
  await expect.element(page.getByRole("option", { name: "English" })).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option", { name: "English" })).not.toBeInTheDocument();
  await expect.element(language).toHaveFocus();
  await expect.element(account).toHaveAttribute("aria-expanded", "true");

  language.element().blur();
  expect(document.activeElement).toBe(document.body);
  await userEvent.keyboard("{Escape}");
  await expect.element(account).toHaveFocus();
  await expect.element(account).toHaveAttribute("aria-expanded", "false");
});

test("closes the mobile drawer after navigation", async () => {
  await page.viewport(390, 844);
  await renderLayout("/bots/test-id/ai");

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "AI Settings" }).click();
  await expect.element(page.getByTestId("location")).toHaveTextContent("/bots/test-id/ai");
  expect(document.querySelector<HTMLElement>("#app-sidebar")?.inert).toBe(true);
  await expect.element(page.getByRole("button", { name: "Open menu" })).toHaveFocus();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Back to Bots" }).click();
  await expect.element(page.getByTestId("location")).toHaveTextContent("/");
  expect(document.querySelector<HTMLElement>("#app-sidebar")?.inert).toBe(true);
  await expect.element(page.getByRole("button", { name: "Open menu" })).toHaveFocus();
});

test("resets account options when the mobile drawer closes", async () => {
  await page.viewport(390, 844);
  await renderLayout();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect.element(page.getByRole("group", { name: "Account options" })).toBeVisible();
  await page.getByRole("button", { name: "Close menu" }).last().click();
  await expect.element(page.getByRole("button", { name: "Open menu" })).toHaveFocus();
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect
    .element(page.getByRole("group", { name: "Account options" }))
    .not.toBeInTheDocument();
});
