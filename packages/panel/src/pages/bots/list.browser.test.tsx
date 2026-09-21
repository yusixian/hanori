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
  const pageInput = page.getByRole("textbox");
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
