import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import type { SummaryToolResult } from "@cos-tool-bot/shared";
import "@/style.css";
import { SummaryPreview } from "./summary-preview";

const api = vi.hoisted(() => ({ preview: vi.fn(), trigger: vi.fn() }));
vi.mock("@/lib/client", () => ({
  client: {
    api: {
      bots: {
        ":botId": {
          summary: {
            preview: { $post: api.preview },
            configs: { ":id": { trigger: { $post: api.trigger } } },
          },
        },
      },
    },
  },
}));
const response = (data: SummaryToolResult) =>
  new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
const complete: SummaryToolResult = {
  ok: true,
  summaryId: 1,
  messageCount: 8,
  contentRaw:
    "Team digest\nThe release checklist is complete. Next: review the documentation on Friday.",
  coverage: {
    scope: {
      botId: "bot-fixture",
      chatId: -10042,
      threadId: null,
      since: "2027-01-01T08:00:00.123Z",
      until: "2027-01-02T08:00:00.123Z",
      limit: 50,
    },
    returnedCount: 8,
    firstMessageAt: "2027-01-01T09:00:00Z",
    lastMessageAt: "2027-01-02T07:00:00Z",
    complete: true,
    truncated: false,
    reason: null,
    collectionCoverage: "unknown",
  },
};
beforeEach(() => {
  api.preview.mockReset();
  api.trigger.mockReset();
});
const label = (key: string) => i18n.t(`summary.preview.${key}`, { ns: "bots" });
async function openForm() {
  await page.getByText(label("title"), { exact: true }).click();
  await page.getByRole("spinbutton", { name: label("chatId"), exact: true }).fill("-10042");
  await page.getByLabelText(label("since"), { exact: true }).fill("2027-01-01T08:00:00.123");
  await page.getByLabelText(label("until"), { exact: true }).fill("2027-01-02T08:00:00.123");
}

test.each([
  { language: "en", width: 1440 },
  { language: "zh-CN", width: 390 },
])("$language preview stays unsent and explains actual coverage", async ({ language, width }) => {
  await i18n.changeLanguage(language);
  await page.viewport(width, width === 1440 ? 900 : 844);
  let finish!: (value: Response) => void;
  api.preview.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <div data-scroll className="h-screen overflow-auto p-4">
      <div className="mx-auto max-w-4xl">
        <SummaryPreview botId="bot-fixture" />
      </div>
    </div>,
  );
  await openForm();
  await page.getByRole("checkbox").click();
  await page
    .getByLabelText(label("instructions"), { exact: true })
    .fill("Summarize decisions and follow-ups.");
  await page.getByRole("button", { name: label("generate"), exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: label("generating"), exact: true }))
    .toBeDisabled();
  expect(api.preview).toHaveBeenCalledTimes(1);
  expect(api.preview).toHaveBeenCalledWith({
    param: { botId: "bot-fixture" },
    json: {
      chatId: -10042,
      since: "2027-01-01T08:00:00.123Z",
      until: "2027-01-02T08:00:00.123Z",
      maxMessages: 1000,
      instructions: "Summarize decisions and follow-ups.",
      sourceRoles: "original",
    },
  });
  finish(response(complete));
  await expect.element(page.getByText(label("complete"), { exact: true })).toBeVisible();
  await expect
    .element(
      page.getByText(i18n.t("bots:summary.preview.count", { count: 8, limit: 50 }), {
        exact: true,
      }),
    )
    .toBeVisible();
  expect(document.body.textContent).toContain("UTC");
  expect(api.trigger).not.toHaveBeenCalled();
  page.getByText(label("complete"), { exact: true }).element().scrollIntoView({ block: "center" });
  await page.screenshot({ path: `__screenshots__/summary-preview-${width}-complete.png` });
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);

  await page.getByRole("spinbutton", { name: label("maxMessages"), exact: true }).fill("5");
  await expect.element(page.getByText(label("complete"), { exact: true })).not.toBeInTheDocument();
  api.preview.mockResolvedValueOnce(
    response({
      ...complete,
      coverage: {
        ...complete.coverage!,
        scope: { ...complete.coverage!.scope, limit: 5 },
        returnedCount: 5,
        complete: false,
        truncated: true,
        reason: "message_limit",
      },
    }),
  );
  await page.getByRole("button", { name: label("generate"), exact: true }).click();
  await expect.element(page.getByText(label("truncated"), { exact: true })).toBeVisible();
  page.getByText(label("truncated"), { exact: true }).element().scrollIntoView({ block: "center" });
  await page.screenshot({ path: `__screenshots__/summary-preview-${width}-truncated.png` });
  expect(api.preview).toHaveBeenCalledTimes(2);
  expect(api.trigger).not.toHaveBeenCalled();
});

test("preview shows empty-window coverage and provider failures without success content", async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1440, 900);
  api.preview.mockResolvedValueOnce(
    response({
      ok: false,
      reason: "too_few_messages",
      messageCount: 0,
      coverage: {
        ...complete.coverage!,
        returnedCount: 0,
        firstMessageAt: null,
        lastMessageAt: null,
      },
    }),
  );
  render(<SummaryPreview botId="bot-fixture" />);
  await openForm();
  await page.getByRole("button", { name: label("generate"), exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent(label("tooFew"));
  await expect.element(page.getByText(label("complete"), { exact: true })).toBeVisible();
  api.preview.mockResolvedValueOnce(response({ ok: false, reason: "no_provider" }));
  await page.getByRole("button", { name: label("generate"), exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent(label("noProvider"));
  await expect.element(page.getByText(label("complete"), { exact: true })).not.toBeInTheDocument();
  expect(api.trigger).not.toHaveBeenCalled();
});

test("preview rejects reversed dates before requesting the model", async () => {
  await i18n.changeLanguage("en");
  render(<SummaryPreview botId="bot-fixture" />);
  await openForm();
  await page.getByLabelText(label("until"), { exact: true }).fill("2026-12-31T08:00:00.123");
  await page.getByRole("button", { name: label("generate"), exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent(label("invalidRange"));
  expect(api.preview).not.toHaveBeenCalled();
  expect(api.trigger).not.toHaveBeenCalled();
});
