import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BotPool } from "../services/bot-pool.js";
import type { ImageGenerationService } from "../services/image-generation-service.js";
import { generationRoutes } from "./generations.js";
import { generationRow, query } from "../services/image-generation-service-test-fakes.js";

describe("generation safety scores", () => {
  it("returns real unified scores even when another image could not be classified", async () => {
    const scores = { porn: 0.9, sexy: 0, hentai: 0, neutral: 0.1, drawing: 0 };
    const row = generationRow({
      state: "succeeded",
      filesPurgedAt: null,
      requestSnapshot: null,
      artifacts: [
        { ordinal: 0, nsfw: { status: "checked", isNsfw: true, scores } },
        { ordinal: 1, nsfw: { status: "failed", isNsfw: true, scores: null } },
      ],
    });
    const db = { select: () => query([row]) } as unknown as Database;
    const app = new Hono().route(
      "/bots",
      generationRoutes(db, {} as BotPool, {} as ImageGenerationService),
    );
    const response = await app.request(`/bots/${row.botId}/generations?source=unified`);
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { data: Array<{ nsfwScores: unknown }> }).data[0]?.nsfwScores,
    ).toEqual([scores]);
  });
});

describe("generation deletion", () => {
  it("suppresses fallback before deleting the generation", async () => {
    const calls: string[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ taskId: "task-1", status: "completed" }]),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            calls.push("delete");
            return [{ taskId: "task-1", localFiles: null }];
          }),
        })),
      })),
    } as unknown as Database;
    const botPool = {
      suppressGenerationFallback: vi.fn(() => calls.push("suppress")),
    } as unknown as BotPool;
    const imageGenerationService = {} as ImageGenerationService;
    const app = new Hono().route("/bots", generationRoutes(db, botPool, imageGenerationService));

    const response = await app.request("/bots/bot-a/generations/1", { method: "DELETE" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["suppress", "delete"]);
    expect(botPool.suppressGenerationFallback).toHaveBeenCalledWith("bot-a", "task-1");
  });
});
