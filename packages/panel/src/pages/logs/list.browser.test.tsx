import { i18n } from "@/i18n";
import "@/style.css";
import type { BotWithStatus, LogEntry } from "@cos-tool-bot/shared";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { LogsListPage } from "./list";
import { BotLogsPage } from "../bots/logs";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

function botOption(id: string, name: string): BotWithStatus {
  return { id, name } as BotWithStatus;
}

function botPageResponse(data: BotWithStatus[], total: number, ok = true) {
  return { ok, json: async () => ({ ok: true, data, total }) };
}

function botPageFailure() {
  return { ok: false, json: async () => ({ ok: false }) };
}

const mocks = vi.hoisted(() => {
  const matchingLiveLog: LogEntry = {
    id: 2,
    botId: "00000000-0000-4000-8000-000000000001",
    level: "info",
    message: "matching live log",
    meta: { chatId: -100123, correlationId: "turn-abc" },
    createdAt: "2026-09-22T00:00:02.000Z",
  };
  return {
    useList: vi.fn(),
    invalidate: vi.fn(),
    getBots: vi.fn(),
    deleteLogs: vi.fn(),
    clearLiveLogs: vi.fn(),
    sseUrl: "",
    liveLogs: [
      matchingLiveLog,
      {
        ...matchingLiveLog,
        id: 1,
        message: "other live log",
        meta: { chatId: -200, correlationId: "turn-other" },
      },
    ],
  };
});

vi.mock("@refinedev/core", () => ({
  useList: mocks.useList,
  useInvalidate: () => mocks.invalidate,
}));

vi.mock("@/hooks/use-sse-connection", () => ({
  useSSEConnection: (url: string) => {
    mocks.sseUrl = url;
    return {
      connected: true,
      liveLogs: mocks.liveLogs,
      clearLiveLogs: mocks.clearLiveLogs,
    };
  },
}));

vi.mock("@/lib/client", () => ({
  client: {
    api: {
      bots: { $get: mocks.getBots },
      logs: { $delete: mocks.deleteLogs },
    },
  },
}));

function filtersFromLastRequest(): Array<{ field: string; value: string }> {
  return (mocks.useList.mock.calls.at(-1)?.[0]?.filters ?? []) as Array<{
    field: string;
    value: string;
  }>;
}

function filterValue(field: string): string | undefined {
  return filtersFromLastRequest().find((filter) => filter.field === field)?.value;
}

async function renderGlobalLogs(entry = "/logs", withHistoryControls = false) {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="logs-location">{location.search}</div>;
  }
  function HistoryControls() {
    const navigate = useNavigate();
    return (
      <>
        <button type="button" onClick={() => navigate(-1)}>
          Browser back
        </button>
        <button type="button" onClick={() => navigate(1)}>
          Browser forward
        </button>
      </>
    );
  }
  await render(
    <MemoryRouter initialEntries={[entry]}>
      <LogsListPage />
      <LocationProbe />
      {withHistoryControls && <HistoryControls />}
    </MemoryRouter>,
  );
}

async function renderBotLogs() {
  await render(
    <MemoryRouter initialEntries={[`/bots/${BOT_ID}/logs`]}>
      <Routes>
        <Route path="/bots/:botId/logs" element={<BotLogsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  await i18n.changeLanguage("en");
  mocks.useList.mockReset();
  mocks.useList.mockReturnValue({
    data: { data: [], total: 0 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mocks.invalidate.mockReset();
  mocks.clearLiveLogs.mockReset();
  mocks.liveLogs.splice(2);
  mocks.sseUrl = "";
  mocks.deleteLogs.mockReset();
  mocks.deleteLogs.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  mocks.getBots.mockReset();
  mocks.getBots.mockResolvedValue(botPageResponse([botOption(BOT_ID, "Alpha Bot")], 1));
});

test("loads all Bot filter options and applies a Bot from the second page", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    botOption(`bot-${index + 1}`, `Bot ${index + 1}`),
  );
  const secondPage = Array.from({ length: 25 }, (_, index) =>
    botOption(`bot-${index + 101}`, `Bot ${index + 101}`),
  );
  mocks.getBots
    .mockResolvedValueOnce(botPageResponse(firstPage, 125))
    .mockResolvedValueOnce(botPageResponse(secondPage, 125));

  await renderGlobalLogs();
  await vi.waitFor(() => expect(mocks.getBots).toHaveBeenCalledTimes(2));

  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: All Bots");
  await expect.element(botFilter).toHaveTextContent("All Bots");
  await botFilter.click();
  const botSearch = page.getByRole("combobox", { name: "Search Bots by name…" });
  await expect.element(botSearch).toHaveFocus();
  await botSearch.fill("bot 125");
  await expect
    .element(page.getByRole("option", { name: "Bot 125", exact: true }))
    .toHaveClass(/bg-accent/);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(filterValue("botId")).toBe("bot-125"));
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: Bot 125");
  await expect.element(botFilter).toHaveFocus();
  await expect.element(page.getByTestId("logs-location")).toHaveTextContent("?botId=bot-125");
  expect(filterValue("search")).toBeUndefined();

  expect(mocks.getBots.mock.calls.map(([request]) => request.query)).toEqual([
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
  ]);
});

test("keeps keyboard-active Bots visible below the sticky clear option on mobile", async () => {
  await page.viewport(390, 844);
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    botOption(`bot-${index + 1}`, `Bot ${index + 1}`),
  );
  const secondPage = Array.from({ length: 25 }, (_, index) =>
    botOption(`bot-${index + 101}`, `Bot ${index + 101}`),
  );
  mocks.getBots
    .mockResolvedValueOnce(botPageResponse(firstPage, 125))
    .mockResolvedValueOnce(botPageResponse(secondPage, 125));

  await renderGlobalLogs();
  await vi.waitFor(() => expect(mocks.getBots).toHaveBeenCalledTimes(2));
  await page.getByRole("button", { name: /^Bot filter:/ }).click();
  const search = page.getByRole("combobox", { name: "Search Bots by name…" });
  const listbox = page.getByRole("listbox", { name: "All Bots" });
  const listboxElement = await listbox.findElement();
  const allBotsElement = await listbox.getByRole("option", { name: "All Bots" }).findElement();
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}".repeat(20));
  expect(listboxElement.scrollTop).toBeGreaterThan(0);

  for (let number = 20; number >= 10; number -= 1) {
    const active = listbox.getByRole("option", { name: `Bot ${number}`, exact: true });
    await expect.element(active).toHaveClass(/bg-accent/);
    const activeElement = await active.findElement();
    expect((await search.findElement()).getAttribute("aria-activedescendant")).toBe(
      activeElement.id,
    );
    const activeBounds = activeElement.getBoundingClientRect();
    const clearBounds = allBotsElement.getBoundingClientRect();
    const listBounds = listboxElement.getBoundingClientRect();
    expect(activeBounds.top).toBeGreaterThanOrEqual(clearBounds.bottom - 1);
    expect(activeBounds.bottom).toBeLessThanOrEqual(listBounds.bottom + 1);
    expect(
      document
        .elementFromPoint(
          activeBounds.left + activeBounds.width / 2,
          activeBounds.top + activeBounds.height / 2,
        )
        ?.closest('[role="option"]'),
    ).toBe(activeElement);
    if (number > 10) await userEvent.keyboard("{ArrowUp}");
  }

  await listbox.getByRole("option", { name: "Bot 10", exact: true }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBe("bot-10"));
});

test("keeps the selected Bot through a second-page failure and retry", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    botOption(`bot-${index + 1}`, `Bot ${index + 1}`),
  );
  const secondPage = Array.from({ length: 25 }, (_, index) =>
    botOption(`bot-${index + 101}`, `Bot ${index + 101}`),
  );
  let resolveRetryFirstPage!: (response: ReturnType<typeof botPageResponse>) => void;
  const retryFirstPage = new Promise<ReturnType<typeof botPageResponse>>((resolve) => {
    resolveRetryFirstPage = resolve;
  });
  mocks.getBots
    .mockResolvedValueOnce(botPageResponse(firstPage, 125))
    .mockResolvedValueOnce(botPageFailure())
    .mockResolvedValueOnce(retryFirstPage)
    .mockResolvedValueOnce(botPageResponse(secondPage, 125));

  await renderGlobalLogs("/logs?botId=bot-125");
  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  expect(filterValue("botId")).toBe("bot-125");
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: bot-125");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Couldn't load Bot filter options.");
  await expect.element(botFilter).toHaveTextContent("bot-125");

  await botFilter.click();
  await expect.element(page.getByRole("option", { name: "bot-125", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "Bot 1", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("option", { name: "bot-125", exact: true }).click();

  const retryButton = page.getByRole("button", { name: "Retry" });
  await retryButton.click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Loading Bots…");
  await expect.element(page.getByRole("button", { name: "Loading…" })).toHaveFocus();
  resolveRetryFirstPage(botPageResponse(firstPage, 125));
  await vi.waitFor(() => expect(mocks.getBots).toHaveBeenCalledTimes(4));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(botFilter).toHaveTextContent("Bot 125");
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: Bot 125");
  await expect.element(botFilter).toHaveFocus();
  await vi.waitFor(() => expect(filterValue("botId")).toBe("bot-125"));

  expect(mocks.getBots.mock.calls.map(([request]) => request.query)).toEqual([
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
  ]);
});

test("retries a failed Bot list inside the open picker without losing selection", async () => {
  await page.viewport(390, 844);
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    botOption(`bot-${index + 1}`, `Bot ${index + 1}`),
  );
  const secondPage = Array.from({ length: 25 }, (_, index) =>
    botOption(`bot-${index + 101}`, `Bot ${index + 101}`),
  );
  let resolveRetryFirstPage!: (response: ReturnType<typeof botPageResponse>) => void;
  const retryFirstPage = new Promise<ReturnType<typeof botPageResponse>>((resolve) => {
    resolveRetryFirstPage = resolve;
  });
  mocks.getBots
    .mockResolvedValueOnce(botPageResponse(firstPage, 125))
    .mockResolvedValueOnce(botPageFailure())
    .mockResolvedValueOnce(retryFirstPage)
    .mockResolvedValueOnce(botPageResponse(secondPage, 125));

  await renderGlobalLogs("/logs?botId=bot-125");
  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  await botFilter.click();
  const listbox = page.getByRole("listbox", { name: "All Bots" });
  const botSearch = page.getByRole("combobox", { name: "Search Bots by name…" });
  const retry = listbox.getByRole("button", { name: "Retry" });
  await expect.element(retry).toBeVisible();
  const retryBounds = await retry.findElement().then((element) => element.getBoundingClientRect());
  expect(retryBounds.left).toBeGreaterThanOrEqual(0);
  expect(retryBounds.right).toBeLessThanOrEqual(390);
  await expect
    .element(listbox.getByRole("alert"))
    .toHaveTextContent("Couldn't load Bot filter options.");
  await userEvent.keyboard("{Tab}");
  await expect.element(retry).toHaveFocus();
  await retry.click();
  await expect.element(botSearch).toHaveFocus();
  await expect.element(listbox.getByRole("status")).toHaveTextContent("Loading Bots…");
  await expect
    .element(listbox.getByRole("option", { name: "Bot 1", exact: true }))
    .not.toBeInTheDocument();
  expect(filterValue("botId")).toBe("bot-125");

  resolveRetryFirstPage(botPageResponse(firstPage, 125));
  await vi.waitFor(() => expect(mocks.getBots).toHaveBeenCalledTimes(4));
  await expect.element(listbox.getByRole("alert")).not.toBeInTheDocument();
  const selectedOption = listbox.getByRole("option", { name: "Bot 125", exact: true });
  await expect.element(selectedOption).toBeVisible();
  await expect.element(selectedOption).toHaveClass(/bg-accent/);
  const allBotsOption = listbox.getByRole("option", { name: "All Bots" });
  const listboxElement = await listbox.findElement();
  const allBotsElement = await allBotsOption.findElement();
  expect(listboxElement.scrollTop).toBeGreaterThan(0);
  const listboxBounds = listboxElement.getBoundingClientRect();
  const allBotsBounds = allBotsElement.getBoundingClientRect();
  expect(allBotsBounds.top).toBeGreaterThanOrEqual(listboxBounds.top - 1);
  expect(allBotsBounds.bottom).toBeLessThanOrEqual(listboxBounds.bottom + 1);
  expect(
    document
      .elementFromPoint(
        allBotsBounds.left + allBotsBounds.width / 2,
        allBotsBounds.top + allBotsBounds.height / 2,
      )
      ?.closest('[role="option"]'),
  ).toBe(allBotsElement);
  expect((await botSearch.findElement()).getAttribute("aria-activedescendant")).toBe(
    (await selectedOption.findElement()).id,
  );
  await expect.element(botSearch).toHaveValue("");
  await expect.element(botSearch).toHaveFocus();
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: Bot 125");
  await userEvent.keyboard("{Enter}");
  expect(filterValue("botId")).toBe("bot-125");
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: Bot 125");
  await expect.element(botFilter).toHaveFocus();
  await botFilter.click();
  await listbox.getByRole("option", { name: "All Bots" }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBeUndefined());
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: All Bots");
  expect(mocks.getBots.mock.calls.map(([request]) => request.query)).toEqual([
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
  ]);
});

test("keeps an unknown Bot selected when opening its filter and pressing Enter", async () => {
  mocks.getBots.mockResolvedValue(botPageFailure());
  await renderGlobalLogs("/logs?botId=missing-bot");
  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: missing-bot");
  await botFilter.click();
  const botSearch = page.getByRole("combobox", { name: "Search Bots by name…" });
  await expect.element(botSearch).toHaveFocus();
  await expect.element(page.getByRole("option", { name: "missing-bot" })).toHaveClass(/bg-accent/);
  await userEvent.keyboard("{Enter}");
  expect(filterValue("botId")).toBe("missing-bot");
  await expect.element(page.getByTestId("logs-location")).toHaveTextContent("?botId=missing-bot");
  await expect.element(botFilter).toHaveFocus();
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: missing-bot");
});

test("keeps global filters compact on desktop and full width on mobile", async () => {
  await renderGlobalLogs();
  const filters = page.getByTestId("log-filters");

  const desktopTops = await filters
    .findElement()
    .then((element) =>
      Array.from(element.children).map((child) => Math.round(child.getBoundingClientRect().top)),
    );
  expect(new Set(desktopTops).size).toBe(1);

  await page.viewport(390, 844);
  const mobileWidths = await filters.findElement().then((element) => ({
    parent: element.getBoundingClientRect().width,
    children: Array.from(element.children).map((child) => child.getBoundingClientRect().width),
  }));
  expect(mobileWidths.children.every((width) => width >= mobileWidths.parent - 1)).toBe(true);
  await page.getByRole("button", { name: /^Bot filter:/ }).click();
  const viewport = await page
    .getByRole("listbox", { name: "All Bots" })
    .findElement()
    .then((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
    }));
  expect(viewport.left).toBeGreaterThanOrEqual(0);
  expect(viewport.right).toBeLessThanOrEqual(390);
});

test("filters Bot names locally and clears selection even when no names match", async () => {
  await renderGlobalLogs(`/logs?botId=${BOT_ID}`);
  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: Alpha Bot");
  await botFilter.click();
  const botSearch = page.getByRole("combobox", { name: "Search Bots by name…" });
  await botSearch.fill("no such bot");
  await expect.element(page.getByText("No matching Bots")).toBeVisible();
  await expect.element(page.getByRole("option", { name: "Alpha Bot" })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "All Bots" })).toBeVisible();
  expect(filterValue("botId")).toBe(BOT_ID);
  expect(filterValue("search")).toBeUndefined();
  await page.getByRole("option", { name: "All Bots" }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBeUndefined());
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: All Bots");
  await expect.element(page.getByTestId("logs-location")).toHaveTextContent("");
  await expect.element(botFilter).toHaveFocus();
});

test("syncs Bot filter, live logs, and clear scope with browser history", async () => {
  mocks.liveLogs.push({
    id: 3,
    botId: "other-bot",
    level: "info",
    message: "Other Bot live log",
    meta: {},
    createdAt: "2026-09-22T00:00:03.000Z",
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await renderGlobalLogs("/logs?view=compact", true);
  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  const otherLog = page.getByText("Other Bot live log", { exact: true });
  await expect.element(otherLog).toBeVisible();
  expect(mocks.sseUrl).toBe("/api/logs/stream");
  await page.getByRole("button", { name: "Pause live updates" }).click();
  await expect.element(page.getByRole("button", { name: "Resume live updates" })).toBeVisible();

  await botFilter.click();
  await page.getByRole("option", { name: "Alpha Bot" }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBe(BOT_ID));
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: Alpha Bot");
  await expect.element(page.getByTestId("logs-location")).toHaveTextContent(`?botId=${BOT_ID}`);
  await expect.element(otherLog).not.toBeInTheDocument();
  expect(mocks.sseUrl).toBe(`/api/logs/stream?botId=${BOT_ID}`);
  await vi.waitFor(() => expect(mocks.clearLiveLogs).toHaveBeenCalledTimes(1));
  await expect.element(page.getByRole("button", { name: "Pause live updates" })).toBeVisible();
  await page.getByRole("button", { name: "Clear Logs" }).click();
  expect(confirm).toHaveBeenLastCalledWith('Clear all logs for "Alpha Bot"?');

  await page.getByRole("button", { name: "Browser back" }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBeUndefined());
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: All Bots");
  await expect.element(page.getByTestId("logs-location")).toHaveTextContent("?view=compact");
  await expect.element(otherLog).toBeVisible();
  expect(mocks.sseUrl).toBe("/api/logs/stream");
  await vi.waitFor(() => expect(mocks.clearLiveLogs).toHaveBeenCalledTimes(2));
  await page.getByRole("button", { name: "Clear Logs" }).click();
  expect(confirm).toHaveBeenLastCalledWith("Clear all logs?");

  await page.getByRole("button", { name: "Browser forward" }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBe(BOT_ID));
  await expect.element(botFilter).toHaveAttribute("aria-label", "Bot filter: Alpha Bot");
  await expect.element(otherLog).not.toBeInTheDocument();
  expect(mocks.sseUrl).toBe(`/api/logs/stream?botId=${BOT_ID}`);
  await vi.waitFor(() => expect(mocks.clearLiveLogs).toHaveBeenCalledTimes(3));

  await botFilter.click();
  await page.getByRole("option", { name: "All Bots" }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBeUndefined());
  await expect.element(page.getByTestId("logs-location")).toHaveTextContent("");
  await expect.element(otherLog).toBeVisible();
  await vi.waitFor(() => expect(mocks.clearLiveLogs).toHaveBeenCalledTimes(4));
  await page.getByRole("button", { name: "Browser back" }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBe(BOT_ID));
  await expect.element(otherLog).not.toBeInTheDocument();
  await vi.waitFor(() => expect(mocks.clearLiveLogs).toHaveBeenCalledTimes(5));
  expect(mocks.deleteLogs).not.toHaveBeenCalled();
  confirm.mockRestore();
});

test("supports keyboard selection, Escape, and composing Enter in Bot search", async () => {
  mocks.getBots.mockResolvedValue(
    botPageResponse([botOption(BOT_ID, "Alpha Bot"), botOption("beta", "Beta Bot")], 2),
  );
  await renderGlobalLogs();
  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  await botFilter.click();
  const botSearch = page.getByRole("combobox", { name: "Search Bots by name…" });
  await botSearch.fill("beta");
  const betaOption = page.getByRole("option", { name: "Beta Bot" });
  await expect.element(betaOption).toHaveClass(/bg-accent/);
  expect((await botSearch.findElement()).getAttribute("aria-activedescendant")).toMatch(/-1$/);
  const allOption = page.getByRole("option", { name: "All Bots" });
  (await allOption.findElement()).dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  await expect.element(allOption).toHaveClass(/bg-accent/);
  (await betaOption.findElement()).dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true }),
  );
  await expect.element(betaOption).toHaveClass(/bg-accent/);
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(page.getByRole("option", { name: "All Bots" })).toHaveClass(/bg-accent/);
  await userEvent.keyboard("{ArrowDown}");
  const input = (await botSearch.findElement()) as HTMLInputElement;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
  );
  expect(filterValue("botId")).toBeUndefined();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(filterValue("botId")).toBe("beta"));
  await expect.element(botFilter).toHaveFocus();
  await botFilter.click();
  await expect.element(botSearch).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(botFilter).toHaveFocus();
  await expect.element(botSearch).not.toBeInTheDocument();
  expect(filterValue("botId")).toBe("beta");
});

test.each([1440, 390])("keeps Tab order visible around the Bot picker at %ipx", async (width) => {
  await page.viewport(width, width === 390 ? 844 : 900);
  await renderGlobalLogs();
  const botFilter = page.getByRole("button", { name: /^Bot filter:/ });
  const botSearch = page.getByRole("combobox", { name: "Search Bots by name…" });
  const chatId = page.getByRole("textbox", { name: "Chat ID" });

  await botFilter.click();
  await expect.element(botSearch).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(botSearch).not.toBeInTheDocument();
  await expect.element(chatId).toHaveFocus();
  expect((await chatId.findElement()).matches(":focus-visible")).toBe(true);

  await botFilter.click();
  await expect.element(botSearch).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(botSearch).not.toBeInTheDocument();
  await expect.element(botFilter).toHaveFocus();
  expect((await botFilter.findElement()).matches(":focus-visible")).toBe(true);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(page.getByRole("combobox", { name: "All Levels" })).toHaveFocus();
});

test("keeps Bot filters compact on desktop and full width on mobile", async () => {
  await renderBotLogs();
  const filters = page.getByTestId("log-filters");

  const desktopTops = await filters
    .findElement()
    .then((element) =>
      Array.from(element.children).map((child) => Math.round(child.getBoundingClientRect().top)),
    );
  expect(new Set(desktopTops).size).toBe(1);

  await page.viewport(390, 844);
  const mobileWidths = await filters.findElement().then((element) => ({
    parent: element.getBoundingClientRect().width,
    children: Array.from(element.children).map((child) => child.getBoundingClientRect().width),
  }));
  expect(mobileWidths.children.every((width) => width >= mobileWidths.parent - 1)).toBe(true);
});

test("applies valid negative chat and correlation filters consistently to history and live logs", async () => {
  await renderGlobalLogs();
  const chatId = page.getByRole("textbox", { name: "Chat ID" });
  const correlationId = page.getByRole("textbox", { name: "Correlation ID" });

  await chatId.fill("-");
  expect(filtersFromLastRequest().some((filter) => filter.field === "chatId")).toBe(false);
  await correlationId.fill("   ");
  expect(filterValue("correlationId")).toBeUndefined();
  await expect.element(page.getByText("matching live log", { exact: true })).toBeVisible();
  await expect.element(page.getByText("other live log", { exact: true })).toBeVisible();

  await chatId.fill("-100123");
  expect(filterValue("chatId")).toBe("-100123");
  await expect.element(page.getByText("matching live log", { exact: true })).toBeVisible();
  await expect.element(page.getByText("other live log", { exact: true })).not.toBeInTheDocument();

  await correlationId.fill("  turn-abc  ");
  expect(filterValue("correlationId")).toBe("turn-abc");
});

test("applies the same safe structured filters in a Bot workspace", async () => {
  await renderBotLogs();
  const chatId = page.getByRole("textbox", { name: "Chat ID" });

  await chatId.fill("-");
  expect(filterValue("chatId")).toBeUndefined();
  expect(filterValue("botId")).toBe(BOT_ID);
  await page.getByRole("textbox", { name: "Correlation ID" }).fill("   ");
  expect(filterValue("correlationId")).toBeUndefined();

  await chatId.fill("-100123");
  await page.getByRole("textbox", { name: "Correlation ID" }).fill(" turn-abc ");
  expect(filterValue("chatId")).toBe("-100123");
  expect(filterValue("correlationId")).toBe("turn-abc");
  await expect.element(page.getByText("matching live log", { exact: true })).toBeVisible();
  await expect.element(page.getByText("other live log", { exact: true })).not.toBeInTheDocument();
});

test("preserves debounced search and applies IME text only after composition ends", async () => {
  await renderGlobalLogs();
  const search = page.getByRole("textbox", { name: "Search messages and details…" });

  await search.fill("   ");
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  expect(filterValue("search")).toBeUndefined();
  await expect.element(page.getByText("matching live log", { exact: true })).toBeVisible();
  await expect.element(page.getByText("other live log", { exact: true })).toBeVisible();

  await search.fill(" timeout ");
  expect(filtersFromLastRequest().some((filter) => filter.field === "search")).toBe(false);
  await vi.waitFor(() => expect(filterValue("search")).toBe("timeout"), { timeout: 1_000 });

  const input = (await search.findElement()) as HTMLInputElement;
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await search.fill("超时");
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  expect(filterValue("search")).toBe("timeout");
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "超时" }));
  await vi.waitFor(() => expect(filterValue("search")).toBe("超时"));
});

test("uses the selected Bot in clear confirmation and leaves data untouched when cancelled", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await renderGlobalLogs(`/logs?botId=${BOT_ID}`);
  await expect
    .element(page.getByRole("button", { name: /^Bot filter:/ }))
    .toHaveTextContent("Alpha Bot");

  await page.getByRole("button", { name: "Clear Logs" }).click();
  expect(confirm).toHaveBeenLastCalledWith('Clear all logs for "Alpha Bot"?');
  expect(mocks.deleteLogs).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Clear Logs" }).click();
  expect(mocks.deleteLogs).toHaveBeenCalledWith({ query: { botId: BOT_ID } });
  expect(mocks.clearLiveLogs).toHaveBeenCalledOnce();
  expect(mocks.invalidate).toHaveBeenCalledWith({ resource: "logs", invalidates: ["list"] });
});

test("keeps global logs intact and shows an error when clear is rejected", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mocks.deleteLogs.mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: "Forbidden" }), { status: 403 }),
  );
  await renderGlobalLogs();

  await page.getByRole("button", { name: "Clear Logs" }).click();

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Couldn't clear logs. Please try again.");
  await expect.element(page.getByText("matching live log", { exact: true })).toBeVisible();
  expect(mocks.clearLiveLogs).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
});

test("keeps Bot logs intact when clear returns an unsuccessful body", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mocks.deleteLogs.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "Failed" })));
  await renderBotLogs();

  await page.getByRole("button", { name: "Clear Logs" }).click();

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Couldn't clear logs. Please try again.");
  await expect.element(page.getByText("matching live log", { exact: true })).toBeVisible();
  expect(mocks.clearLiveLogs).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
});
