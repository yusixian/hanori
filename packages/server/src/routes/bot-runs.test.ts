import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import { describe, expect, it, vi } from "vitest";
import type { BotRunService } from "../services/bot-run-service.js";
import { botRunRoutes } from "./bot-runs.js";

describe("bot run event stream", () => {
  it.each([
    { name: "Last-Event-ID takes precedence", header: "7", after: "2", expected: 7 },
    { name: "query cursor", header: undefined, after: "6", expected: 6 },
    { name: "invalid header", header: "invalid", after: "6", expected: 0 },
    { name: "negative query cursor", header: undefined, after: "-1", expected: 0 },
    { name: "non-finite query cursor", header: undefined, after: "Infinity", expected: 0 },
  ])(
    "resumes with $name and completes after delivering events",
    async ({ header, after, expected }) => {
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

      const response = await app.request(`/bots/bot-1/runs/run-1/stream?after=${after}`, {
        headers: header === undefined ? {} : { "Last-Event-ID": header },
      });
      const body = await response.text();

      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(body).toContain("event: bot-run-event");
      expect(body).toContain("id: 8");
      expect(body).toContain("event: bot-run-complete");
      const frames = body.trim().split("\n\n");
      expect(frames).toHaveLength(2);
      expect(frames[0]).toContain("event: bot-run-event");
      expect(frames[0]).toContain(`data: ${JSON.stringify(event)}`);
      expect(frames[1]).toContain("event: bot-run-complete");
      expect(JSON.parse(frames[1]!.split("data: ")[1]!)).toMatchObject({
        id: "run-1",
        status: "succeeded",
        events: [JSON.parse(JSON.stringify(event))],
      });
      expect(eventReads.mock.calls).toEqual([
        ["run-1", expected],
        ["run-1", 8],
      ]);
      expect(statusReads.mock.calls).toEqual([
        ["bot-1", "run-1"],
        ["bot-1", "run-1"],
      ]);
      expect(fullRunReads).toHaveBeenCalledOnce();
    },
  );
});

it.each(["status", "events", "completion"] as const)(
  "stops the event stream when disconnected during the %s query",
  async (stage) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const status = vi.fn(async () => {
      if (stage === "status") await gate;
      return "succeeded";
    });
    const events = vi.fn(async () => {
      if (stage === "events") {
        await gate;
        return [{ sequence: 1, data: { text: "late event" } }];
      }
      return [];
    });
    const completion = vi.fn(async () => {
      if (stage === "completion") await gate;
      return { id: "run-1", status: "succeeded" };
    });
    const service = {
      getStatus: status,
      eventsAfter: events,
      get: completion,
    } as unknown as BotRunService;
    const app = new Hono().route("/bots", botRunRoutes(service));
    const writes = vi.spyOn(SSEStreamingApi.prototype, "writeSSE");
    const closed = vi.spyOn(SSEStreamingApi.prototype, "close");
    const response = await app.request("/bots/bot-1/runs/run-1/stream");
    try {
      const blocked = stage === "status" ? status : stage === "events" ? events : completion;
      await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
      await response.body!.cancel();
      release();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
      expect(writes).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledOnce();
      expect(events).toHaveBeenCalledTimes(stage === "status" ? 0 : 1);
      expect(completion).toHaveBeenCalledTimes(stage === "completion" ? 1 : 0);
    } finally {
      await response.body!.cancel();
      release();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
      writes.mockRestore();
      closed.mockRestore();
    }
  },
);

it("does not start run queries for a request already disconnected", async () => {
  const getStatus = vi.fn(async () => null);
  const service = { getStatus } as unknown as BotRunService;
  const app = new Hono().route("/bots", botRunRoutes(service));
  const response = await app.request("/bots/bot-1/runs/run-1/stream", {
    signal: AbortSignal.abort(),
  });
  await response.body?.cancel();
  expect(response.status).toBe(499);
  expect(getStatus).not.toHaveBeenCalled();
});
