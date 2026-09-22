import { i18n } from "@/i18n";
import { engagementSamples } from "@/i18n/locales/en/engagement-samples";
import "@/style.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EngagementSamplesSection } from "./engagement-samples-section";

const sample = {
  id: 17,
  botId: "bot-1",
  chatId: -100123,
  messageId: 41,
  source: "jev",
  mode: "shadow",
  style: "natural",
  choice: "join",
  engagement: "silent",
  confidence: 0.6,
  participation: { choice: "join" as const, confidence: 0.72 },
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
    addressedConfidenceThreshold: 0.8,
    continueConfidenceThreshold: 0.8,
    continuationWindowSeconds: 120,
    contextMessages: 20,
    timeoutMs: 1000,
  },
  latencyMs: 87,
  inputTokens: 120,
  estimatedCostUsd: 0.00042,
  context: [
    { messageId: 41, userId: 7, text: "Should the bot join this conversation?", timestamp: 1 },
    {
      messageId: 42,
      userId: 0,
      text: "Later bot content must not become the summary",
      timestamp: 2,
      isBot: true,
    },
  ],
  contextExpiresAt: "2099-09-28T00:00:00.000Z",
  contextPurgedAt: null,
  pricingSource: "typesafe-official-pricing-manual",
  pricingSourceUrl: "https://docs.typesafe.ai/models",
  pricingObservedAt: "2026-09-21T00:00:00.000Z",
  errorCategory: "timeout",
  label: null as "answer" | "silent" | "uncertain" | null,
  createdAt: "2026-09-21T08:00:00.000Z",
};

const secondSample = {
  ...sample,
  id: 18,
  messageId: 51,
  engagement: "answer",
  participation: null,
  actualTrigger: "engagement_addressed",
  configSnapshot: {
    mode: "shadow",
    style: "natural",
    preferences: "",
    keywordDirect: false,
    cooldownSeconds: 60,
    confidenceThreshold: 0.8,
    contextMessages: 20,
    timeoutMs: 1000,
  },
  context: [{ messageId: 51, userId: 8, text: "A second current message", timestamp: 3 }],
  errorCategory: null,
};

const localSample = {
  ...sample,
  id: 19,
  messageId: 61,
  source: "local",
  probabilities: null,
  confidence: null,
  reasonCode: "keyword_direct",
  context: [{ messageId: 61, userId: 9, text: "Local keyword matched", timestamp: 4 }],
  errorCategory: null,
};

const legacySample = {
  ...sample,
  id: 20,
  messageId: 71,
  probabilities: { continue: 0.2, join: 0.3, silent: 0.5 },
  confidence: 0.5,
  participation: null,
  configSnapshot: {
    mode: "shadow",
    style: "natural",
    preferences: "",
    keywordDirect: false,
    cooldownSeconds: 60,
    confidenceThreshold: 0.8,
    contextMessages: 20,
    timeoutMs: 1000,
  },
  context: [{ messageId: 71, userId: 10, text: "A legacy decision", timestamp: 5 }],
  errorCategory: null,
};

const metrics = {
  total: 3,
  labeledCount: 2,
  evaluatedCount: 2,
  labelAnswerCount: 1,
  labelSilentCount: 1,
  falsePositiveCount: 1,
  falseNegativeCount: 0,
  falsePositiveRate: 1,
  falseNegativeRate: 0,
  latencyP50Ms: 80,
  latencyP95Ms: 112,
  classifierCostUsd: 0.0012,
  classifierCostKnownCount: 3,
  classifierCostUnknownCount: 2,
  errorCount: 1,
  timeoutCount: 1,
  inputTokens: 360,
  actorCostStatus: "unpriced",
  actorCostReason: "not priced",
  actorUsagePath: "/api/usage/summary?botId=bot-1",
  evaluationByFormat: {
    twoStage: {
      sampleCount: 2,
      labeledCount: 1,
      evaluatedCount: 1,
      labelAnswerCount: 1,
      labelSilentCount: 0,
      falsePositiveCount: 0,
      falseNegativeCount: 1,
      falsePositiveRate: null,
      falseNegativeRate: 1,
    },
    legacy: {
      sampleCount: 1,
      labeledCount: 1,
      evaluatedCount: 1,
      labelAnswerCount: 0,
      labelSilentCount: 1,
      falsePositiveCount: 1,
      falseNegativeCount: 0,
      falsePositiveRate: 1,
      falseNegativeRate: null,
    },
  },
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function listResponse(items: Array<typeof sample>, total = items.length) {
  return response({
    ok: true,
    items,
    total,
    page: 1,
    pageSize: 20,
    metrics: { ...metrics, total },
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

test("shows the exact sampled message, compact decisions, full metrics, and local rules", async () => {
  await page.viewport(1440, 900);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      listResponse([sample, secondSample, localSample, legacySample] as Array<typeof sample>),
    ),
  );

  render(<EngagementSamplesSection botId="bot-1" />);

  await expect
    .element(page.getByRole("heading", { name: "Engagement review samples" }))
    .toBeVisible();
  const rows = page.getByRole("article");
  const current = rows.nth(0);
  const local = rows.nth(2);
  await expect
    .element(current.getByText("Should the bot join this conversation?", { exact: true }).nth(0))
    .toBeVisible();
  await expect
    .element(current.getByText("Admitted to the reply pipeline", { exact: true }))
    .toBeVisible();
  await expect
    .element(current.getByText("Reason: Below policy threshold", { exact: false }))
    .toBeVisible();
  await expect
    .element(current.getByText("Policy participation route: Join", { exact: true }))
    .toBeVisible();
  await expect.element(local.getByText("Local rule: Join", { exact: true })).toBeVisible();
  expect(local.element().textContent).not.toContain("Legacy JEV choice");
  expect(page.getByText("Records").element().parentElement?.textContent).toContain("4");
  expect(page.getByText("Errors / timeouts").element().parentElement?.textContent).toContain(
    "1 / 1",
  );
  await page.viewport(390, 844);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );
  await expect
    .element(page.getByRole("article").nth(0).getByRole("button", { name: "Should answer" }))
    .toBeVisible();
  await page.viewport(1440, 900);
  window.scrollTo(0, 0);

  await page.getByText("Human evaluation · 2 labeled JEV samples", { exact: true }).click();
  await expect
    .element(page.getByText("Current two-stage decisions", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("Legacy three-class decisions", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("1 evaluable labels · 1 labeled · 1 unreviewed · 2 samples"))
    .toBeVisible();

  await current.getByText("Details, context, probabilities, and cost", { exact: true }).click();
  await expect.element(current.getByText("Reply-decision probabilities")).toBeVisible();
  await expect.element(current.getByText("Reply 60%", { exact: true })).toBeVisible();
  await expect.element(current.getByText("Silent 40%", { exact: true })).toBeVisible();
  await expect.element(current.getByText("Participation probabilities")).toBeVisible();
  await expect
    .element(current.getByText("Raw participation recommendation: Join · confidence 72%"))
    .toBeVisible();
  await expect
    .element(current.getByText("Its probability is not the model's willingness", { exact: false }))
    .toBeVisible();
  await expect.element(current.getByText("Direct address 20%", { exact: true })).toBeVisible();
  await expect.element(current.getByText("Continue 30%", { exact: true })).toBeVisible();
  await expect.element(current.getByText("Join 50%", { exact: true })).toBeVisible();
  await expect
    .element(current.getByText("Later bot content must not become the summary", { exact: true }))
    .toBeVisible();
  await expect.element(current.getByText("Keep jokes light", { exact: false })).toBeVisible();

  const historicalCurrent = rows.nth(1);
  await historicalCurrent
    .getByText("Details, context, probabilities, and cost", { exact: true })
    .click();
  await expect
    .element(
      historicalCurrent.getByText(
        "Raw participation recommendation was not retained for this historical sample.",
      ),
    )
    .toBeVisible();
  await expect
    .element(historicalCurrent.getByText("Actual admitted route: Direct address", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      historicalCurrent.getByText("Historical snapshot: omitted routing settings", {
        exact: false,
      }),
    )
    .toBeVisible();

  const legacy = rows.nth(3);
  await legacy.getByText("Details, context, probabilities, and cost", { exact: true }).click();
  await expect.element(legacy.getByText("Legacy model probabilities")).toBeVisible();
  expect(legacy.element().textContent).not.toContain(
    "Historical snapshot: omitted routing settings",
  );
  expect(legacy.element().textContent).not.toContain("Reply-decision probabilities");
  expect(legacy.element().textContent).not.toContain("Participation probabilities");
});

test("clamps long summaries at 390px, wraps URLs, and hides expired context", async () => {
  const longText = `${"这是需要保持紧凑显示的长中文消息。".repeat(60)}https://example.com/${"segment".repeat(160)}`;
  const expiredText = "Expired context must never remain visible in the summary.";
  const longSample = {
    ...sample,
    id: 31,
    messageId: 301,
    context: [{ messageId: 301, userId: 11, text: longText, timestamp: 6 }],
  };
  const expiredSample = {
    ...sample,
    id: 32,
    messageId: 302,
    context: [{ messageId: 302, userId: 12, text: expiredText, timestamp: 7 }],
    contextExpiresAt: "2020-01-01T00:00:00.000Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => listResponse([longSample, expiredSample] as unknown as Array<typeof sample>)),
  );

  await page.viewport(390, 844);
  render(<EngagementSamplesSection botId="bot-1" />);

  const summaries = page.getByTestId("engagement-message-summary");
  await expect.element(summaries.nth(0)).toBeVisible();
  expect(summaries.nth(0).element().className).toContain("line-clamp-3");
  expect(summaries.nth(0).element().className).toContain("[overflow-wrap:anywhere]");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );

  const longRow = page.getByRole("article").nth(0);
  await longRow.getByText("Details, context, probabilities, and cost", { exact: true }).click();
  await expect.element(longRow.getByText(longText, { exact: true }).nth(1)).toBeVisible();

  await expect
    .element(page.getByText("The current message context has expired", { exact: false }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain(expiredText);

  await page.viewport(1440, 900);
});

test("selects only the current page, applies batch labels and clear, and retains selection on failure", async () => {
  const labels = new Map<number, "answer" | "silent" | "uncertain" | null>();
  let failBatch = false;
  const requests: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.endsWith("/engagement-samples")) {
        const body = JSON.parse(String(init.body)) as {
          ids: number[];
          label: "answer" | "silent" | "uncertain" | null;
        };
        requests.push({ url, body });
        if (failBatch) return response({ ok: false, error: "failed" }, 500);
        for (const id of body.ids) labels.set(id, body.label);
        return response({ ok: true, ids: body.ids, count: body.ids.length });
      }
      const items = [sample, secondSample].map((item) => ({
        ...item,
        label: labels.get(item.id) ?? null,
      }));
      return listResponse(items as Array<typeof sample>);
    }),
  );

  render(<EngagementSamplesSection botId="bot-1" />);
  await expect.element(page.getByText("2 samples", { exact: true })).toBeVisible();

  await page.getByRole("checkbox", { name: "Select message 41" }).click();
  await expect
    .element(page.getByRole("checkbox", { name: "Select all samples on this page" }))
    .toHaveAttribute("aria-checked", "mixed");
  await page.getByRole("checkbox", { name: "Select all samples on this page" }).click();
  await expect.element(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("group", { name: "Review actions" })
    .nth(0)
    .getByRole("button", { name: "Should answer" })
    .click();
  await vi.waitFor(() => expect(requests.at(-1)?.body).toEqual({ ids: [17, 18], label: "answer" }));
  await expect.element(page.getByText("0 selected", { exact: true })).toBeVisible();

  await page.getByRole("checkbox", { name: "Select message 41" }).click();
  await page
    .getByRole("group", { name: "Review actions" })
    .nth(0)
    .getByRole("button", { name: "Clear" })
    .click();
  await vi.waitFor(() => expect(requests.at(-1)?.body).toEqual({ ids: [17], label: null }));

  await page.getByRole("checkbox", { name: "Select all samples on this page" }).click();
  await expect.element(page.getByText("2 selected", { exact: true })).toBeVisible();
  failBatch = true;
  const silentBatchButton = page
    .getByRole("group", { name: "Review actions" })
    .nth(0)
    .getByRole("button", { name: "Should stay silent" });
  await expect.element(silentBatchButton).toBeEnabled();
  await silentBatchButton.click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The review label could not be saved.");
  await expect.element(page.getByText("2 selected", { exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "Decision mode" }).click();
  await page.getByRole("option", { name: "Active" }).click();
  await expect.element(page.getByText("0 selected", { exact: true })).toBeVisible();
});

test("ignores a late old-bot response and converges an emptied last unreviewed page", async () => {
  let resolveOld!: (response: Response) => void;
  const oldRequest = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  let pageTwoReviewed = false;
  const getPages: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/bot-old/")) return oldRequest;
      if (init?.method === "PATCH" && url.includes("/engagement-samples/18")) {
        pageTwoReviewed = true;
        return response({ ok: true, data: { ...secondSample, label: "answer" } });
      }
      const parsed = new URL(url, window.location.origin);
      const requestedPage = parsed.searchParams.get("page") ?? "1";
      getPages.push(requestedPage);
      if (requestedPage === "2" && !pageTwoReviewed) {
        return response({
          ok: true,
          items: [secondSample],
          total: 21,
          page: 2,
          pageSize: 20,
          metrics: { ...metrics, total: 21 },
        });
      }
      return response({
        ok: true,
        items: [sample],
        total: pageTwoReviewed ? 20 : 21,
        page: 1,
        pageSize: 20,
        metrics: { ...metrics, total: pageTwoReviewed ? 20 : 21 },
      });
    }),
  );

  const view = await render(<EngagementSamplesSection botId="bot-old" />);
  await view.rerender(<EngagementSamplesSection botId="bot-new" />);
  await expect.element(page.getByText("Message 41", { exact: true })).toBeVisible();
  resolveOld(listResponse([{ ...localSample, messageId: 999 }] as unknown as Array<typeof sample>));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.body.textContent).not.toContain("Message 999");

  await page.getByRole("combobox", { name: "Review label" }).click();
  await page.getByRole("option", { name: "Unreviewed" }).click();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.element(page.getByText("Message 51", { exact: true })).toBeVisible();
  const rowActions = page.getByRole("article").getByRole("group", { name: "Review actions" });
  await rowActions.getByRole("button", { name: "Should answer" }).click();
  await expect.element(page.getByText("Message 41", { exact: true })).toBeVisible();
  expect(getPages).toContain("2");
  expect(getPages.at(-1)).toBe("1");
});

test("validates text and time filters without starting request loops", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return listResponse([sample]);
    }),
  );

  render(<EngagementSamplesSection botId="bot-1" />);
  await expect.element(page.getByText("Message 41", { exact: true })).toBeVisible();
  const initialRequests = requests.length;

  await page.getByRole("textbox", { name: "Chat ID" }).fill("not-a-chat");
  await expect.element(page.getByRole("alert")).toHaveTextContent("safe whole number");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(requests).toHaveLength(initialRequests);

  await page.getByRole("textbox", { name: "Chat ID" }).fill("-100123");
  await vi.waitFor(() =>
    expect(
      requests.some(
        (url) => new URL(url, window.location.origin).searchParams.get("chatId") === "-100123",
      ),
    ).toBe(true),
  );

  await page.getByText("More filters", { exact: true }).click();
  await page.getByLabelText("From").fill("2026-09-22T00:00");
  await page.getByLabelText("To").fill("2026-09-21T00:00");
  await expect.element(page.getByRole("alert")).toHaveTextContent("end time");
});

test("filters both rows and metrics by decision format and exact config version", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return listResponse([sample]);
    }),
  );

  render(<EngagementSamplesSection botId="bot-1" />);
  await expect.element(page.getByText("Message 41", { exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "Decision format" }).click();
  await page.getByRole("option", { name: "Current two-stage decisions" }).click();
  await vi.waitFor(() =>
    expect(
      requests.some(
        (url) =>
          new URL(url, window.location.origin).searchParams.get("decisionFormat") === "two_stage",
      ),
    ).toBe(true),
  );

  await page.getByText("Details, context, probabilities, and cost", { exact: true }).click();
  await page.getByRole("button", { name: "Config policy-7" }).click();
  await vi.waitFor(() =>
    expect(
      requests.some((url) => {
        const query = new URL(url, window.location.origin).searchParams;
        return (
          query.get("decisionFormat") === "two_stage" && query.get("configVersion") === "policy-7"
        );
      }),
    ).toBe(true),
  );
  await page.getByText("More filters", { exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Exact config version" }))
    .toHaveValue("policy-7");
});

test("blocks review writes until the current filter collection is presented", async () => {
  let resolveOldFilter!: (response: Response) => void;
  const oldFilterRequest = new Promise<Response>((resolve) => {
    resolveOldFilter = resolve;
  });
  const requests: string[] = [];
  const patches: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return response({ ok: true, ids: [sample.id], count: 1 });
      }
      const chatId = new URL(url, window.location.origin).searchParams.get("chatId");
      if (chatId === "-100123") return oldFilterRequest;
      if (chatId === "-200") return listResponse([secondSample] as unknown as Array<typeof sample>);
      return listResponse([sample]);
    }),
  );

  render(<EngagementSamplesSection botId="bot-1" />);
  await expect.element(page.getByText("Message 41", { exact: true })).toBeVisible();

  const chatFilter = page.getByRole("textbox", { name: "Chat ID" });
  await chatFilter.fill("-100123");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Review actions are temporarily unavailable");
  const oldRowAnswer = page.getByRole("article").getByRole("button", { name: "Should answer" });
  await expect.element(oldRowAnswer).toBeDisabled();
  (oldRowAnswer.element() as HTMLElement).click();
  expect(patches).toHaveLength(0);

  await vi.waitFor(() =>
    expect(
      requests.some(
        (url) => new URL(url, window.location.origin).searchParams.get("chatId") === "-100123",
      ),
    ).toBe(true),
  );
  await expect.element(oldRowAnswer).toBeDisabled();

  await chatFilter.fill("-200");
  await expect.element(oldRowAnswer).toBeDisabled();
  await expect.element(page.getByText("Message 51", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("article").getByRole("button", { name: "Should answer" }))
    .toBeEnabled();

  resolveOldFilter(
    listResponse([{ ...localSample, messageId: 999 }] as unknown as Array<typeof sample>),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.body.textContent).not.toContain("Message 999");

  await chatFilter.fill("not-a-chat");
  await expect.element(page.getByRole("alert")).toHaveTextContent("safe whole number");
  const invalidRowAnswer = page.getByRole("article").getByRole("button", { name: "Should answer" });
  await expect.element(invalidRowAnswer).toBeDisabled();
  (invalidRowAnswer.element() as HTMLElement).click();
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(patches).toHaveLength(0);
});

test("does not apply a late label response to a newly filtered collection", async () => {
  let resolvePatch!: (response: Response) => void;
  const pendingPatch = new Promise<Response>((resolve) => {
    resolvePatch = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") return pendingPatch;
      const mode = new URL(url, window.location.origin).searchParams.get("mode");
      const item = mode === "active" ? { ...sample, messageId: 99, mode: "active" } : sample;
      return listResponse([item] as Array<typeof sample>);
    }),
  );

  render(<EngagementSamplesSection botId="bot-1" />);
  await expect.element(page.getByText("Message 41", { exact: true })).toBeVisible();
  await page.getByRole("article").getByRole("button", { name: "Should answer" }).click();
  await page.getByRole("combobox", { name: "Decision mode" }).click();
  await page.getByRole("option", { name: "Active" }).click();
  await expect.element(page.getByText("Message 99", { exact: true })).toBeVisible();

  const lateResponse = response({ ok: true, data: { ...sample, label: "answer" } });
  const jsonSpy = vi.spyOn(lateResponse, "json");
  resolvePatch(lateResponse);
  await expect.poll(() => jsonSpy).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain("Review label saved.");
  await expect.element(page.getByText("Unreviewed", { exact: true })).toBeVisible();
});
