import type { ScheduledTaskPort, ScheduledTaskRecord } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  createScheduledTaskConfirmationHandler,
  sendScheduledTaskConfirmation,
  scheduledTaskText,
} from "./scheduled-task-confirmation.js";
const record: ScheduledTaskRecord = {
  id: "task-1",
  botId: "bot",
  chatId: -42,
  threadId: 7,
  proposerId: 2,
  approvedByUserId: null,
  proposerName: "member",
  activePlan: null,
  pendingPlan: {
    name: "monthly",
    instructions: "summarize",
    dataScope: { kind: "chat", lookbackHours: 720 },
    destination: { chatId: -42, threadId: 7 },
    schedule: {
      kind: "calendar",
      startsAt: "2030-01-01T00:00:00Z",
      timezone: "Asia/Shanghai",
      period: "month",
      hour: 8,
      minute: 0,
      dayOfMonth: 1,
    },
    agentName: "researcher",
    agent: {},
  },
  revision: 0,
  pendingVersion: 2,
  expiresAt: "2099-01-01T00:00:00Z",
  confirmationMessageId: 90,
  status: "pending",
  nextRunAt: null,
  runningRunId: null,
  consecutiveFailures: 0,
  createdAt: "2026-01-01T00:00:00Z",
};
function setup() {
  const answer = vi.fn().mockResolvedValue(true),
    edit = vi.fn().mockResolvedValue(true),
    send = vi.fn().mockResolvedValue({ message_id: 90 });
  const api = {
    raw: { answerCallbackQuery: answer },
    editMessageText: edit,
    sendMessage: send,
  } as unknown as Api;
  const decide = vi.fn().mockResolvedValue({ ...record, pendingVersion: null, status: "active" });
  const get = vi.fn().mockResolvedValue(record),
    bindConfirmation = vi.fn();
  const port = { decide, get, bindConfirmation } as unknown as ScheduledTaskPort;
  const handler = createScheduledTaskConfirmationHandler({
    api,
    botId: "bot",
    port,
    adminIds: [1],
    isDelegatedGroupAdmin: async (_chat, user) => user === 3,
  });
  const click = (action = "approve", user = 1, version = 2) =>
    handler({
      callbackQuery: {
        id: "q",
        data: `cos:task:task-1:${version}:${action}`,
        from: { id: user },
        message: {
          message_id: 90,
          chat: { id: -42 },
          is_topic_message: true,
          message_thread_id: 7,
        },
      },
    });
  return { api, port, answer, edit, send, decide, get, bindConfirmation, click };
}
describe("task confirmation cards", () => {
  it("delivers long plans losslessly in the same topic and binds only the final card", async () => {
    const s = setup();
    s.send.mockImplementation(async () => ({ message_id: 90 + s.send.mock.calls.length }));
    const task = {
      ...record,
      pendingPlan: { ...record.pendingPlan!, instructions: "🌍完整说明".repeat(1700) },
    };
    const actor = { botId: "bot", chatId: -42, threadId: 7, userId: 2, isAdmin: false };
    await sendScheduledTaskConfirmation(s.api, s.port, actor, task);
    const calls = s.send.mock.calls;
    expect(calls.length).toBeGreaterThan(2);
    const body = calls
      .slice(0, -1)
      .map((call) => String(call[1]).split("\n").slice(1).join("\n"))
      .join("");
    expect(body).toBe(scheduledTaskText(task));
    for (const call of calls) {
      expect(String(call[1]).length).toBeLessThanOrEqual(4096);
      expect(call[2]).toMatchObject({ message_thread_id: 7 });
    }
    expect(calls.at(-1)![2]).toHaveProperty("reply_markup");
    expect(s.bindConfirmation).toHaveBeenCalledWith(actor, task.id, 2, 90 + calls.length);
  });

  it("shows the complete plan and binds the exact sent message/version", async () => {
    const s = setup();
    const actor = { botId: "bot", chatId: -42, threadId: 7, userId: 2, isAdmin: false };
    await sendScheduledTaskConfirmation(s.api, s.port, actor, record);
    expect(s.bindConfirmation).toHaveBeenCalledWith(actor, "task-1", 2, 90);
    expect(s.send).toHaveBeenCalledWith(
      -42,
      expect.stringContaining("researcher"),
      expect.objectContaining({ message_thread_id: 7 }),
    );
    expect(scheduledTaskText(record)).toContain("Asia/Shanghai");
    expect(scheduledTaskText(record)).toContain("member");
    expect(scheduledTaskText(record)).toContain("补最近一期");
  });
  it.each([1, 3])(
    "passes fresh administrator and exact card scope to durable approval",
    async (user) => {
      const s = setup();
      await s.click("approve", user);
      expect(s.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          isAdmin: true,
          isBotAdmin: user === 1,
          chatId: -42,
          threadId: 7,
        }),
        { id: "task-1", version: 2, messageId: 90, action: "approve" },
      );
    },
  );
  it("keeps the card intact when a non-admin or stale approval is rejected", async () => {
    const s = setup();
    s.decide.mockRejectedValue(new Error("管理员才能批准"));
    await s.click("approve", 2);
    expect(s.decide.mock.calls[0]![0].isAdmin).toBe(false);
    expect(s.edit).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true, text: "管理员才能批准" }),
    );
  });
  it("submits trial as a distinct action without approving the schedule", async () => {
    const s = setup();
    await s.click("trial");
    expect(s.decide.mock.calls[0]![1].action).toBe("trial");
  });
  it("rejects editing an expired or superseded card and preserves the latest plan", async () => {
    const s = setup();
    await s.click("edit", 2, 1);
    expect(s.decide).not.toHaveBeenCalled();
    expect(s.edit).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true, text: expect.stringContaining("替代") }),
    );
  });
  it("lets a member request a plan revision without executing it", async () => {
    const s = setup();
    await s.click("edit", 2);
    expect(s.decide).not.toHaveBeenCalled();
    expect(s.answer).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("重新批准") }),
    );
  });
});
