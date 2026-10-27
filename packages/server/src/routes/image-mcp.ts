import { Hono } from "hono";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { ImageMcpConnectionService } from "../services/image-mcp-connection-service.js";

export function imageMcpRoutes(
  resolveService: () => ImageMcpConnectionService | undefined,
  baseURL: string,
) {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/status", async (c) => {
      const service = resolveService();
      return c.json({
        ok: true as const,
        data: service
          ? await service.getStatus()
          : { status: "disconnected", scopes: [], lastError: "NOT_CONFIGURED" },
      });
    })
    .post("/oauth/start", async (c) => {
      const service = resolveService();
      if (!service) return c.json({ ok: false as const, error: "NOT_CONFIGURED" }, 503);
      const authorizationUrl = await service.beginAuthorization(c.get("authUser").id);
      return c.json({ ok: true as const, authorizationUrl });
    })
    .get("/oauth/callback", async (c) => {
      const service = resolveService();
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state || !service) {
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
      const service = resolveService();
      if (!service) return c.json({ ok: false as const, error: "NOT_CONFIGURED" }, 503);
      await service.disconnect();
      return c.json({ ok: true as const });
    });
}
