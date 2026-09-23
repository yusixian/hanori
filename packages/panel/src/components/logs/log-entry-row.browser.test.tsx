import type { LogEntry } from "@cos-tool-bot/shared";
import "@/style.css";
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

  await page.getByText(log.message, { exact: true }).click();
  await expect.element(page.getByText("Complete details", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/ProviderError: upstream rejected request/)).toBeVisible();
  await expect.element(page.getByText(/at reply\.ts:42:7/)).toBeVisible();
  await expect.element(page.getByText(/full upstream response body/)).toBeVisible();

  await page.getByRole("button", { name: "Copy JSON" }).click();
  await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"correlationId": "turn-abc"'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"responseBody"'));
});

test("uses the full summary width for mobile log messages and metadata", async () => {
  await page.viewport(390, 844);
  render(<LogEntryRow log={log} labels={labels} showBotId />);

  const messageElement = await page.getByText(log.message, { exact: true }).findElement();
  const summaryElement = messageElement.closest("summary");
  expect(summaryElement).not.toBeNull();
  if (!summaryElement) throw new Error("Log message must remain inside its summary");

  const badgeElement = [...summaryElement.querySelectorAll("span")].find(
    (element) => element.textContent?.trim() === log.level,
  );
  const gridElement = badgeElement?.parentElement;
  const chevronElement = summaryElement.querySelector("svg");
  const metadataElement = summaryElement.querySelector("time")?.parentElement;
  expect(badgeElement).toBeDefined();
  expect(gridElement).not.toBeNull();
  expect(chevronElement).not.toBeNull();
  expect(metadataElement).not.toBeNull();
  if (!badgeElement || !gridElement || !chevronElement || !metadataElement) {
    throw new Error("Log summary must expose its level, disclosure icon, and metadata");
  }

  const summaryBounds = summaryElement.getBoundingClientRect();
  const gridBounds = gridElement.getBoundingClientRect();
  const firstColumnWidth = Number.parseFloat(
    getComputedStyle(gridElement).gridTemplateColumns.split(" ")[0] ?? "",
  );
  const badgeBounds = badgeElement.getBoundingClientRect();
  const chevronBounds = chevronElement.getBoundingClientRect();
  const messageBounds = messageElement.getBoundingClientRect();
  const metadataBounds = metadataElement.getBoundingClientRect();

  expect(Math.abs(badgeBounds.top - chevronBounds.top)).toBeLessThan(3);
  expect(firstColumnWidth).toBeGreaterThan(200);
  expect(badgeBounds.width).toBeGreaterThan(30);
  expect(badgeBounds.width).toBeLessThan(firstColumnWidth / 3);
  expect(badgeBounds.right).toBeLessThan(gridBounds.left + firstColumnWidth - 120);
  expect(messageBounds.width).toBeGreaterThan(300);
  expect(metadataBounds.width).toBeGreaterThan(300);
  expect(Math.abs(messageBounds.left - (summaryBounds.left + 16))).toBeLessThan(2);
  expect(Math.abs(metadataBounds.left - messageBounds.left)).toBeLessThan(2);
  expect(messageBounds.top).toBeGreaterThan(badgeBounds.bottom);
  expect(metadataBounds.top).toBeGreaterThan(messageBounds.bottom);
});

test("keeps the existing inline log summary layout on desktop", async () => {
  await page.viewport(1440, 900);
  render(<LogEntryRow log={log} labels={labels} />);

  const messageElement = await page.getByText(log.message, { exact: true }).findElement();
  const summaryElement = messageElement.closest("summary");
  expect(summaryElement).not.toBeNull();
  if (!summaryElement) throw new Error("Log message must remain inside its summary");

  const badgeElement = [...summaryElement.querySelectorAll("span")].find(
    (element) => element.textContent?.trim() === log.level,
  );
  const chevronElement = summaryElement.querySelector("svg");
  expect(badgeElement).toBeDefined();
  expect(chevronElement).not.toBeNull();
  if (!badgeElement || !chevronElement) {
    throw new Error("Log summary must expose its level and disclosure icon");
  }

  const badgeBounds = badgeElement.getBoundingClientRect();
  const chevronBounds = chevronElement.getBoundingClientRect();
  const messageBounds = messageElement.getBoundingClientRect();

  expect(Math.abs(badgeBounds.top - messageBounds.top)).toBeLessThan(4);
  expect(Math.abs(badgeBounds.top - chevronBounds.top)).toBeLessThan(4);
  expect(messageBounds.left).toBeGreaterThan(badgeBounds.right);
  expect(chevronBounds.left).toBeGreaterThan(messageBounds.right);
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
