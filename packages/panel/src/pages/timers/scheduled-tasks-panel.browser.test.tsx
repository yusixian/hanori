import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { ScheduledTasksPanel } from "./scheduled-tasks-panel";
import type {
  ScheduledTaskPlan,
  ScheduledTaskRecord,
  ScheduledTaskRun,
} from "@cos-tool-bot/shared";
const api = vi.hoisted(() => ({ tasks: vi.fn(), bots: vi.fn(), run: vi.fn(), runs: vi.fn() }));
vi.mock("@/lib/client", () => ({
  client: {
    api: {
      bots: { $get: api.bots },
      "scheduled-tasks": {
        $get: api.tasks,
        ":id": { run: { $post: api.run }, runs: { $get: api.runs } },
      },
    },
  },
}));
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
const plan: ScheduledTaskPlan = {
  name: "Daily team digest",
  instructions: "Summarize approved team updates and send the digest.",
  schedule: {
    kind: "interval",
    startsAt: "2027-01-01T14:00:00Z",
    everySeconds: 86400,
    timezone: "Asia/Shanghai",
  },
  dataScope: { kind: "chat", lookbackHours: 24, maxMessages: 100 },
  destination: { chatId: -100 },
  agent: { modelId: "fixture-model" },
};
const failed: ScheduledTaskRun = {
  id: "run-before",
  taskId: "task-a",
  status: "failed",
  trial: false,
  manual: false,
  scheduledFor: "2027-01-01T14:00:00Z",
  startedAt: "2027-01-01T14:00:00Z",
  finishedAt: "2027-01-01T14:00:02Z",
  plan,
  agent: plan.agent,
  output: null,
  error: "Fixture provider rejected the model request.",
  messageIds: [],
};
let current: ScheduledTaskRecord, runs: ScheduledTaskRun[];
beforeEach(() => {
  current = {
    id: "task-a",
    botId: "bot-a",
    chatId: -100,
    threadId: null,
    proposerId: 1,
    approvedByUserId: 1,
    proposerName: "Fixture admin",
    activePlan: plan,
    pendingPlan: null,
    revision: 1,
    pendingVersion: null,
    expiresAt: null,
    confirmationMessageId: null,
    status: "active",
    nextRunAt: "2027-01-02T14:00:00Z",
    runningRunId: null,
    consecutiveFailures: 1,
    createdAt: "2027-01-01T00:00:00Z",
    latestRun: failed,
  };
  runs = [failed];
  api.tasks.mockImplementation(async () => response([current]));
  api.runs.mockImplementation(async () => response(runs));
  api.bots.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ ok: true, data: [{ id: "bot-a", name: "Team Bot" }], total: 1 }),
      ),
  );
  api.run.mockImplementation(async () => {
    const run = {
      ...failed,
      id: "run-now",
      status: "running" as const,
      manual: true,
      scheduledFor: "2027-01-02T01:00:00Z",
      startedAt: "2027-01-02T01:00:00Z",
      finishedAt: null,
      error: null,
    };
    runs = [run, failed];
    current = { ...current, runningRunId: run.id, latestRun: run };
    return response(current, 202);
  });
});
test.each([
  { width: 1440, lang: "en" },
  { width: 390, lang: "zh-CN" },
])("approved run lifecycle stays observable at $width px ($lang)", async ({ width, lang }) => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
  await i18n.changeLanguage(lang);
  await page.viewport(width, width === 1440 ? 900 : 844);
  const label = (key: string) => i18n.t(`scheduledTasks.${key}`, { ns: "admin" });
  render(
    <div data-scroll className="h-screen overflow-auto p-4">
      <ScheduledTasksPanel botId="bot-a" />
    </div>,
  );
  await expect.element(page.getByText(failed.error!, { exact: true })).toBeVisible();
  expect(api.tasks).toHaveBeenCalledWith({ query: { botId: "bot-a" } });
  await expect
    .element(page.getByRole("button", { name: label("runNow"), exact: true }))
    .toBeVisible();
  expect(document.body.textContent).toContain("Asia/Shanghai");
  expect(document.body.textContent).toContain("22:00");
  await page.screenshot({ path: `__screenshots__/scheduled-task-live-${width}-failed.png` });
  await page.getByRole("button", { name: label("runNow"), exact: true }).click();
  expect(api.run).toHaveBeenCalledWith({ param: { id: "task-a" } });
  await expect
    .element(page.getByRole("button", { name: label("status.running"), exact: true }))
    .toBeDisabled();
  await expect.element(page.getByText("run-now", { exact: false })).not.toBeVisible();
  await page
    .getByText(new RegExp(lang === "en" ? "Manual run" : "手动运行"))
    .first()
    .click();
  await expect.element(page.getByText("run-now", { exact: false })).toBeVisible();
  document.querySelector("[data-scroll]")?.scrollTo(0, 0);
  await page.screenshot({ path: `__screenshots__/scheduled-task-live-${width}-running.png` });
  const done = {
    ...runs[0]!,
    status: "succeeded" as const,
    finishedAt: "2027-01-02T01:00:04Z",
    output: "Fixture digest delivered",
    messageIds: [4242],
  };
  runs = [done, failed];
  current = { ...current, runningRunId: null, latestRun: done };
  await expect.element(page.getByText("Fixture digest delivered", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/4242/)).toBeVisible();
  expect(current.nextRunAt).toBe("2027-01-02T14:00:00Z");
  expect(current.consecutiveFailures).toBe(1);
  page
    .getByText("Fixture digest delivered", { exact: true })
    .element()
    .scrollIntoView({ block: "center" });
  await page.screenshot({ path: `__screenshots__/scheduled-task-live-${width}-finished.png` });
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
});
test("manual claim rejection is shown as an error", async () => {
  await i18n.changeLanguage("en");
  api.run.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ ok: false, error: "Execution already started or the plan changed" }),
        { status: 409 },
      ),
  );
  render(<ScheduledTasksPanel />);
  await page.getByRole("button", { name: "Run once now", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Execution already started or the plan changed");
});
