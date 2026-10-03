import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../middleware/better-auth.js";
import { PluginLoginError, type PluginLoginService } from "../services/plugins/login.js";

const scope = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
    .max(100),
  botId: z.uuid(),
});
const session = scope.extend({ sessionId: z.uuid() });
const start = z
  .object({
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// Hono treats a missing JSON body as {}; require a non-simple request even for polls/cancel.
const requireJson: MiddlewareHandler = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return c.json({ ok: false as const, error: "invalid_request" }, 400);
  await next();
};

function owner(c: Context<{ Variables: AuthVariables }>) {
  const user = c.get("authUser");
  const session = c.get("authSession");
  const member = c.get("authMember");
  if (!user?.id || !session?.id || !member?.organizationId) throw new PluginLoginError("not_found");
  return JSON.stringify([member.organizationId, user.id, session.id]);
}

/** The parent enforces owner/admin access; each attempt also belongs to one web session. */
export function pluginLoginRoutes(logins?: Pick<PluginLoginService, "start" | "poll" | "cancel">) {
  const service = () => {
    if (!logins) throw new PluginLoginError("login_closed");
    return logins;
  };
  return new Hono<{ Variables: AuthVariables }>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .onError((error, c) => {
      const code = error instanceof PluginLoginError ? error.code : "login_failed";
      return c.json({ ok: false as const, error: code }, code === "not_found" ? 404 : 400);
    })
    .post(
      "/:id/bots/:botId/login",
      requireJson,
      zValidator("param", scope),
      zValidator("json", start),
      async (c) => {
        const { id, botId } = c.req.valid("param");
        return c.json({
          ok: true as const,
          data: await service().start(owner(c), id, botId, c.req.valid("json")),
        });
      },
    )
    .post(
      "/:id/bots/:botId/login/:sessionId/poll",
      requireJson,
      zValidator("param", session),
      zValidator("json", z.object({}).strict()),
      async (c) => {
        const { id, botId, sessionId } = c.req.valid("param");
        return c.json({
          ok: true as const,
          data: await service().poll(owner(c), id, botId, sessionId),
        });
      },
    )
    .post(
      "/:id/bots/:botId/login/:sessionId/cancel",
      requireJson,
      zValidator("param", session),
      zValidator("json", z.object({}).strict()),
      async (c) => {
        const { id, botId, sessionId } = c.req.valid("param");
        return c.json({
          ok: true as const,
          data: await service().cancel(owner(c), id, botId, sessionId),
        });
      },
    );
}
