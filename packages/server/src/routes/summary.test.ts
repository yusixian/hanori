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
