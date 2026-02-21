import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import * as jose from "jose";

let secretKey: Uint8Array | null = null;

function getSecretKey(secret: string): Uint8Array {
  if (!secretKey) {
    secretKey = new TextEncoder().encode(secret);
  }
  return secretKey;
}

export async function createToken(jwtSecret: string): Promise<string> {
  const key = getSecretKey(jwtSecret);
  return new jose.SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

export function jwtAuth(jwtSecret: string) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing token" });
    }

    const token = authHeader.slice(7);
    try {
      const key = getSecretKey(jwtSecret);
      await jose.jwtVerify(token, key);
    } catch {
      throw new HTTPException(401, { message: "Invalid token" });
    }

    await next();
  };
}
