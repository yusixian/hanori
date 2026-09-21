import { i18n } from "@/i18n";
import "@/style.css";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { BotDashboardPage } from "./dashboard";

const mocks = vi.hoisted(() => ({
  useOne: vi.fn(),
  invalidate: vi.fn(),
  deleteBot: vi.fn(),
  refetch: vi.fn(async () => undefined),
}));

vi.mock("@refinedev/core", () => ({
  useOne: mocks.useOne,
  useInvalidate: () => mocks.invalidate,
  useDelete: () => ({ mutateAsync: mocks.deleteBot }),
}));

const TELEGRAM_BOT: BotWithStatus = {
  id: "telegram-bot",
  name: "Telegram Bot",
  platform: "telegram",
  tokenMasked: "1234…abcd",
  adminChatIds: [],
  isActive: true,
  miniAppEnabled: false,
  status: "running",
  uptime: 300,
  aiEnabled: true,
  aiHasApiKey: true,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: null,
};

const LARK_BOT: BotWithStatus = {
  ...TELEGRAM_BOT,
  id: "lark-bot",
  name: "Lark Bot",
  platform: "lark-webhook",
  aiEnabled: false,
};

async function renderDashboard(botId = "telegram-bot") {
  return render(
    <MemoryRouter initialEntries={[`/bots/${botId}`]}>
      <Routes>
        <Route path="/bots/:botId" element={<BotDashboardPage />} />
        <Route path="*" element={<p>Destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.useOne.mockReset();
  mocks.invalidate.mockReset();
  mocks.deleteBot.mockReset();
  mocks.refetch.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("shows a retryable detail error instead of reporting the Bot as missing", async () => {
  mocks.useOne.mockReturnValue({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: true,
    refetch: mocks.refetch,
  });
  await renderDashboard();

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Bot details could not be loaded");
  await expect.element(page.getByText("Bot not found")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Retry" }).click();
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

test("keeps the last Bot details visible after a background refresh failure", async () => {
  mocks.useOne.mockReturnValue({
    data: { data: TELEGRAM_BOT },
    isLoading: false,
    isFetching: false,
    isError: true,
    refetch: mocks.refetch,
  });
  await renderDashboard();

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Refresh failed. Showing the most recently loaded bot details.");
  await expect.element(page.getByRole("heading", { name: "Telegram Bot" })).toBeVisible();
});

test("provides keyboard-ordered Telegram destinations", async () => {
  mocks.useOne.mockReturnValue({
    data: { data: TELEGRAM_BOT },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mocks.refetch,
  });
  await renderDashboard();

  const aiSettings = page.getByRole("link", { name: "AI settings" });
  const conversations = page.getByRole("link", { name: "Conversations" });
  const logs = page.getByRole("link", { name: "Logs" });
  await expect.element(aiSettings).toHaveAttribute("href", "/bots/telegram-bot/ai");
  await expect.element(conversations).toHaveAttribute("href", "/bots/telegram-bot/conversations");
  await expect.element(logs).toHaveAttribute("href", "/bots/telegram-bot/logs");

  (aiSettings.element() as HTMLElement).focus();
  await expect.element(aiSettings).toHaveFocus();
  await userEvent.tab();
  await expect.element(conversations).toHaveFocus();
  await userEvent.tab();
  await expect.element(logs).toHaveFocus();
});

test("shows only applicable edit and logs destinations for a Lark webhook", async () => {
  mocks.useOne.mockReturnValue({
    data: { data: LARK_BOT },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mocks.refetch,
  });
  await renderDashboard("lark-bot");

  await expect
    .element(page.getByRole("link", { name: "Edit bot" }))
    .toHaveAttribute("href", "/bots/lark-bot/edit");
  await expect
    .element(page.getByRole("link", { name: "Logs" }))
    .toHaveAttribute("href", "/bots/lark-bot/logs");
  await expect.element(page.getByRole("link", { name: "AI settings" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("link", { name: "Conversations" })).not.toBeInTheDocument();
});
