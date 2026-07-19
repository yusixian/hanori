import type { Database } from "@cos-tool-bot/database";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BotPool } from "../services/bot-pool.js";
import { generationRoutes } from "./generations.js";

describe("generation deletion", () => {
  it("suppresses fallback before deleting the generation", async () => {
    const calls: string[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ taskId: "task-1" }]),
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
    const app = new Hono().route("/bots", generationRoutes(db, botPool));

    const response = await app.request("/bots/bot-a/generations/1", { method: "DELETE" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["suppress", "delete"]);
    expect(botPool.suppressGenerationFallback).toHaveBeenCalledWith("bot-a", "task-1");
  });
});
