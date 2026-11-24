import { i18n } from "@/i18n";
import "@/style.css";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { Provider } from "jotai";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { OnboardingChecklist } from "./onboarding-checklist";

const { useList, usePanelRole } = vi.hoisted(() => ({ useList: vi.fn(), usePanelRole: vi.fn() }));
vi.mock("@refinedev/core", () => ({ useList }));
vi.mock("@/hooks/use-can-manage-bot", () => ({ usePanelRole }));

function bot(id: string, values: Partial<BotWithStatus> = {}): BotWithStatus {
  return {
    id,
    name: id,
    platform: "telegram",
    tokenMasked: "",
    adminChatIds: [],
    isActive: false,
    miniAppEnabled: false,
    aiEnabled: false,
    aiHasApiKey: false,
    status: "stopped",
    uptime: null,
    createdAt: "",
    updatedAt: null,
    ...values,
  };
}

function mount(bots: BotWithStatus[] = [], total = bots.length) {
  return render(
    <Provider>
      <MemoryRouter>
        <OnboardingChecklist firstPage={{ data: bots, total }} pageSize={1} />
      </MemoryRouter>
    </Provider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  usePanelRole.mockReturnValue("owner");
  localStorage.removeItem("hanori.onboarding.dismissed");
  localStorage.removeItem("hanori.onboarding.security");
  await page.viewport(1440, 900);
});

test("shows the empty deployment and its entry points on mobile", async () => {
  await page.viewport(390, 844);
  await mount();
  await expect
    .element(page.getByRole("button", { name: /0\/3 complete/ }))
    .toHaveAttribute("aria-expanded", "true");
  await expect
    .element(page.getByRole("link", { name: "Open settings" }))
    .toHaveAttribute("href", "/settings#account-security");
  await expect
    .element(page.getByRole("link", { name: "Create a bot to configure its provider" }))
    .toHaveAttribute("href", "/bots/new");
  await expect
    .element(page.getByRole("link", { name: "Create bot" }))
    .toHaveAttribute("href", "/bots/new");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

test("detects enabled bots independently of provider credentials and links to provider settings", async () => {
  await mount([bot("one", { isActive: true, aiEnabled: true })]);
  await expect.element(page.getByRole("button", { name: /1\/3 complete/ })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Open provider settings" }))
    .toHaveAttribute("href", "/bots/one/ai?section=providers");
});

test("checks later pages and remembers manual confirmation on remount", async () => {
  useList.mockReturnValue({
    data: { data: [bot("two", { aiHasApiKey: true, status: "running" })], total: 2 },
  });
  const screen = await mount([bot("one")], 2);
  await expect.element(page.getByRole("button", { name: /2\/3 complete/ })).toBeVisible();
  await page.getByRole("checkbox").click();
  await expect
    .element(page.getByRole("button", { name: /3\/3 complete/ }))
    .toHaveAttribute("aria-expanded", "false");
  await screen.unmount();
  await mount();
  await expect.element(page.getByRole("checkbox")).toBeChecked();
  await page.getByRole("checkbox").click();
  await expect.element(page.getByRole("button", { name: /0\/3 complete/ })).toBeVisible();
});

test("can dismiss the collapsed checklist and keeps it hidden on remount", async () => {
  const screen = await mount();
  await page.getByRole("button", { name: /First deployment/ }).click();
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Dismiss checklist" }).click();
  await expect.element(page.getByRole("region")).not.toBeInTheDocument();
  await screen.unmount();
  await mount();
  await expect.element(page.getByRole("region")).not.toBeInTheDocument();
});

test("only shows deployment tasks to the owner", async () => {
  usePanelRole.mockReturnValue("viewer");
  await mount();
  await expect.element(page.getByRole("region")).not.toBeInTheDocument();
});
