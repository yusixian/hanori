import { Hono } from "hono";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { ImageMcpConnectionService } from "../services/image-mcp-connection-service.js";

export function imageMcpRoutes(service: ImageMcpConnectionService, baseURL: string) {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/status", async (c) => c.json({ ok: true as const, data: await service.getStatus() }))
    .post("/oauth/start", async (c) => {
      const authorizationUrl = await service.beginAuthorization(c.get("authUser").id);
      return c.json({ ok: true as const, authorizationUrl });
    })
    .get("/oauth/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) {
        return c.redirect(new URL("/?imageMcp=error", baseURL).toString());
      }
      try {
        await service.finishAuthorization(code, state);
        return c.redirect(new URL("/?imageMcp=connected", baseURL).toString());
      } catch {
        return c.redirect(new URL("/?imageMcp=error", baseURL).toString());
      }
    })
    .delete("/", async (c) => {
      await service.disconnect();
      return c.json({ ok: true as const });
    });
}
