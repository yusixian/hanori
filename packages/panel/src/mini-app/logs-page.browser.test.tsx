import { i18n } from "@/i18n";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LogsPage } from "./logs-page";
import "./i18n";
import "./mini-app.css";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("renders a compact safe log list and loads the next bounded page", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        logs: [
          {
            id: 12,
            level: "warn",
            message: "Bot restarting...",
            createdAt: "2026-07-28T00:00:00.000Z",
            meta: { command: "restart", chatType: "private", updateId: 44, messageId: 55 },
          },
        ],
        nextCursor: 12,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        logs: [
          {
            id: 11,
            level: "info",
            message: "Bot started",
            createdAt: "2026-07-27T23:59:00.000Z",
            meta: {},
          },
        ],
        nextCursor: null,
      }),
    );
  vi.stubGlobal("fetch", fetcher);

  render(<LogsPage botId={BOT_ID} />);

  await expect.element(page.getByRole("heading", { name: "Runtime logs" })).toBeVisible();
  await expect.element(page.getByText("Bot restarting...")).toBeVisible();
  await expect.element(page.getByText("/restart")).toBeVisible();
  expect(document.body.textContent).not.toMatch(/apiKey|token|stack|private message/);
  const refresh = page.getByRole("button", { name: "Refresh logs" });
  expect(Number.parseFloat(getComputedStyle(refresh.element()).minHeight)).toBeGreaterThanOrEqual(
    44,
  );

  await page.getByRole("button", { name: "Load earlier logs" }).click();
  await expect.element(page.getByText("Bot started")).toBeVisible();
  expect(fetcher).toHaveBeenLastCalledWith(`/api/mini-app/${BOT_ID}/logs?limit=25&before=12`, {
    credentials: "same-origin",
  });
});

test("applies level filters without live polling", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true, logs: [], nextCursor: null }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<LogsPage botId={BOT_ID} />);

  await expect.element(page.getByText("No logs yet.")).toBeVisible();
  const select = document.querySelector<HTMLSelectElement>(".mini-logs-toolbar select");
  if (!select) throw new Error("Expected log level select");
  const setSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setSelectValue?.call(select, "error");
  select.dispatchEvent(new Event("change", { bubbles: true }));

  await expect.poll(() => fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("level=error"))).toBe(true);
});

test("keeps the current page visible when loading earlier logs fails", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        logs: [
          {
            id: 12,
            level: "info",
            message: "Bot started",
            createdAt: "2026-07-28T00:00:00.000Z",
            meta: {},
          },
        ],
        nextCursor: 12,
      }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  render(<LogsPage botId={BOT_ID} />);

  await expect.element(page.getByText("Bot started")).toBeVisible();
  await page.getByRole("button", { name: "Load earlier logs" }).click();

  await expect.element(page.getByText("Bot started")).toBeVisible();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
