import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, test, vi } from "vitest";
import { i18n } from "@/i18n";
import "@/style.css";
import { TaskPlanForm } from "./plan-form";
import { ScheduledTasksPanel } from "./scheduled-tasks-panel";

const api = vi.hoisted(() => ({
  config: vi.fn(),
  tasks: vi.fn(),
  bots: vi.fn(),
  decision: vi.fn(),
}));
vi.mock("@/lib/client", () => ({
  client: {
    api: {
      bots: { $get: api.bots, ":botId": { "ai-config": { $get: api.config } } },
      "scheduled-tasks": { $get: api.tasks, ":id": { decision: { $post: api.decision } } },
    },
  },
}));
const response = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
beforeEach(async () => {
  await i18n.changeLanguage("en");
  await page.viewport(1024, 900);
  api.config.mockResolvedValue(
    response({ providers: [], agentToolsConfig: { agents: { researcher: {} } } }),
  );
  api.bots.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, data: [{ id: "bot-a", name: "News Bot" }], total: 1 })),
  );
});
async function capture(name: string) {
  for (const width of [1440, 390]) {
    await page.viewport(width, width === 1440 ? 900 : 844);
    document.querySelector("[data-scroll]")?.scrollTo(0, 0);
    await page.screenshot({ path: `__screenshots__/${name}-${width}-top.png` });
    if (name.endsWith("form")) {
      page
        .getByRole("button", { name: "Save for approval" })
        .element()
        .scrollIntoView({ block: "end" });
      await page.screenshot({ path: `__screenshots__/${name}-${width}-bottom.png` });
    }
  }
}

test("creates a quarterly plan with scope and destination without enabling it", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <div data-scroll className="h-screen overflow-auto p-4">
      <TaskPlanForm
        bots={[{ id: "bot-a", name: "News Bot" }]}
        busy={false}
        onSave={save}
        onCancel={() => {}}
      />
    </div>,
  );
  await page.getByLabelText("Source chat ID", { exact: true }).fill("-100123");
  await page.getByLabelText("Task name").fill("Quarterly digest");
  await page.getByLabelText("Instructions", { exact: true }).fill("Summarize the quarter");
  await page.getByLabelText("Schedule", { exact: true }).click();
  await page.getByRole("option", { name: "Quarterly", exact: true }).click();
  await page.getByLabelText("Day of month").fill("31");
  await page.getByLabelText("IANA time zone").fill("Asia/Shanghai");
  await page.getByLabelText("Destination chat ID (blank uses source)").fill("-100456");
  await page.getByLabelText("Data access").click();
  await page.getByRole("option", { name: "Source chat / topic history" }).click();
  await page.getByLabelText("Agent profile").click();
  await page.getByRole("option", { name: "researcher" }).click();
  await capture("scheduled-task-form");
  await page.getByRole("button", { name: "Save for approval" }).click();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      botId: "bot-a",
      chatId: -100123,
      plan: expect.objectContaining({
        name: "Quarterly digest",
        schedule: expect.objectContaining({
          kind: "calendar",
          period: "quarter",
          dayOfMonth: 31,
          timezone: "Asia/Shanghai",
        }),
        destination: { chatId: -100456 },
        dataScope: { kind: "chat", lookbackHours: 24, maxMessages: 100 },
        agentName: "researcher",
      }),
    }),
  );
});
test("mobile approval submits the displayed version and shows server rejection", async () => {
  await page.viewport(390, 844);
  const plan = {
    name: "Weekly digest",
    instructions: "Summarize this chat",
    dataScope: { kind: "none" },
    destination: { chatId: -100123 },
    schedule: {
      kind: "interval",
      startsAt: "2027-01-01T00:00:00Z",
      everySeconds: 604800,
      timezone: "UTC",
    },
    agent: {},
  };
  api.tasks.mockImplementation(() =>
    Promise.resolve(
      response([
        {
          id: "task-a",
          botId: "bot-a",
          chatId: -100123,
          status: "pending",
          proposerName: "Mina",
          proposerId: 123,
          pendingPlan: plan,
          pendingVersion: 4,
          expiresAt: "2099-01-01T00:00:00Z",
          activePlan: null,
          nextRunAt: null,
        },
      ]),
    ),
  );
  api.decision.mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: "Confirmation expired or plan changed" }), {
      status: 409,
    }),
  );
  render(
    <div data-scroll className="h-screen overflow-auto p-4">
      <ScheduledTasksPanel />
    </div>,
  );
  await expect.element(page.getByRole("button", { name: "Approve and enable" })).toBeVisible();
  await capture("scheduled-task-pending");
  await page.getByRole("button", { name: "Approve and enable" }).click();
  expect(api.decision).toHaveBeenCalledWith({
    param: { id: "task-a" },
    json: { version: 4, action: "approve" },
  });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Confirmation expired or plan changed");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});
