import { Hono } from "hono";
import type { BotManager } from "../services/bot-manager.js";

export function botRoutes(botManager: BotManager) {
  const app = new Hono();

  app.get("/status", (c) => {
    return c.json({
      ok: true,
      data: {
        status: botManager.status,
        uptime: botManager.uptime,
      },
    });
  });

  app.post("/start", async (c) => {
    await botManager.start();
    return c.json({ ok: true });
  });

  app.post("/stop", async (c) => {
    await botManager.stop();
    return c.json({ ok: true });
  });

  app.post("/restart", async (c) => {
    await botManager.restart();
    return c.json({ ok: true });
  });

  return app;
}
