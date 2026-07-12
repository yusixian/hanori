import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, test, vi } from "vitest";
import { BotDebuggerPage } from "./debugger";
import { buildDebugRunMarkdown, debugRunFilename } from "./debugger-export";

const failedRun = {
  id: "c4158486-1c69-4764-bbcd-f17faa81731e",
  source: "debugger",
  channel: "telegram",
  mode: "dry-run",
  status: "failed",
  failureReason: "provider_stream_failed",
  input: { text: "你好" },
  configSnapshot: { model: "gemini-3.1-flash-lite", apiKey: "[REDACTED]" },
  durationMs: 321,
  createdAt: "2026-07-12T18:27:20.000Z",
  events: [
    {
      sequence: 2,
      kind: "ai-error",
      level: "error",
      data: { statusCode: 400, responseBody: "upstream rejected the request" },
      createdAt: "2026-07-12T18:27:39.000Z",
    },
    {
      sequence: 1,
      kind: "run-started",
      level: "info",
      data: { mode: "dry-run" },
      createdAt: "2026-07-12T18:27:20.000Z",
    },
  ],
};

test("offers message and raw Channel event dry-runs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 })),
  );
  render(
    <MemoryRouter initialEntries={["/bots/test-id/debugger"]}>
      <Routes>
        <Route path="/bots/:botId/debugger" element={<BotDebuggerPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await expect.element(page.getByRole("heading", { name: "AI Debugger" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Raw Channel Event" })).toBeVisible();
  await page.getByRole("button", { name: "Raw Channel Event" }).click();
  await expect.element(page.getByLabelText("Raw channel event")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Run dry-run" })).toBeVisible();
});

test("builds an AI-oriented chronological Markdown export", () => {
  const markdown = buildDebugRunMarkdown(failedRun);
  expect(markdown).toContain("Identify the first root-cause error");
  expect(markdown).toContain('"failureReason": "provider_stream_failed"');
  expect(markdown).toContain('"apiKey": "[REDACTED]"');
  expect(markdown).toContain('"statusCode": 400');
  expect(markdown.indexOf("1. run-started")).toBeLessThan(markdown.indexOf("2. ai-error"));
  expect(debugRunFilename(failedRun)).toBe("ai-debug-run-c4158486-2026-07-12T18-27-20Z.md");
});
