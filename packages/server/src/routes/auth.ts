import { Hono } from "hono";
import { createToken } from "../middleware/auth.js";

export function authRoutes(panelPassword: string, jwtSecret: string) {
  return new Hono().post("/login", async (c) => {
    const body = await c.req.json<{ password: string }>();

    if (body.password !== panelPassword) {
      return c.json({ ok: false as const, error: "密码错误" }, 401);
    }

    const token = await createToken(jwtSecret);
    return c.json({ ok: true as const, data: { token } });
  });
}
