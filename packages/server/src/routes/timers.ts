import { Hono } from "hono";
import type { TimerRegistry } from "../services/timer-registry.js";

export function timerRoutes(
  timerRegistry: TimerRegistry,
  cancelTimer: (timerId: string) => Promise<boolean>,
) {
  return new Hono()
    .get("/", (c) => {
      const botId = c.req.query("botId");
      const type = c.req.query("type") as "ai" | "system" | undefined;
      const filter: { botId?: string; type?: "ai" | "system" } = {};
      if (botId) filter.botId = botId;
      if (type === "ai" || type === "system") filter.type = type;

      const data = timerRegistry.listActive(filter);
      return c.json({ ok: true as const, data });
    })
    .delete("/:timerId", async (c) => {
      const timerId = c.req.param("timerId");
      if (timerId.startsWith("sys_")) {
        return c.json({ ok: false as const, error: "System timers cannot be cancelled" }, 400);
      }
      const cancelled = await cancelTimer(timerId);
      if (!cancelled) {
        return c.json({ ok: false as const, error: "Timer not found or not active" }, 404);
      }
      return c.json({ ok: true as const });
    });
}
