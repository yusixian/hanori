import { Hono } from "hono";
import { createToken } from "../middleware/auth.js";

export function authRoutes(panelPassword: string, jwtSecret: string) {
  const app = new Hono();

  app.post("/login", async (c) => {
    const body = await c.req.json<{ password: string }>();

    if (body.password !== panelPassword) {
      return c.json({ ok: false, error: "密码错误" }, 401);
    }

    const token = await createToken(jwtSecret);
    return c.json({ ok: true, data: { token } });
  });

  return app;
}
