import { Hono } from "hono";
import {
  ImageMcpPlatformError,
  type ImageMcpPlatformService,
} from "../services/image-mcp-platform.js";

export function imageMcpPlatformRoutes(service?: ImageMcpPlatformService) {
  return new Hono()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/", (c) =>
      service
        ? c.json({ ok: true as const, data: service.getPublic() })
        : c.json({ ok: false as const, error: "unavailable" }, 503),
    )
    .put("/", async (c) => {
      if (!service) return c.json({ ok: false as const, error: "unavailable" }, 503);
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        return c.json({ ok: false as const, error: "invalid_configuration" }, 400);
      }
      try {
        return c.json({ ok: true as const, data: await service.update(input) });
      } catch (error) {
        const code = error instanceof ImageMcpPlatformError ? error.code : "unavailable";
        return c.json(
          { ok: false as const, error: code },
          code === "conflict" ? 409 : code === "invalid_configuration" ? 400 : 503,
        );
      }
    });
}
