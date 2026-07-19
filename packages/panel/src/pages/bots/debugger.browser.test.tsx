import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import { BotDebuggerPage } from "./debugger";
import { buildDebugRunMarkdown, debugRunFilename } from "./debugger-export";

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly close = vi.fn();
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>();

  constructor(readonly url: string | URL) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string) {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  MockEventSource.instances = [];
  vi.unstubAllGlobals();
});

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

test("strictly sends a custom Telegram Rich Message from the debugger", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/debug/rich-messages") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: { messageId: 77, chatId: 123456789, format: "markdown" },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/bots/test-id/debugger"]}>
      <Routes>
        <Route path="/bots/:botId/debugger" element={<BotDebuggerPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await expect.element(page.getByText("Telegram Rich Message Test")).toBeVisible();
  await page.getByPlaceholder("For example, 123456789 or -1001234567890").fill("123456789");
  await page.getByRole("button", { name: "Send real Rich Message" }).click();

  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Sent: message_id=77 · chat_id=123456789 · markdown");
  const request = fetchMock.mock.calls.find(([input]) =>
    String(input).endsWith("/debug/rich-messages"),
  );
  expect(request?.[1]).toMatchObject({ method: "POST" });
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
    chatId: "123456789",
    format: "markdown",
  });
});

test("keeps a running stream open across transient errors and closes it on completion", async () => {
  const runningRun = {
    ...failedRun,
    status: "running",
    failureReason: null,
    durationMs: null,
    events: [],
  };
  const succeededRun = { ...runningRun, status: "succeeded", durationMs: 420 };
  let completed = false;

  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isDetail = url.endsWith(`/runs/${runningRun.id}`);
      const data = isDetail ? (completed ? succeededRun : runningRun) : [runningRun];
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    }),
  );

  render(
    <MemoryRouter initialEntries={["/bots/test-id/debugger"]}>
      <Routes>
        <Route path="/bots/:botId/debugger" element={<BotDebuggerPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await page.getByRole("button", { name: new RegExp(runningRun.id.slice(0, 8)) }).click();
  await expect.poll(() => MockEventSource.instances.length).toBe(1);
  const source = MockEventSource.instances[0]!;

  source.emitError();
  expect(source.close).not.toHaveBeenCalled();

  completed = true;
  source.emit("bot-run-complete");
  expect(source.close).toHaveBeenCalledOnce();
  await expect.element(page.getByText("Succeeded", { exact: true })).toBeVisible();
});

test("builds an AI-oriented chronological Markdown export", () => {
  const markdown = buildDebugRunMarkdown(failedRun, i18n.getFixedT("en", "botData"));
  expect(markdown).toContain("Identify the first root-cause error");
  expect(markdown).toContain('"failureReason": "provider_stream_failed"');
  expect(markdown).toContain('"apiKey": "[REDACTED]"');
  expect(markdown).toContain('"statusCode": 400');
  expect(markdown.indexOf("1. run-started")).toBeLessThan(markdown.indexOf("2. ai-error"));
  expect(debugRunFilename(failedRun)).toBe("ai-debug-run-c4158486-2026-07-12T18-27-20Z.md");
});
