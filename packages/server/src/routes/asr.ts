import { Hono } from "hono";
import { AsrSettingsError, type AsrSettingsService } from "../services/asr-settings.js";

/** Mount behind the instance owner/admin middleware; credentials apply to every Bot. */
export function createAsrRoutes(service: AsrSettingsService) {
  return new Hono()
    .use("/settings", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/settings", async (c) => {
      try {
        return c.json({ ok: true as const, data: await service.getPublic() });
      } catch {
        return c.json({ ok: false as const, error: "unreadable_configuration" }, 503);
      }
    })
    .put("/settings", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false as const, error: "invalid_configuration" }, 400);
      }
      try {
        return c.json({ ok: true as const, data: await service.update(body) });
      } catch (error) {
        const code = error instanceof AsrSettingsError ? error.code : "unreadable_configuration";
        return c.json(
          { ok: false as const, error: code },
          code === "conflict" ? 409 : code === "invalid_configuration" ? 400 : 503,
        );
      }
    });
}
