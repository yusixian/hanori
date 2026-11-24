import "@/style.css";
import { i18n } from "@/i18n";
import { DEFAULT_BOT_MEMORY_CONFIG, type BotMemoryConfig } from "@cos-tool-bot/shared";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BotMemorySection } from "./ai-settings/sections/bot-memory-section";
import { MemoryReview } from "./memory-review";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.unstubAllGlobals());

test("reuses the exact report window and continues from the returned cursor on mobile", async () => {
  await page.viewport(390, 844);
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toContain("/api/bots/test-bot/memory/review");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      ok: true,
      data: {
        calls: 1,
        changes: 1,
        inputTokens: 230,
        outputTokens: 40,
        nextAfterMessageId: bodies.length === 1 ? 18 : null,
      },
    });
  });
  const summary = {
    chatId: -1001,
    windowStart: "2026-03-01T07:11:22.333Z",
    windowEnd: "2026-03-02T07:11:22.335Z",
  };
  render(<MemoryReview botId="test-bot" summary={summary} />);
  await page.getByRole("button", { name: "Review this group during the summary period" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Input tokens 230");
  await page.getByRole("button", { name: "Review next batch" }).click();
  await expect
    .element(page.getByRole("button", { name: "Review this group during the summary period" }))
    .toBeEnabled();
  const window = { chatId: "-1001", start: summary.windowStart, end: summary.windowEnd };
  expect(bodies).toEqual([window, { ...window, afterMessageId: 18 }]);
});

test("shows the 12-hour default, dedicated provider, and last run usage on desktop", async () => {
  await page.viewport(1440, 900);
  vi.stubGlobal("fetch", async () =>
    Response.json({
      ok: true,
      data: {
        lastRun: {
          calls: 3,
          changes: 2,
          inputTokens: 420,
          outputTokens: 51,
          finishedAt: "2026-04-01T12:00:00Z",
        },
      },
    }),
  );
  function Fixture() {
    const [config, setConfig] = useState<BotMemoryConfig>({
      ...DEFAULT_BOT_MEMORY_CONFIG,
      enabled: true,
    });
    return (
      <BotMemorySection
        config={config}
        botId="test-bot"
        canManage
        providers={[
          {
            id: "budget",
            label: "Budget provider",
            defaultModel: "small",
            hasApiKey: true,
            providerFormat: "openai",
            baseURL: "https://example.com/v1",
          },
        ]}
        onUpdate={(change) => setConfig({ ...config, ...change })}
      />
    );
  }
  render(<Fixture />);
  await expect
    .element(page.getByRole("spinbutton", { name: "Hours between reviews" }))
    .toHaveValue(12);
  await expect
    .element(page.getByRole("spinbutton", { name: "Maximum model calls per run" }))
    .toHaveValue(4);
  await expect
    .element(page.getByText(/3 model calls · 2 memory changes · 420 input/))
    .toBeVisible();
  const timeout = page.getByRole("spinbutton", { name: "Review model timeout (seconds)" });
  await expect.element(timeout).toHaveValue(120);
  await timeout.fill("240");
  await expect.element(timeout).toHaveValue(240);
  await page.getByRole("combobox", { name: "Review provider" }).click();
  await page.getByRole("option", { name: "Budget provider" }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Review model" }))
    .toHaveTextContent("small");
  await expect
    .element(page.getByRole("button", { name: "Review messages", exact: true }))
    .toBeDisabled();
});

test("selects a group and reviews the last seven days using original chat messages", async () => {
  const bodies: Array<{ chatId: string; start: string; end: string; afterMessageId?: number }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/conversations"))
      return Response.json({
        ok: true,
        data: [
          { chatType: "group", chatId: -1002, userNames: ["Second"] },
          { chatType: "private", chatId: 123, userNames: ["Private"] },
          { chatType: "group", chatId: -1001, userNames: ["Alex", "Sam"] },
        ],
      });
    if (init?.method !== "POST") return Response.json({ ok: true, data: { lastRun: null } });
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({
      ok: true,
      data: {
        calls: 0,
        changes: 0,
        inputTokens: 0,
        outputTokens: 0,
        nextAfterMessageId: bodies.length === 1 ? 9 : null,
      },
    });
  });
  render(<MemoryReview botId="test-bot" />);
  await page.getByRole("combobox", { name: "Group to review" }).click();
  await expect.element(page.getByRole("option", { name: /Private/ })).not.toBeInTheDocument();
  await page.getByRole("option", { name: /Alex, Sam/ }).click();
  await page.getByRole("button", { name: "Add group" }).click();
  await page.getByRole("combobox", { name: "Group to review" }).nth(1).click();
  await page.getByRole("option", { name: /Second/ }).click();
  await page.getByRole("button", { name: "Review messages", exact: true }).click();
  await expect.element(page.getByRole("status").nth(1)).toHaveTextContent("0 model calls");
  await page.getByRole("button", { name: "Review next batch" }).click();
  await expect
    .element(page.getByRole("button", { name: "Review messages", exact: true }))
    .toBeEnabled();
  expect(bodies.map((b) => [b.chatId, b.afterMessageId])).toEqual([
    ["-1001", undefined],
    ["-1002", undefined],
    ["-1001", 9],
  ]);
  expect(bodies[0]?.chatId).toBe("-1001");
  expect(Date.parse(bodies[0]!.end) - Date.parse(bodies[0]!.start)).toBe(7 * 86_400_000);
});
