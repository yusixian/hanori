import "@/style.css";
import { i18n } from "@/i18n";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BotRssPage } from "./rss";
import { BotSummaryPage } from "./summary";

const collection = {
  id: 1,
  name: "Reading notes and creative inspiration ".repeat(4),
  description: "A daily reading collection",
  isActive: true,
  digestHour: 9,
  digestMinute: 0,
  feeds: [],
};
const summary = {
  id: 1,
  botId: "test-id",
  chatId: -100123,
  windowStart: "2026-09-30T08:00:00Z",
  windowEnd: "2026-10-01T08:00:00Z",
  trigger: "manual",
  content: "A quiet afternoon with Hanori.\nWe shared a few ideas for our next drawing.",
  createdAt: "2026-10-01T08:00:00Z",
  modelId: "daily-companion",
  messageCount: 24,
  errorMessage: null,
};
let rssFailed = false;
let historyFailed = false;
let populated = false;
let requestMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1024, 768);
  rssFailed = false;
  historyFailed = false;
  populated = false;
  requestMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.endsWith("/rss/collections/1/items"))
      return json({ ok: true, data: { items: [], totalCount: 0 } });
    if (url.pathname.endsWith("/rss/collections/1")) return json({ ok: true, data: collection });
    if (url.pathname.endsWith("/rss/collections"))
      return rssFailed
        ? json({ ok: false }, 503)
        : json({ ok: true, data: populated ? [collection] : [] });
    if (url.pathname === "/api/authz/me") return json({ data: { member: { role: "admin" } } });
    if (url.pathname.endsWith("/memory/review"))
      return json({
        ok: true,
        data: { calls: 1, changes: 1, inputTokens: 12, outputTokens: 5, nextAfterMessageId: null },
      });
    if (url.pathname.endsWith("/summary/configs")) return json({ ok: true, data: [] });
    if (url.pathname.endsWith("/summary/history"))
      return historyFailed
        ? json({ ok: false }, 503)
        : json({
            ok: true,
            data: populated && !url.searchParams.has("chatId") ? [summary] : [],
            total: populated && !url.searchParams.has("chatId") ? 1 : 0,
          });
    return json({ ok: false }, 404);
  });
  vi.stubGlobal("fetch", requestMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await page.viewport(1024, 768);
});

async function renderPage(route: "rss" | "summary") {
  await render(
    <MemoryRouter initialEntries={[`/bots/test-id/${route}`]}>
      <Routes>
        <Route
          path="/bots/:botId/rss"
          element={
            <div className="p-4">
              <BotRssPage />
            </div>
          }
        />
        <Route
          path="/bots/:botId/summary"
          element={
            <div className="p-4">
              <BotSummaryPage />
            </div>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

test("gives the RSS empty state one clear creation action and preserves cancellation", async () => {
  await renderPage("rss");
  await expect.element(page.getByText("Make room for your favorite reads")).toBeVisible();
  expect(page.getByRole("button", { name: "New Collection" }).elements()).toHaveLength(1);
  await page.getByRole("button", { name: "New Collection" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Collection name", exact: true }))
    .toBeVisible();
  await page.getByRole("textbox", { name: "Collection name", exact: true }).fill("My reading list");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(page.getByText("Make room for your favorite reads")).toBeVisible();
});

test("does not present an RSS read failure as an empty collection", async () => {
  rssFailed = true;
  await renderPage("rss");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Could not load RSS collections");
  await expect.element(page.getByText("Make room for your favorite reads")).not.toBeInTheDocument();
  rssFailed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(page.getByText("Make room for your favorite reads")).toBeVisible();
});

test("opens a long RSS collection with the keyboard at phone width", async () => {
  populated = true;
  await page.viewport(320, 844);
  await renderPage("rss");
  const disclosure = page.getByRole("button", { name: /Reading notes and creative inspiration/ });
  await expect.element(disclosure).toBeVisible();
  disclosure.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Add Feed", exact: true }).click();
  await expect.element(page.getByPlaceholder("RSS/Atom feed URL")).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

test("distinguishes an empty summary history from a filtered result", async () => {
  await renderPage("summary");
  await expect.element(page.getByText("Your next catch-up starts here")).toBeVisible();
  await expect.element(page.getByText("No history yet.")).toBeVisible();
  await page.getByRole("spinbutton", { name: "Filter by Chat ID" }).fill("42");
  await expect.element(page.getByText("No summaries for this chat")).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect.element(page.getByText("No history yet.")).toBeVisible();
});

test("keeps a summary read failure visible and retryable", async () => {
  historyFailed = true;
  await renderPage("summary");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Could not load summary history");
  await expect.element(page.getByText("No history yet.")).not.toBeInTheDocument();
  historyFailed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(page.getByText("No history yet.")).toBeVisible();
});

test("reads a summary in a modal and restores focus when Escape closes it", async () => {
  populated = true;
  await page.viewport(320, 844);
  await renderPage("summary");
  const view = page.getByRole("button", { name: "View", exact: true });
  await view.click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toHaveTextContent("A quiet afternoon with Hanori.");
  await expect.element(page.getByRole("button", { name: "Close", exact: true })).toHaveFocus();
  await userEvent.tab();
  await page.getByRole("button", { name: "Review this group during the summary period" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Input tokens 12");
  expect(requestMock).toHaveBeenCalledWith(
    expect.stringContaining("/bots/test-id/memory/review"),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        chatId: "-100123",
        start: summary.windowStart,
        end: summary.windowEnd,
      }),
    }),
  );
  // Native dialogs may let Tab reach browser chrome, but the page behind stays inert.
  view.element().focus();
  await expect.element(view).not.toHaveFocus();
  page.getByRole("button", { name: "Close", exact: true }).element().focus();
  expect(dialog.element().getBoundingClientRect().width).toBeLessThanOrEqual(window.innerWidth);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(view).toHaveFocus();
});

test("keeps dialog edges usable and only dismisses clicks outside its bounds", async () => {
  populated = true;
  await page.viewport(320, 844);
  await renderPage("summary");
  const view = page.getByRole("button", { name: "View", exact: true });
  await view.click();
  const dialog = page.getByRole("dialog");
  const bounds = dialog.element().getBoundingClientRect();
  dialog.element().dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      clientX: bounds.right - 1,
      clientY: bounds.top + bounds.height / 2,
    }),
  );
  await expect.element(dialog).toBeVisible();
  dialog.element().dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      clientX: bounds.left - 8,
      clientY: bounds.top + bounds.height / 2,
    }),
  );
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(view).toHaveFocus();
});
