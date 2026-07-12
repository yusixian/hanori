import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BotRunService } from "../services/bot-run-service.js";
import { botRunRoutes } from "./bot-runs.js";

describe("bot run event stream", () => {
  it("resumes after Last-Event-ID without loading full event history on every poll", async () => {
    const event = {
      id: 8,
      runId: "run-1",
      sequence: 8,
      kind: "ai-text-delta",
      level: "debug",
      data: { text: "new" },
      createdAt: new Date("2026-07-13T00:00:00.000Z"),
    };
    const statusReads = vi
      .fn<BotRunService["getStatus"]>()
      .mockResolvedValueOnce("running")
      .mockResolvedValueOnce("succeeded");
    const fullRunReads = vi.fn<BotRunService["get"]>().mockResolvedValue({
      id: "run-1",
      botId: "bot-1",
      source: "debugger",
      channel: "telegram",
      mode: "dry-run",
      status: "succeeded",
      failureReason: null,
      input: { text: "hello" },
      configSnapshot: null,
      durationMs: 10,
      pinned: false,
      createdAt: new Date("2026-07-13T00:00:00.000Z"),
      completedAt: new Date("2026-07-13T00:00:00.010Z"),
      events: [event],
    });
    const eventReads = vi
      .fn<BotRunService["eventsAfter"]>()
      .mockResolvedValueOnce([event])
      .mockResolvedValueOnce([]);
    const service = {
      getStatus: statusReads,
      get: fullRunReads,
      eventsAfter: eventReads,
    } as unknown as BotRunService;
    const app = new Hono().route("/bots", botRunRoutes(service));

    const response = await app.request("/bots/bot-1/runs/run-1/stream", {
      headers: { "Last-Event-ID": "7" },
    });
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: bot-run-event");
    expect(body).toContain("id: 8");
    expect(body).toContain("event: bot-run-complete");
    expect(eventReads.mock.calls).toEqual([
      ["run-1", 7],
      ["run-1", 8],
    ]);
    expect(statusReads.mock.calls).toEqual([
      ["bot-1", "run-1"],
      ["bot-1", "run-1"],
    ]);
    expect(fullRunReads).toHaveBeenCalledOnce();
  });
});
