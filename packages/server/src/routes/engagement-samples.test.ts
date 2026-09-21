import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EngagementSampleService } from "../services/engagement-sample-service.js";
import { engagementSampleRoutes } from "./engagement-samples.js";

function service(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(),
    updateLabel: vi.fn(),
    updateLabels: vi.fn(),
    ...overrides,
  } as unknown as EngagementSampleService;
}

describe("engagement sample routes", () => {
  it("passes bounded filters together with the path bot scope", async () => {
    const list = vi.fn(async () => ({
      items: [],
      total: 0,
      page: 2,
      pageSize: 25,
      metrics: { total: 0 },
    }));
    const app = new Hono().route("/api/bots", engagementSampleRoutes(service({ list })));

    const response = await app.request(
      "/api/bots/bot-a/engagement-samples?page=2&pageSize=25&chatId=-100&mode=shadow&choice=join&engagement=answer&actualOutcome=answer&actualTrigger=engagement_join&errorCategory=timeout&label=unreviewed&createdFrom=2026-09-20T00%3A00%3A00.000Z&createdTo=2026-09-21T00%3A00%3A00.000Z",
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      botId: "bot-a",
      page: 2,
      pageSize: 25,
      chatId: -100,
      mode: "shadow",
      choice: "join",
      engagement: "answer",
      actualOutcome: "answer",
      actualTrigger: "engagement_join",
      errorCategory: "timeout",
      label: "unreviewed",
      createdFrom: new Date("2026-09-20T00:00:00.000Z"),
      createdTo: new Date("2026-09-21T00:00:00.000Z"),
    });
  });

  it("updates and clears one label only through the path bot scope", async () => {
    const updateLabel = vi
      .fn()
      .mockResolvedValueOnce({ id: 7, botId: "bot-b", label: "silent" })
      .mockResolvedValueOnce({ id: 7, botId: "bot-b", label: null });
    const app = new Hono().route("/api/bots", engagementSampleRoutes(service({ updateLabel })));

    for (const label of ["silent", null] as const) {
      const response = await app.request("/api/bots/bot-b/engagement-samples/7", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      expect(response.status).toBe(200);
    }
    expect(updateLabel).toHaveBeenNthCalledWith(1, "bot-b", 7, "silent");
    expect(updateLabel).toHaveBeenNthCalledWith(2, "bot-b", 7, null);
  });

  it("deduplicates a bounded batch and reports only actually updated ids", async () => {
    const updateLabels = vi.fn(async () => ({ ids: [2], count: 1 }));
    const app = new Hono().route("/api/bots", engagementSampleRoutes(service({ updateLabels })));

    const response = await app.request("/api/bots/bot-a/engagement-samples", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [2, 2, 9], label: null }),
    });

    expect(response.status).toBe(200);
    expect(updateLabels).toHaveBeenCalledWith("bot-a", [2, 9], null);
    await expect(response.json()).resolves.toEqual({ ok: true, ids: [2], count: 1 });
  });

  it("returns not found when the bot scope does not exist", async () => {
    const app = new Hono().route(
      "/api/bots",
      engagementSampleRoutes(service({ list: vi.fn(async () => null) })),
    );

    expect((await app.request("/api/bots/missing/engagement-samples")).status).toBe(404);
  });

  it("rejects invalid pages, ids, labels, batches, and ISO ranges", async () => {
    const list = vi.fn();
    const updateLabel = vi.fn();
    const updateLabels = vi.fn();
    const app = new Hono().route(
      "/api/bots",
      engagementSampleRoutes(service({ list, updateLabel, updateLabels })),
    );

    const invalidRequests = [
      app.request("/api/bots/bot-a/engagement-samples?page=1000001"),
      app.request("/api/bots/bot-a/engagement-samples?createdFrom=not-a-date"),
      app.request(
        "/api/bots/bot-a/engagement-samples?createdFrom=2026-09-22T00%3A00%3A00.000Z&createdTo=2026-09-21T00%3A00%3A00.000Z",
      ),
      app.request("/api/bots/bot-a/engagement-samples/not-a-number", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "answer" }),
      }),
      app.request("/api/bots/bot-a/engagement-samples/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "maybe" }),
      }),
      app.request("/api/bots/bot-a/engagement-samples", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [0], label: "answer" }),
      }),
      app.request("/api/bots/bot-a/engagement-samples", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from({ length: 101 }, (_, index) => index + 1),
          label: "answer",
        }),
      }),
    ];

    for (const request of invalidRequests) expect((await request).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
    expect(updateLabels).not.toHaveBeenCalled();
  });
});
