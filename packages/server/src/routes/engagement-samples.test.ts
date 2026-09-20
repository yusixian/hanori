import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EngagementSampleService } from "../services/engagement-sample-service.js";
import { engagementSampleRoutes } from "./engagement-samples.js";

describe("engagement sample routes", () => {
  it("passes bounded filters together with the path bot scope", async () => {
    const list = vi.fn(async () => ({
      items: [],
      total: 0,
      page: 2,
      pageSize: 25,
      metrics: { total: 0 },
    }));
    const service = { list, updateLabel: vi.fn() } as unknown as EngagementSampleService;
    const app = new Hono().route("/api/bots", engagementSampleRoutes(service));

    const response = await app.request(
      "/api/bots/bot-a/engagement-samples?page=2&pageSize=25&chatId=-100&mode=shadow&choice=join&engagement=answer&actualOutcome=answer&actualTrigger=engagement_join&errorCategory=timeout&label=answer",
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
      label: "answer",
    });
  });

  it("updates a label only through the path bot scope", async () => {
    const updateLabel = vi.fn(async () => ({ id: 7, botId: "bot-b", label: "silent" }));
    const service = { list: vi.fn(), updateLabel } as unknown as EngagementSampleService;
    const app = new Hono().route("/api/bots", engagementSampleRoutes(service));

    const response = await app.request("/api/bots/bot-b/engagement-samples/7", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "silent" }),
    });

    expect(response.status).toBe(200);
    expect(updateLabel).toHaveBeenCalledWith("bot-b", 7, "silent");
  });

  it("returns not found when the bot scope does not exist", async () => {
    const service = {
      list: vi.fn(async () => null),
      updateLabel: vi.fn(),
    } as unknown as EngagementSampleService;
    const app = new Hono().route("/api/bots", engagementSampleRoutes(service));

    const response = await app.request("/api/bots/missing/engagement-samples");

    expect(response.status).toBe(404);
  });

  it("rejects invalid pages, ids, and labels before calling the service", async () => {
    const list = vi.fn();
    const updateLabel = vi.fn();
    const service = { list, updateLabel } as unknown as EngagementSampleService;
    const app = new Hono().route("/api/bots", engagementSampleRoutes(service));

    expect((await app.request("/api/bots/bot-a/engagement-samples?page=1000001")).status).toBe(400);
    expect(
      (
        await app.request("/api/bots/bot-a/engagement-samples/not-a-number", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: "answer" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/bots/bot-a/engagement-samples/1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: "maybe" }),
        })
      ).status,
    ).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
  });
});
