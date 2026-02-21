import { Hono } from "hono";
import type { BotManager } from "../services/bot-manager.js";

export function botRoutes(botManager: BotManager) {
  return new Hono()
    .get("/status", (c) => {
      return c.json({
        ok: true as const,
        data: {
          status: botManager.status,
          uptime: botManager.uptime,
        },
      });
    })
    .post("/start", async (c) => {
      await botManager.start();
      return c.json({ ok: true as const });
    })
    .post("/stop", async (c) => {
      await botManager.stop();
      return c.json({ ok: true as const });
    })
    .post("/restart", async (c) => {
      await botManager.restart();
      return c.json({ ok: true as const });
    });
}
