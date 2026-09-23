import { i18n } from "@/i18n";
import "@/style.css";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { BotListPage } from "./list";

const mocks = vi.hoisted(() => ({
  useList: vi.fn(),
  invalidate: vi.fn(),
  refetch: vi.fn(async () => undefined),
}));

vi.mock("@refinedev/core", () => ({
  useList: mocks.useList,
  useInvalidate: () => mocks.invalidate,
}));

function makeBot(id: number): BotWithStatus {
  return {
    id: `bot-${id}`,
    name: `Bot ${id}`,
    platform: "telegram",
    tokenMasked: "1234…abcd",
    adminChatIds: [],
    isActive: true,
    miniAppEnabled: false,
    status: id % 2 === 0 ? "running" : "stopped",
    uptime: 300,
    aiEnabled: true,
    aiHasApiKey: true,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: null,
  };
}

async function renderList() {
  return render(
    <MemoryRouter>
      <BotListPage />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
  mocks.useList.mockReset();
  mocks.invalidate.mockReset();
  mocks.refetch.mockClear();
});

afterEach(async () => {
  await page.viewport(1440, 900);
  vi.restoreAllMocks();
});

test("shows an initial load error without false totals or the empty-state creation prompt", async () => {
  mocks.useList.mockReturnValue({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: true,
    refetch: mocks.refetch,
  });
  await renderList();

  await expect.element(page.getByRole("alert")).toHaveTextContent("Bots could not be loaded");
  await expect.element(page.getByTestId("bot-total")).not.toBeInTheDocument();
  await expect.element(page.getByText("No bots yet")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Add your first bot" }))
    .not.toBeInTheDocument();

  await page.getByRole("button", { name: "Retry" }).click();
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

test("distinguishes a successful empty list from an error", async () => {
  mocks.useList.mockReturnValue({
    data: { data: [], total: 0 },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mocks.refetch,
  });
  await renderList();

  await expect.element(page.getByTestId("bot-total")).toHaveTextContent("0");
  await expect.element(page.getByText("No bots yet")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add your first bot" })).toBeVisible();
  await expect.element(page.getByText("Bots could not be loaded")).not.toBeInTheDocument();
});

test("keeps stale bot data visible when a background refresh fails", async () => {
  mocks.useList.mockReturnValue({
    data: { data: [makeBot(1)], total: 1 },
    isLoading: false,
    isFetching: false,
    isError: true,
    refetch: mocks.refetch,
  });
  await renderList();

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Refresh failed. Showing the most recently loaded bot data.");
  await expect.element(page.getByRole("link", { name: /Bot 1/ })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

test("pages beyond 100 bots, corrects a shrunken last page, and keeps mobile cards compact", async () => {
  await page.viewport(390, 844);
  let total = 121;
  mocks.useList.mockImplementation(({ pagination }: { pagination: { current: number } }) => {
    const current = pagination.current;
    const start = (current - 1) * 12 + 1;
    const end = Math.min(current * 12, total);
    return {
      data: {
        data:
          start <= total
            ? Array.from({ length: end - start + 1 }, (_, index) => makeBot(start + index))
            : [],
        total,
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: mocks.refetch,
    };
  });
  const rendered = await renderList();

  await expect.element(page.getByTestId("bot-total")).toHaveTextContent("121");
  expect((page.getByTestId("bot-card").first().element() as HTMLElement).offsetHeight).toBeLessThan(
    180,
  );
  await expect.element(page.getByText("1234…abcd")).not.toBeInTheDocument();
  expect(mocks.useList.mock.calls.at(-1)?.[0].pagination).toEqual({ current: 1, pageSize: 12 });

  await page.getByRole("button", { name: "1 / 11" }).click();
  const pageInput = page.getByRole("textbox", { name: "Click to jump to a page" });
  await pageInput.fill("11");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("link", { name: /Bot 121/ })).toBeVisible();

  total = 13;
  await rendered.rerender(
    <MemoryRouter>
      <BotListPage />
    </MemoryRouter>,
  );
  await expect.element(page.getByRole("link", { name: /Bot 13/ })).toBeVisible();
  expect(mocks.useList.mock.calls.at(-1)?.[0].pagination).toEqual({ current: 2, pageSize: 12 });
  await expect.element(page.getByText("Showing 13–13 of 13 bots")).toBeVisible();
});

test("finds a Bot beyond the current page and clears the search without losing focus", async () => {
  await page.viewport(390, 844);
  mocks.useList.mockImplementation(({ filters }: { filters: { value: string }[] }) => {
    const search = filters[0]?.value;
    const bots = search === "Bot 125" ? [makeBot(125)] : search ? [] : [makeBot(1)];
    return {
      data: { data: bots, total: search ? bots.length : 125 },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: mocks.refetch,
    };
  });
  await renderList();

  const searchInput = page.getByRole("textbox", { name: "Find a bot" });
  await searchInput.fill("Bot 125");
  await vi.waitFor(() => {
    expect(mocks.useList.mock.calls.at(-1)?.[0]).toMatchObject({
      pagination: { current: 1, pageSize: 12 },
      filters: [{ field: "search", value: "Bot 125" }],
      queryOptions: { keepPreviousData: false },
    });
  });
  await expect.element(page.getByRole("link", { name: /Bot 125/ })).toBeVisible();
  await expect.element(page.getByTestId("bot-total")).toHaveTextContent("1");
  await expect.element(page.getByRole("status")).toHaveTextContent("Matching bots: 1");

  await searchInput.fill("missing");
  await expect.element(page.getByText("No matching bots")).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "No matching bots" })).toBeVisible();
  await expect.element(page.getByRole("status")).toHaveTextContent("Matching bots: 0");
  await expect.element(page.getByText("No bots yet")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Clear search" }).first().click();
  await expect.element(searchInput).toHaveFocus();
  await expect.element(page.getByTestId("bot-total")).toHaveTextContent("125");
  expect(mocks.useList.mock.calls.at(-1)?.[0].filters).toEqual([]);
});

test("waits until text composition finishes before searching", async () => {
  mocks.useList.mockReturnValue({
    data: { data: [], total: 0 },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mocks.refetch,
  });
  await renderList();

  const input = page.getByRole("textbox", { name: "Find a bot" });
  await input.fill("中");
  input.element().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await input.fill("中文");
  await userEvent.keyboard("{Enter}");
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(mocks.useList.mock.calls.at(-1)?.[0].filters).toEqual([]);

  input.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await vi.waitFor(() => {
    expect(mocks.useList.mock.calls.at(-1)?.[0].filters).toEqual([
      { field: "search", operator: "eq", value: "中文" },
    ]);
  });
});

test("keeps search focus when an earlier page request finishes", async () => {
  let pageTwoReady = false;
  mocks.useList.mockImplementation(({ pagination }: { pagination: { current: number } }) => ({
    data:
      pagination.current === 2 && !pageTwoReady
        ? undefined
        : { data: [makeBot(pagination.current === 2 ? 13 : 1)], total: 24 },
    isLoading: pagination.current === 2 && !pageTwoReady,
    isFetching: pagination.current === 2 && !pageTwoReady,
    isError: false,
    refetch: mocks.refetch,
  }));
  const rendered = await renderList();

  await page.getByRole("button", { name: "Next page" }).click();
  const searchInput = page.getByRole("textbox", { name: "Find a bot" });
  await searchInput.click();
  pageTwoReady = true;
  await rendered.rerender(
    <MemoryRouter>
      <BotListPage />
    </MemoryRouter>,
  );
  await expect.element(page.getByRole("link", { name: /Bot 13/ })).toBeVisible();
  await expect.element(searchInput).toHaveFocus();
});

test("focuses the list heading after an uncached page finishes loading", async () => {
  let pageTwoReady = false;
  const scrollIntoView = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(() => undefined);
  mocks.useList.mockImplementation(({ pagination }: { pagination: { current: number } }) => {
    if (pagination.current === 2 && !pageTwoReady) {
      return {
        data: undefined,
        isLoading: true,
        isFetching: true,
        isError: false,
        refetch: mocks.refetch,
      };
    }
    return {
      data: {
        data: [makeBot(pagination.current === 2 ? 13 : 1)],
        total: 24,
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: mocks.refetch,
    };
  });
  const rendered = await renderList();

  await page.getByRole("button", { name: "Next page" }).click();
  await expect.element(page.getByRole("status", { name: "Loading bots…" })).toBeVisible();

  pageTwoReady = true;
  await rendered.rerender(
    <MemoryRouter>
      <BotListPage />
    </MemoryRouter>,
  );
  const heading = page.getByRole("heading", { name: "Your bots" });
  await expect.element(page.getByRole("link", { name: /Bot 13/ })).toBeVisible();
  await expect.element(heading).toHaveFocus();
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
});
