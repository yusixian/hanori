import { i18n } from "@/i18n";
import "@/style.css";
import type { BotWithStatus, LogEntry } from "@cos-tool-bot/shared";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
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
  useSSEConnection: () => ({
    connected: true,
    liveLogs: mocks.liveLogs,
    clearLiveLogs: mocks.clearLiveLogs,
  }),
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

async function renderGlobalLogs(entry = "/logs") {
  await render(
    <MemoryRouter initialEntries={[entry]}>
      <LogsListPage />
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

  const botFilter = page.getByRole("combobox", { name: "All Bots" });
  await expect.element(botFilter).toHaveTextContent("All Bots");
  await botFilter.click();
  await page.getByRole("option", { name: "Bot 125", exact: true }).click();
  await vi.waitFor(() => expect(filterValue("botId")).toBe("bot-125"));

  expect(mocks.getBots.mock.calls.map(([request]) => request.query)).toEqual([
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
  ]);
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
  const botFilter = page.getByRole("combobox", { name: "All Bots" });
  expect(filterValue("botId")).toBe("bot-125");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Bot filter options could not be loaded.");
  await expect.element(botFilter).toHaveTextContent("bot-125");

  await botFilter.click();
  await expect.element(page.getByRole("option", { name: "bot-125", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "Bot 1", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("option", { name: "bot-125", exact: true }).click();

  const retryButton = page.getByRole("button", { name: "Retry" });
  await retryButton.click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Loading all Bot filter options…");
  await expect.element(page.getByRole("button", { name: "Loading…" })).toHaveFocus();
  resolveRetryFirstPage(botPageResponse(firstPage, 125));
  await vi.waitFor(() => expect(mocks.getBots).toHaveBeenCalledTimes(4));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(botFilter).toHaveTextContent("Bot 125");
  await expect.element(botFilter).toHaveFocus();
  await vi.waitFor(() => expect(filterValue("botId")).toBe("bot-125"));

  expect(mocks.getBots.mock.calls.map(([request]) => request.query)).toEqual([
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
    { page: "1", limit: "100" },
    { page: "2", limit: "100" },
  ]);
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
    .element(page.getByRole("combobox", { name: "All Bots" }))
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
    .toHaveTextContent("Logs could not be cleared. Try again.");
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
    .toHaveTextContent("Logs could not be cleared. Try again.");
  await expect.element(page.getByText("matching live log", { exact: true })).toBeVisible();
  expect(mocks.clearLiveLogs).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
});
