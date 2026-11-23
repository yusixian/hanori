import { describe, expect, it, vi } from "vitest";
import type { ScheduledTaskRecord } from "@cos-tool-bot/shared";
import { scheduledTaskRoutes } from "./scheduled-tasks.js";
import { ScheduledTaskRequestError, ScheduledTaskService } from "../services/scheduled-tasks.js";

const task = {
  id: "task-1",
  botId: "b9d49520-ab6b-4c42-a9a8-ef29257b4bf9",
  chatId: -100,
  threadId: 7,
} as ScheduledTaskRecord;
function fixture() {
  const service = Object.create(ScheduledTaskService.prototype) as ScheduledTaskService;
  service.getForPanel = vi.fn().mockResolvedValue(task);
  service.decide = vi.fn().mockResolvedValue(task);
  service.propose = vi.fn().mockResolvedValue(task);
  service.runNow = vi.fn().mockResolvedValue(task);
  service.manage = vi.fn().mockResolvedValue(task);
  return { service, app: scheduledTaskRoutes(service) };
}
function post(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
describe("scheduled task management routes", () => {
  it("keeps panel approvals scoped to persisted source, with no Telegram impersonation", async () => {
    const { app, service } = fixture();
    const response = await app.request(
      "/task-1/decision",
      post({ version: 2, action: "approve", chatId: 999, userId: 777 }),
    );
    expect(response.status).toBe(200);
    expect(service.decide).toHaveBeenCalledWith(
      {
        botId: task.botId,
        chatId: -100,
        threadId: 7,
        userId: 0,
        userName: "Panel administrator",
        isAdmin: true,
        isBotAdmin: true,
      },
      { id: "task-1", version: 2, action: "approve" },
    );
  });
  it("accepts a manual run using persisted scope and returns without claiming completion", async () => {
    const { app, service } = fixture();
    const response = await app.request("/task-1/run", post({ chatId: 999 }));
    expect(response.status).toBe(202);
    expect(service.runNow).toHaveBeenCalledWith(
      expect.objectContaining({ botId: task.botId, chatId: -100, isAdmin: true }),
      task.id,
    );
  });
  it("returns a conflict for a stale confirmation", async () => {
    const { app, service } = fixture();
    vi.mocked(service.decide).mockRejectedValue(
      new ScheduledTaskRequestError("Confirmation expired or plan changed"),
    );
    const response = await app.request("/task-1/decision", post({ version: 1, action: "approve" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Confirmation expired or plan changed",
    });
  });
  it("rejects malformed plans before creating a proposal", async () => {
    const { app, service } = fixture();
    const response = await app.request(
      "/",
      post({ botId: task.botId, chatId: -100, plan: { name: "missing schedule" } }),
    );
    expect(response.status).toBe(400);
    expect(service.propose).not.toHaveBeenCalled();
  });
  it("rejects missing tasks without making a decision", async () => {
    const { app, service } = fixture();
    vi.mocked(service.getForPanel).mockResolvedValue(null);
    expect(
      (await app.request("/missing/decision", post({ version: 1, action: "trial" }))).status,
    ).toBe(404);
    expect(service.decide).not.toHaveBeenCalled();
  });
  it("does not expose disabled scheduling as a working API", async () => {
    expect((await scheduledTaskRoutes().request("/")).status).toBe(503);
  });
});
