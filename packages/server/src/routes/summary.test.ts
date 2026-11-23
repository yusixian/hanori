import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ChatSummaryService } from "../services/chat-summary-service.js";
import type { SummaryConfigService } from "../services/summary-config-service.js";
import { summaryRoutes } from "./summary.js";

function appWith(configService: Partial<SummaryConfigService>) {
  return new Hono().route(
    "/bots",
    summaryRoutes({} as Database, {} as ChatSummaryService, configService as SummaryConfigService),
  );
}

describe("summary config routes", () => {
  it("passes bot scope directly to patch and returns 404 when it does not match", async () => {
    const get = vi.fn();
    const update = vi.fn(async () => null);
    const response = await appWith({ get, update }).request("/bots/bot-b/summary/configs/7", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });

    expect(response.status).toBe(404);
    expect(update).toHaveBeenCalledWith("bot-b", 7, { isActive: false });
    expect(get).not.toHaveBeenCalled();
  });

  it("passes bot scope directly to delete and returns 404 when it does not match", async () => {
    const get = vi.fn();
    const remove = vi.fn(async () => false);
    const response = await appWith({ get, delete: remove }).request(
      "/bots/bot-b/summary/configs/7",
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(remove).toHaveBeenCalledWith("bot-b", 7);
    expect(get).not.toHaveBeenCalled();
  });

  it("uses the bot-scoped get for config reads", async () => {
    const get = vi.fn(async () => null);
    const response = await appWith({ get }).request("/bots/bot-b/summary/configs/7");

    expect(response.status).toBe(404);
    expect(get).toHaveBeenCalledWith("bot-b", 7);
  });
});

it("owner preview binds trusted identity and rejects identity spoofing", async () => {
  const summarize = vi.fn(async () => ({ ok: true, contentRaw: "preview" }));
  const app = new Hono().route(
    "/bots",
    summaryRoutes(
      {} as Database,
      { summarize } as unknown as ChatSummaryService,
      {} as SummaryConfigService,
    ),
  );
  const body = {
    chatId: -1,
    threadId: 7,
    since: "2026-01-01T00:00:00Z",
    until: "2026-01-02T00:00:00Z",
    maxMessages: 1000,
    sourceRoles: "original",
  };
  const request = (data: unknown) =>
    app.request("/bots/bot-a/summary/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  expect((await request(body)).status).toBe(200);
  expect(summarize).toHaveBeenCalledWith({
    botId: "bot-a",
    chatId: -1,
    threadId: 7,
    userId: 0,
    owner: true,
    originalMessagesOnly: true,
    request: { since: body.since, until: body.until, maxMessages: 1000 },
  });
  expect((await request({ ...body, userId: 123 })).status).toBe(400);
  expect((await request({ ...body, maxMessages: 2001 })).status).toBe(400);
  expect(summarize).toHaveBeenCalledOnce();
});
