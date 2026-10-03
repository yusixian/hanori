import "@/style.css";
import { i18n } from "@/i18n";
import { triggerDownload } from "@/lib/download";
import type { MediaJobView } from "@cos-tool-bot/shared";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { MediaJobsPanel } from "./media-jobs";
import type { MediaJobsApi, MediaJobsList, MediaTranscriptPage } from "./media-jobs-api";

vi.mock("@/lib/download", () => ({ triggerDownload: vi.fn() }));
const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function job(id = firstId, overrides: Partial<MediaJobView> = {}): MediaJobView {
  return {
    id,
    title: id === firstId ? "First video" : "Second video",
    sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    part: 1,
    durationSeconds: 60,
    status: "completed",
    progress: 100,
    error: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    expiresAt: "2026-10-03T00:00:00.000Z",
    language: "zh",
    source: "asr",
    notification: "sent",
    ...overrides,
  };
}
function transcript(
  text = "First transcript",
  overrides: Partial<MediaTranscriptPage> = {},
): MediaTranscriptPage {
  return {
    status: "available",
    source: "asr",
    track: "original",
    language: "zh",
    cues: [{ startMs: 0, endMs: 1000, text, cueIndex: 0 }],
    offset: 0,
    total: 1,
    nextOffset: null,
    hasMore: false,
    textTruncated: false,
    ...overrides,
  };
}
function api(overrides: Partial<MediaJobsApi> = {}): MediaJobsApi {
  return {
    list: vi.fn(async () => ({ data: [job()], available: true, allowExport: true })),
    cancel: vi.fn(async (_botId, id) => job(id, { status: "cancelled" })),
    transcript: vi.fn(async () => transcript()),
    export: vi.fn(async () => new Blob(["synthetic subtitles"], { type: "text/plain" })),
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1024, 900);
  vi.clearAllMocks();
});

test("shows pending consent and cloud cancellation honestly on mobile", async () => {
  await page.viewport(390, 844);
  const input = api({
    list: vi.fn(async () => ({
      data: [
        job(firstId, { status: "pending_confirmation", progress: 0 }),
        job(secondId, { status: "failed", error: "provider_cancellation_unavailable" }),
      ],
      available: true,
      allowExport: false,
    })),
  });
  render(<MediaJobsPanel botId="bot-1" api={input} />);
  await expect
    .element(page.getByText("Awaiting administrator confirmation", { exact: false }))
    .toBeVisible();
  await expect
    .element(
      page.getByText("Local waiting stopped; the cloud task may continue and incur charges."),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Cancel job", exact: true }).click();
  expect(input.cancel).toHaveBeenCalledWith("bot-1", firstId);
});

test("loads transcript pages and literal keyword results without loading bodies into the job list", async () => {
  const input = api({
    transcript: vi.fn(async (_botId, _id, options) =>
      options.query
        ? transcript("matching keyword")
        : options.offset
          ? transcript("Second page", { offset: 40, total: 41 })
          : transcript("First page", { nextOffset: 40, hasMore: true, total: 41 }),
    ),
  });
  render(<MediaJobsPanel botId="bot-1" api={input} />);
  await expect.element(page.getByText("First video", { exact: true })).toBeVisible();
  expect(input.transcript).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "View transcript" }).click();
  await expect.element(page.getByText("First page", { exact: true })).toBeVisible();
  expect(input.transcript).toHaveBeenLastCalledWith("bot-1", firstId, { offset: 0, limit: 40 });
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.element(page.getByText("Second page", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect.element(page.getByText("First page", { exact: true })).toBeVisible();
  await page.getByLabelText("Keyword").fill(" keyword ");
  await page.getByRole("button", { name: "Search transcript" }).click();
  await expect.element(page.getByText("matching keyword", { exact: true })).toBeVisible();
  expect(input.transcript).toHaveBeenLastCalledWith("bot-1", firstId, {
    offset: 0,
    limit: 40,
    query: "keyword",
  });
  await expect.element(page.getByRole("button", { name: "Next page" })).toBeDisabled();
});

test("requires rights for each job and suppresses a download response after switching jobs", async () => {
  const pending = deferred<Blob>();
  const input = api({
    list: vi.fn(async () => ({ data: [job(), job(secondId)], available: true, allowExport: true })),
    export: vi.fn(() => pending.promise),
  });
  render(<MediaJobsPanel botId="bot-1" api={input} />);
  await page.getByRole("button", { name: "View transcript" }).nth(0).click();
  await expect.element(page.getByRole("button", { name: "Download SRT" })).toBeDisabled();
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Download SRT" }).click();
  expect(input.export).toHaveBeenCalledWith("bot-1", firstId, "srt");
  await page.getByRole("button", { name: "View transcript" }).nth(1).click();
  await expect.element(page.getByRole("checkbox")).not.toBeChecked();
  pending.resolve(new Blob(["old job result"]));
  await expect.element(page.getByRole("button", { name: "Download SRT" })).toBeDisabled();
  expect(triggerDownload).not.toHaveBeenCalled();
});

test("downloads the authorized current job and honors disabled export configuration", async () => {
  const input = api();
  const view = await render(<MediaJobsPanel botId="bot-1" api={input} />);
  await page.getByRole("button", { name: "View transcript" }).click();
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Download VTT" }).click();
  await expect.poll(() => vi.mocked(triggerDownload).mock.calls.length).toBe(1);
  expect(triggerDownload).toHaveBeenCalledWith(expect.any(Blob), `transcript-${firstId}.vtt`);
  await view.unmount();
  const restricted = api({
    list: vi.fn(async () => ({ data: [job()], available: true, allowExport: false })),
  });
  render(<MediaJobsPanel botId="bot-1" api={restricted} />);
  await page.getByRole("button", { name: "View transcript" }).click();
  await expect.element(page.getByText(/downloads are disabled/)).toBeVisible();
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Download SRT" })).not.toBeInTheDocument();
  expect(restricted.export).not.toHaveBeenCalled();
});

test("ignores obsolete transcript and Bot list responses", async () => {
  const oldTranscript = deferred<MediaTranscriptPage>();
  const oldList = deferred<MediaJobsList>();
  const input = api({
    list: vi.fn(async (botId) =>
      botId === "bot-old"
        ? oldList.promise
        : { data: [job(), job(secondId)], available: true, allowExport: true },
    ),
    transcript: vi.fn(async (_botId, id) =>
      id === firstId ? oldTranscript.promise : transcript("Current job body"),
    ),
  });
  const view = await render(<MediaJobsPanel botId="bot-old" api={input} />);
  await expect.poll(() => vi.mocked(input.list).mock.calls.length).toBe(1);
  await view.rerender(<MediaJobsPanel botId="bot-current" api={input} />);
  await page.getByRole("button", { name: "View transcript" }).nth(0).click();
  await page.getByRole("button", { name: "View transcript" }).nth(1).click();
  await expect.element(page.getByText("Current job body", { exact: true })).toBeVisible();
  oldTranscript.resolve(transcript("Obsolete private body"));
  oldList.resolve({
    data: [job(firstId, { title: "Obsolete Bot title" })],
    available: false,
    allowExport: false,
  });
  await expect.element(page.getByText("Current job body", { exact: true })).toBeVisible();
  expect(document.body.textContent).not.toContain("Obsolete private body");
  expect(document.body.textContent).not.toContain("Obsolete Bot title");
});

test("cancels running work and refreshes status even when transcription configuration is disabled", async () => {
  let cancelled = false;
  const input = api({
    list: vi.fn(async () => ({
      data: [job(firstId, { status: cancelled ? "cancelled" : "transcribing", progress: 70 })],
      available: false,
      allowExport: false,
    })),
    cancel: vi.fn(async () => {
      cancelled = true;
      return job(firstId, { status: "cancelled" });
    }),
  });
  render(<MediaJobsPanel botId="bot-1" api={input} />);
  await page.getByRole("button", { name: "Cancel job" }).click();
  expect(input.cancel).toHaveBeenCalledWith("bot-1", firstId);
  await expect.element(page.getByText("Cancelled · 70%", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Cancel job" })).not.toBeInTheDocument();
  expect(input.list).toHaveBeenCalledTimes(2);
});

test("bounds transcript preview on a narrow viewport and renders safe errors without raw provider messages", async () => {
  await page.viewport(390, 844);
  const input = api({ transcript: vi.fn(async () => transcript("X".repeat(6000))) });
  render(<MediaJobsPanel botId="bot-1" api={input} />);
  await page.getByRole("button", { name: "View transcript" }).click();
  await expect.element(page.getByText(/preview is limited to 40 cues/)).toBeVisible();
  expect(document.body.textContent).toContain("X".repeat(4000));
  expect(document.body.textContent).not.toContain("X".repeat(4001));
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  vi.mocked(input.transcript).mockRejectedValueOnce(new Error("private-provider-key=unsafe"));
  await page.getByLabelText("Keyword").fill("next query");
  await page.getByRole("button", { name: "Search transcript" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The transcript could not be loaded or exported");
  expect(document.body.textContent).not.toContain("private-provider-key");
});
