import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { UsagePage } from "./index";

interface PendingRequest {
  url: URL;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}
let requests: PendingRequest[];
let botRequests: URL[];
const response = (data: unknown, ok = true, status = 200) =>
  new Response(JSON.stringify({ ok, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
const botResponse = (data: unknown[], total = data.length, ok = true, status = 200) =>
  new Response(JSON.stringify({ ok, data, total }), {
    status,
    headers: { "content-type": "application/json" },
  });
const metrics = (value: number) => ({
  totalTokens: value,
  promptTokens: value - 1,
  completionTokens: 1,
  requestCount: value - 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheObservedRequestCount: 0,
  cacheWriteObservedRequestCount: 0,
  cacheHitRequestCount: 0,
  cacheObservationRate: null,
  cacheTokenHitRate: null,
  cacheRequestHitRate: null,
});
const isHeatmap = (request: PendingRequest) =>
  request.url.pathname.endsWith("/trend") &&
  Date.now() - new Date(request.url.searchParams.get("from")!).getTime() > 360 * 86400000;
const stats = () => requests.filter((request) => !isHeatmap(request));
const heatmaps = () => requests.filter(isHeatmap);
const comparisons = () => stats().filter((request) => request.url.pathname.endsWith("/by-bot"));
const filteredStats = () => stats().filter((request) => !request.url.pathname.endsWith("/by-bot"));
function completeStats(batch: PendingRequest[], value: number) {
  for (const request of batch) {
    const endpoint = request.url.pathname.split("/").at(-1);
    const data =
      endpoint === "summary"
        ? metrics(value)
        : endpoint === "by-model"
          ? [{ model: `Model ${value}`, ...metrics(value) }]
          : endpoint === "by-bot"
            ? [{ botId: "a", botName: `Bot ${value}`, ...metrics(value) }]
            : [
                {
                  date: new Date(2026, 0, value === 111 ? 1 : 2, 12).toISOString(),
                  ...metrics(value),
                },
              ];
    request.resolve(response(data));
  }
}
function heatmapData(value: number) {
  const date = new Date();
  date.setDate(date.getDate() - 10);
  return [{ date: date.toISOString(), totalTokens: value }];
}
async function flushResponses() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
async function selectBot(name: string) {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name, exact: true }).click();
}
async function start() {
  render(
    <main style={{ padding: 16 }}>
      <UsagePage />
    </main>,
  );
  await vi.waitFor(() => expect(requests).toHaveLength(5));
}
async function initialSuccess() {
  await start();
  completeStats(stats(), 111);
  heatmaps()[0]!.resolve(response(heatmapData(10)));
  await expect.element(page.getByText("111", { exact: true })).toBeVisible();
}
beforeEach(async () => {
  requests = [];
  botRequests = [];
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), location.origin);
      if (url.pathname === "/api/bots") {
        botRequests.push(url);
        return Promise.resolve(
          botResponse([
            { id: "a", name: "Alpha" },
            { id: "b", name: "Beta" },
          ]),
        );
      }
      return new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("late old responses cannot overwrite the current filter", async () => {
  await start();
  const old = stats().slice();
  heatmaps()[0]!.resolve(response([]));
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await vi.waitFor(() => expect(stats()).toHaveLength(8));
  completeStats(stats().slice(4), 222);
  await expect.element(page.getByText("222", { exact: true })).toBeVisible();
  const chartLabels = () =>
    Array.from(document.querySelectorAll(".recharts-cartesian-axis-tick-value")).map(
      (node) => node.textContent,
    );
  await vi.waitFor(() =>
    expect(chartLabels()).toEqual(expect.arrayContaining(["Model 222", "Bot 222", "1/2"])),
  );
  completeStats(old, 111);
  await flushResponses();
  expect(chartLabels()).toEqual(expect.arrayContaining(["Model 222", "Bot 222", "1/2"]));
  expect(chartLabels()).not.toEqual(expect.arrayContaining(["Model 111"]));
  expect(chartLabels()).not.toContain("Bot 111");
  expect(chartLabels()).not.toContain("1/1");
  await expect.element(page.getByText("222", { exact: true })).toBeVisible();
  await expect.element(page.getByText("111", { exact: true })).not.toBeInTheDocument();
});

test("a failed new filter hides old data and supports retry", async () => {
  await initialSuccess();
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await vi.waitFor(() => expect(stats()).toHaveLength(8));
  stats()[4]!.reject(new Error("offline"));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Usage data could not be loaded.");
  await expect.element(page.getByText("111", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await vi.waitFor(() => expect(stats()).toHaveLength(11));
  expect(document.querySelectorAll('[role="status"]')).toHaveLength(2);
  completeStats(stats().slice(8), 333);
  await expect.element(page.getByText("333", { exact: true })).toBeVisible();
  expect(heatmaps()).toHaveLength(1);
});

test("old completions cannot clear the current loading state", async () => {
  await start();
  const old = stats().slice();
  heatmaps()[0]!.resolve(response([]));
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await vi.waitFor(() => expect(stats()).toHaveLength(8));
  completeStats(old, 111);
  await flushResponses();
  expect(document.querySelectorAll('[role="status"]')).toHaveLength(2);
  await expect.element(page.getByText("111", { exact: true })).not.toBeInTheDocument();
  completeStats(stats().slice(4), 222);
  await expect.element(page.getByText("222", { exact: true })).toBeVisible();
});

for (const failure of ["http", "application", "json"] as const) {
  test(`treats ${failure} failure as an error for the whole statistics group`, async () => {
    await initialSuccess();
    await page.getByRole("button", { name: "90d", exact: true }).click();
    await vi.waitFor(() => expect(stats()).toHaveLength(8));
    const batch = stats().slice(4);
    const model = batch.find((request) => request.url.pathname.endsWith("/by-model"))!;
    model.resolve(
      failure === "http"
        ? response([], true, 503)
        : failure === "application"
          ? response([], false)
          : new Response("invalid json"),
    );
    completeStats(
      batch.filter((request) => request !== model),
      222,
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Usage data could not be loaded.");
    await expect.element(page.getByText("111", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("222", { exact: true })).not.toBeInTheDocument();
  });
}

test("late old failures cannot replace a newer success with an error", async () => {
  await start();
  const old = stats().slice();
  heatmaps()[0]!.resolve(response([]));
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await vi.waitFor(() => expect(stats()).toHaveLength(8));
  completeStats(stats().slice(4), 222);
  await expect.element(page.getByText("222", { exact: true })).toBeVisible();
  old[0]!.reject(new Error("old failure"));
  await flushResponses();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(page.getByText("222", { exact: true })).toBeVisible();
});

test("heatmap keeps the latest bot and ignores an older empty response", async () => {
  await start();
  completeStats(stats(), 111);
  await selectBot("Alpha");
  await vi.waitFor(() => expect(heatmaps()).toHaveLength(2));
  completeStats(stats().slice(4), 222);
  heatmaps()[1]!.resolve(response(heatmapData(42)));
  await expect.element(page.getByText("Less", { exact: true })).toBeVisible();
  heatmaps()[0]!.resolve(response([]));
  await flushResponses();
  await expect.element(page.getByText("Less", { exact: true })).toBeVisible();
  await expect.element(page.getByText("No usage data", { exact: true })).not.toBeInTheDocument();
  for (const request of stats().slice(4)) expect(request.url.searchParams.get("botId")).toBe("a");
  expect(comparisons()).toHaveLength(1);
  expect(heatmaps()[1]!.url.searchParams.get("botId")).toBe("a");
  expect(heatmaps()[1]!.url.searchParams.get("granularity")).toBe("day");
});

test("old heatmap failure cannot end loading for the new bot", async () => {
  await start();
  completeStats(stats(), 111);
  await selectBot("Beta");
  await vi.waitFor(() => expect(heatmaps()).toHaveLength(2));
  completeStats(stats().slice(4), 222);
  await expect.element(page.getByText("222", { exact: true })).toBeVisible();
  heatmaps()[0]!.reject(new Error("old heatmap"));
  await flushResponses();
  await expect.element(page.getByRole("status")).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  heatmaps()[1]!.resolve(response(heatmapData(42)));
  await expect.element(page.getByText("Less", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
});

for (const failure of ["http", "application", "network"] as const) {
  test(`heatmap ${failure} failure has an independent retry`, async () => {
    await initialSuccess();
    await selectBot("Alpha");
    await vi.waitFor(() => expect(heatmaps()).toHaveLength(2));
    completeStats(stats().slice(4), 222);
    const request = heatmaps()[1]!;
    if (failure === "network") request.reject(new Error("offline"));
    else request.resolve(response([], failure !== "application", failure === "http" ? 503 : 200));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Daily activity could not be loaded.");
    await expect.element(page.getByText("Less", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("222", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await vi.waitFor(() => expect(heatmaps()).toHaveLength(3));
    await expect.element(page.getByRole("status")).toBeVisible();
    heatmaps()[2]!.resolve(response(heatmapData(42)));
    await expect.element(page.getByText("Less", { exact: true })).toBeVisible();
    expect(stats()).toHaveLength(7);
    expect(heatmaps()[2]!.url.searchParams.get("botId")).toBe("a");
  });
}

for (const width of [1440, 390]) {
  test(`${width}px supports loading, error, retry without page overflow`, async () => {
    await page.viewport(width, width === 390 ? 844 : 900);
    await i18n.changeLanguage("zh-CN");
    await start();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(3);
    completeStats(stats(), 111);
    heatmaps()[0]!.resolve(response(heatmapData(42)));
    await expect.element(page.getByText("111", { exact: true })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await page.getByRole("button", { name: "30 天", exact: true }).click();
    await vi.waitFor(() => expect(stats()).toHaveLength(8));
    stats()[4]!.reject(new Error("offline"));
    await expect.element(page.getByRole("alert")).toHaveTextContent("用量数据加载失败。");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await vi.waitFor(() => expect(stats()).toHaveLength(11));
    completeStats(stats().slice(8), 333);
    await expect.element(page.getByText("333", { exact: true })).toBeVisible();
    expect(heatmaps()).toHaveLength(1);
  });
}

test("a late old success cannot hide the current filter error", async () => {
  await start();
  const old = stats().slice();
  heatmaps()[0]!.resolve(response([]));
  await page.getByRole("button", { name: "30d", exact: true }).click();
  await vi.waitFor(() => expect(stats()).toHaveLength(8));
  stats()[4]!.reject(new Error("current failure"));
  await expect.element(page.getByRole("alert")).toBeVisible();
  completeStats(old, 111);
  await flushResponses();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Usage data could not be loaded.");
  await expect.element(page.getByText("111", { exact: true })).not.toBeInTheDocument();
});

test("a failed bot list can be retried independently of usage data", async () => {
  vi.mocked(fetch).mockImplementationOnce(() => Promise.resolve(botResponse([], 0, false)));
  await initialSuccess();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Bot filters could not be loaded.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(requests).toHaveLength(5);
  await page.getByRole("combobox").click();
  await expect.element(page.getByRole("option", { name: "Alpha", exact: true })).toBeVisible();
});

test("loads every Bot filter page before publishing 125 options", async () => {
  const bots = Array.from({ length: 125 }, (_, index) => ({
    id: `bot-${index + 1}`,
    name: `Bot ${index + 1}`,
  }));
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === "/api/bots") {
      botRequests.push(url);
      const pageNumber = Number(url.searchParams.get("page"));
      const startIndex = (pageNumber - 1) * 100;
      return Promise.resolve(botResponse(bots.slice(startIndex, startIndex + 100), bots.length));
    }
    return new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }));
  });

  await start();
  await page.getByRole("combobox").click();
  await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(126));
  expect(botRequests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
  expect(botRequests.every((url) => url.searchParams.get("limit") === "100")).toBe(true);
  await expect.element(page.getByRole("option", { name: "Bot 125", exact: true })).toBeVisible();
});

test("keeps a long selected Bot name inside the filter trigger", async () => {
  const longName = `Bot ${"with-a-very-long-name-".repeat(14)}`;
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === "/api/bots")
      return Promise.resolve(botResponse([{ id: "long", name: longName }]));
    return new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }));
  });

  await start();
  await selectBot(longName);
  const trigger = document.querySelector<HTMLElement>('[role="combobox"]')!;
  const value = trigger.querySelector<HTMLElement>(":scope > span:first-child")!;
  expect(value.getBoundingClientRect().height).toBeLessThanOrEqual(
    trigger.getBoundingClientRect().height,
  );
  expect(value.scrollWidth).toBeGreaterThan(value.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

test("keeps Bot filters atomic when the total changes on page two and retries", async () => {
  const bots = Array.from({ length: 125 }, (_, index) => ({
    id: `bot-${index + 1}`,
    name: `Bot ${index + 1}`,
  }));
  let pageTwoAttempts = 0;
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === "/api/bots") {
      botRequests.push(url);
      const pageNumber = Number(url.searchParams.get("page"));
      if (pageNumber === 2 && pageTwoAttempts++ === 0) {
        return Promise.resolve(botResponse(bots.slice(100), bots.length - 1));
      }
      const startIndex = (pageNumber - 1) * 100;
      return Promise.resolve(botResponse(bots.slice(startIndex, startIndex + 100), bots.length));
    }
    return new Promise<Response>((resolve, reject) => requests.push({ url, resolve, reject }));
  });

  await start();
  completeStats(stats(), 111);
  heatmaps()[0]!.resolve(response([]));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Bot filters could not be loaded.");
  await page.getByRole("combobox").click();
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  await expect
    .element(page.getByRole("option", { name: "Bot 1", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("option", { name: "All Bots", exact: true }).click();

  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await vi.waitFor(() => expect(botRequests).toHaveLength(4));
  expect(botRequests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", "1", "2"]);
  await page.getByRole("combobox").click();
  await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(126));
  await expect.element(page.getByRole("option", { name: "Bot 125", exact: true })).toBeVisible();
});

test("keeps the all-Bot comparison visible when filtered statistics fail", async () => {
  await start();
  comparisons()[0]!.resolve(
    response([{ botId: "global", botName: "Global Bot", ...metrics(444) }]),
  );
  filteredStats()[0]!.reject(new Error("offline"));
  heatmaps()[0]!.resolve(response([]));

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Usage data could not be loaded.");
  await vi.waitFor(() =>
    expect(
      Array.from(document.querySelectorAll(".recharts-cartesian-axis-tick-value")).map(
        (node) => node.textContent,
      ),
    ).toContain("Global Bot"),
  );
  await expect.element(page.getByText("All Bots comparison", { exact: true })).toBeVisible();
});

test("retries an all-Bot comparison error without hiding filtered statistics", async () => {
  await start();
  comparisons()[0]!.reject(new Error("offline"));
  completeStats(filteredStats(), 111);
  heatmaps()[0]!.resolve(response([]));

  await expect.element(page.getByText("111", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The all-Bot comparison could not be loaded.");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await vi.waitFor(() => expect(comparisons()).toHaveLength(2));
  comparisons()[1]!.resolve(response([{ botId: "a", botName: "Alpha", ...metrics(222) }]));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(page.getByText("111", { exact: true })).toBeVisible();
});

test("preserves 7/30/90 day global comparisons and an independent 365 day heatmap", async () => {
  await start();
  const expectedHeatmapFrom = new Date();
  expectedHeatmapFrom.setDate(expectedHeatmapFrom.getDate() - 365);
  expect(
    Math.abs(
      new Date(heatmaps()[0]!.url.searchParams.get("from")!).getTime() -
        expectedHeatmapFrom.getTime(),
    ),
  ).toBeLessThan(2000);
  for (const [index, days] of [7, 30, 90].entries()) {
    if (days !== 7) await page.getByRole("button", { name: `${days}d`, exact: true }).click();
    await vi.waitFor(() => expect(stats()).toHaveLength((index + 1) * 4));
    const batch = stats().slice(index * 4, (index + 1) * 4);
    const from = batch[0]!.url.searchParams.get("from");
    const expectedFrom = new Date();
    expectedFrom.setDate(expectedFrom.getDate() - days);
    expect(Math.abs(new Date(from!).getTime() - expectedFrom.getTime())).toBeLessThan(2000);
    const comparison = batch.find((request) => request.url.pathname.endsWith("/by-bot"))!;
    for (const request of batch.filter((request) => request !== comparison)) {
      expect(request.url.searchParams.get("from")).toBe(from);
    }
    expect(
      Math.abs(
        new Date(comparison.url.searchParams.get("from")!).getTime() - new Date(from!).getTime(),
      ),
    ).toBeLessThan(100);
    expect(comparison.url.searchParams.has("botId")).toBe(false);
    expect(
      batch
        .find((request) => request.url.pathname.endsWith("/trend"))!
        .url.searchParams.get("granularity"),
    ).toBe(days === 7 ? "hour" : "day");
  }
  expect(heatmaps()).toHaveLength(1);
});
