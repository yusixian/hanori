import { i18n } from "@/i18n";
import { engagementSamples } from "@/i18n/locales/en/engagement-samples";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { EngagementSamplesSection } from "./engagement-samples-section";

const sample = {
  id: 17,
  chatId: -100123,
  messageId: 41,
  mode: "shadow",
  style: "natural",
  choice: "join",
  engagement: "silent",
  confidence: 0.6,
  probabilities: { answer: 0.6, silent: 0.4, addressed: 0.2, continue: 0.3, join: 0.5 },
  reasonCode: "below_threshold",
  actualTrigger: "random",
  model: "jev-1.13.0",
  configVersion: "policy-7",
  configSnapshot: {
    mode: "shadow",
    style: "natural",
    preferences: "Keep jokes light",
    keywordDirect: false,
    cooldownSeconds: 60,
    confidenceThreshold: 0.8,
    contextMessages: 20,
    timeoutMs: 1000,
  },
  latencyMs: 87,
  inputTokens: 120,
  estimatedCostUsd: 0.00042,
  context: null,
  contextExpiresAt: "2026-09-20T00:00:00.000Z",
  contextPurgedAt: "2026-09-20T00:00:00.000Z",
  pricingSource: "typesafe-official-pricing-manual",
  pricingSourceUrl: "https://docs.typesafe.ai/models",
  pricingObservedAt: "2026-09-21T00:00:00.000Z",
  errorCategory: "timeout",
  label: null,
  createdAt: "2026-09-21T08:00:00.000Z",
};

const legacySample = {
  ...sample,
  id: 16,
  messageId: 40,
  choice: "continue",
  engagement: "answer",
  confidence: 0.88,
  probabilities: { continue: 0.88, join: 0.07, silent: 0.05 },
  reasonCode: "jev_answer",
  actualTrigger: null,
};

const twoRouteSample = {
  ...sample,
  id: 15,
  messageId: 39,
  engagement: "answer",
  confidence: 0.9,
  probabilities: { answer: 0.9, silent: 0.1, continue: 0.45, join: 0.55 },
  reasonCode: "jev_answer",
  actualTrigger: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  i18n.addResourceBundle("en", "aiSettings", { engagementSamples }, true, true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("reviews expired shadow samples, filters them, labels them, and paginates", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let currentLabel: "answer" | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/engagement-samples/17") && init?.method === "PATCH") {
      expect(JSON.parse(String(init.body))).toEqual({ label: "answer" });
      currentLabel = "answer";
      return response({ ok: true, data: { ...sample, label: currentLabel } });
    }
    if (url.includes("/engagement-samples")) {
      const parsed = new URL(url, window.location.origin);
      const secondPage = parsed.searchParams.get("page") === "2";
      return response({
        ok: true,
        items: secondPage
          ? [{ ...sample, id: 18, messageId: 42, context: [] }]
          : [{ ...sample, label: currentLabel }, twoRouteSample, legacySample],
        total: 21,
        page: secondPage ? 2 : 1,
        pageSize: 20,
        metrics: {
          total: 21,
          labeledCount: 1,
          evaluatedCount: 1,
          latencyP95Ms: 112,
          classifierCostUsd: 0.0012,
          classifierCostKnownCount: 3,
          classifierCostUnknownCount: 2,
        },
      });
    }
    return response({ ok: false, error: "Not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<EngagementSamplesSection botId="bot-1" />);

  await expect
    .element(page.getByRole("heading", { name: "Engagement review samples" }))
    .toBeVisible();
  const currentSampleRow = page.getByRole("article").nth(0);
  const twoRouteSampleRow = page.getByRole("article").nth(1);
  const legacySampleRow = page.getByRole("article").nth(2);
  await expect
    .element(currentSampleRow.getByText("Context expired", { exact: true }))
    .toBeVisible();
  await expect
    .element(currentSampleRow.getByText("Participation route: Join", { exact: true }))
    .toBeVisible();
  await expect
    .element(currentSampleRow.getByText("Policy result: silent", { exact: true }))
    .toBeVisible();
  await expect
    .element(currentSampleRow.getByText("Reply actually admitted", { exact: true }))
    .toBeVisible();
  await expect
    .element(currentSampleRow.getByText("Reply-decision confidence: 60%", { exact: true }))
    .toBeVisible();
  await expect.element(currentSampleRow.getByText("Reply 60%", { exact: true })).toBeVisible();
  await expect.element(currentSampleRow.getByText("Silent 40%", { exact: true })).toBeVisible();
  await expect
    .element(currentSampleRow.getByText("Direct address 20%", { exact: true }))
    .toBeVisible();
  await expect.element(currentSampleRow.getByText("Continue 30%", { exact: true })).toBeVisible();
  await expect.element(currentSampleRow.getByText("Join 50%", { exact: true })).toBeVisible();
  await expect
    .element(
      currentSampleRow.getByText(
        "Below policy threshold: reply-decision confidence 60%, 80% required",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect
    .element(twoRouteSampleRow.getByText("Direct address —", { exact: true }))
    .toBeVisible();
  await expect
    .element(legacySampleRow.getByText("Legacy JEV choice: Continue", { exact: true }))
    .toBeVisible();
  await expect
    .element(legacySampleRow.getByText("Legacy choice confidence: 88%", { exact: true }))
    .toBeVisible();
  await expect
    .element(legacySampleRow.getByText("Legacy model probabilities", { exact: true }))
    .toBeVisible();
  await expect.element(legacySampleRow.getByText("Continue 88%", { exact: true })).toBeVisible();
  await expect.element(legacySampleRow.getByText("Join 7%", { exact: true })).toBeVisible();
  await expect.element(legacySampleRow.getByText("Silent 5%", { exact: true })).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );
  await expect.element(page.getByText("$0.0012 known + 2 unknown", { exact: true })).toBeVisible();
  await expect
    .element(currentSampleRow.getByText("Classifier $0.0004", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByText(
        "Classifier cost only; reply usage is tracked separately and is not priced here.",
      ),
    )
    .toBeVisible();

  const details = currentSampleRow.getByText("Show bounded context", { exact: true });
  await details.click();
  await expect
    .element(currentSampleRow.getByText("This context has expired and is no longer displayed."))
    .toBeVisible();
  await expect.element(currentSampleRow.getByText("Keep jokes light")).toBeVisible();

  await page.getByRole("combobox", { name: "Decision mode" }).click();
  await page.getByRole("option", { name: "Active" }).click();
  await vi.waitFor(() => {
    expect(
      requests.some(
        ({ url }) => new URL(url, window.location.origin).searchParams.get("mode") === "active",
      ),
    ).toBe(true);
  });

  await page.getByRole("combobox", { name: "Policy result" }).click();
  await page.getByRole("option", { name: "Policy result: reply" }).click();
  await vi.waitFor(() => {
    expect(
      requests.some(
        ({ url }) =>
          new URL(url, window.location.origin).searchParams.get("engagement") === "answer",
      ),
    ).toBe(true);
  });

  await page.getByRole("combobox", { name: "Actual admission" }).click();
  await page.getByRole("option", { name: "Reply actually admitted" }).click();
  await vi.waitFor(() => {
    expect(
      requests.some(
        ({ url }) =>
          new URL(url, window.location.origin).searchParams.get("actualOutcome") === "answer",
      ),
    ).toBe(true);
  });

  await page.getByRole("combobox", { name: "Review label for message 41" }).click();
  await page.getByRole("option", { name: "Should answer" }).click();
  await vi.waitFor(() => {
    expect(requests.some(({ init }) => init?.method === "PATCH")).toBe(true);
  });
  await expect
    .element(page.getByRole("combobox", { name: "Review label for message 41" }))
    .toHaveTextContent("Should answer");

  await page.getByRole("button", { name: "Next page" }).click();
  await vi.waitFor(() => {
    expect(
      requests.some(
        ({ url }) => new URL(url, window.location.origin).searchParams.get("page") === "2",
      ),
    ).toBe(true);
  });
  await expect.element(page.getByText("Message 42", { exact: true })).toBeVisible();
});

test("reloads a saved label with the latest filters", async () => {
  let finishPatch!: (response: Response) => void;
  const pendingPatch = new Promise<Response>((resolve) => {
    finishPatch = resolve;
  });
  const getModes: Array<string | null> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/engagement-samples/17") && init?.method === "PATCH") {
      return pendingPatch;
    }
    if (url.includes("/engagement-samples")) {
      const mode = new URL(url, window.location.origin).searchParams.get("mode");
      getModes.push(mode);
      return response({
        ok: true,
        items: [{ ...sample, mode: mode ?? "shadow", messageId: mode === "active" ? 99 : 41 }],
        total: 1,
        page: 1,
        pageSize: 20,
        metrics: { labeledCount: 0 },
      });
    }
    return response({ ok: false, error: "Not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<EngagementSamplesSection botId="bot-1" />);
  await expect.element(page.getByText("Message 41", { exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "Review label for message 41" }).click();
  await page.getByRole("option", { name: "Should answer" }).click();
  await page.getByRole("combobox", { name: "Decision mode" }).click();
  await page.getByRole("option", { name: "Active" }).click();
  await expect.element(page.getByText("Message 99", { exact: true })).toBeVisible();

  finishPatch(response({ ok: true, data: { ...sample, label: "answer" } }));
  await vi.waitFor(() => {
    expect(getModes.at(-1)).toBe("active");
  });
  await expect.element(page.getByText("Message 99", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Message 41", { exact: true })).not.toBeInTheDocument();
});

test("shows the empty and failed states", async () => {
  let shouldFail = false;
  const fetchMock = vi.fn(async () => {
    if (shouldFail) return response({ ok: false, error: "boom" }, 500);
    return response({
      ok: true,
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      metrics: { labeledCount: 0 },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<EngagementSamplesSection botId="bot-1" />);
  await expect.element(page.getByText("No engagement samples yet.", { exact: true })).toBeVisible();

  shouldFail = true;
  await page.getByRole("textbox", { name: "Chat ID" }).fill("42");
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect
    .element(page.getByText("Samples could not be loaded.", { exact: true }))
    .toBeVisible();
});
