import type { LogEntry } from "@cos-tool-bot/shared";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { LogEntryRow, logMatchesFilters, mergeLogEntries } from "./log-entry-row";

const log: LogEntry = {
  id: 42,
  botId: "00000000-0000-4000-8000-000000000001",
  level: "error",
  message:
    "AI reply failed after the upstream model returned an incomplete response that must remain readable on narrow screens.",
  meta: {
    correlationId: "turn-abc",
    chatId: -100123,
    userId: 7,
    messageId: 99,
    error: {
      name: "ProviderError",
      message: "upstream rejected request",
      stack: "ProviderError: upstream rejected request\n    at reply.ts:42:7",
      cause: { code: "ECONNRESET" },
      statusCode: 502,
      responseBody: '{"error":{"code":"bad_request","detail":"full upstream response body"}}',
    },
    messages: [{ role: "user", content: "hello" }],
  },
  createdAt: "2026-09-21T12:00:00.000Z",
};

const labels = {
  details: "Details",
  metadata: "Complete details",
  copyJson: "Copy JSON",
  copied: "Copied",
};

afterEach(() => {
  vi.restoreAllMocks();
});

test("shows a complete AI failure record and copies the full JSON", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<LogEntryRow log={log} labels={labels} />);

  await expect.element(page.getByText(log.message, { exact: true })).toBeVisible();
  await expect.element(page.getByText("correlationId: turn-abc", { exact: true })).toBeVisible();

  await page.getByText("Details", { exact: true }).click();
  await expect.element(page.getByText("Complete details", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/ProviderError: upstream rejected request/)).toBeVisible();
  await expect.element(page.getByText(/at reply\.ts:42:7/)).toBeVisible();
  await expect.element(page.getByText(/full upstream response body/)).toBeVisible();

  await page.getByRole("button", { name: "Copy JSON" }).click();
  await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"correlationId": "turn-abc"'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"responseBody"'));
});

test("filters live logs by the same detail fields and de-duplicates history", () => {
  expect(logMatchesFilters(log, "error", "econnreset", "-100123", "turn-abc")).toBe(true);
  expect(logMatchesFilters(log, "warn", "", "", "")).toBe(false);
  expect(logMatchesFilters(log, "error", "", "-100999", "turn-abc")).toBe(false);

  const older = { ...log, id: 41, message: "older" };
  const merged = mergeLogEntries([log, older], [{ ...log, message: "live copy" }]);
  expect(merged.map((entry) => entry.id)).toEqual([42, 41]);
  expect(merged[0]?.message).toBe("live copy");
});
