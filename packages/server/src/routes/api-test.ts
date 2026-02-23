import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB

const proxySchema = z.object({
  baseURL: z.string().url(),
  apiKey: z.string().min(1),
  endpoint: z.string().min(1),
  method: z.enum(["GET", "POST"]),
  body: z.unknown().optional(),
});

export function apiTestRoutes() {
  return new Hono().post("/proxy", zValidator("json", proxySchema), async (c) => {
    const { baseURL, apiKey, endpoint, method, body } = c.req.valid("json");

    // Validate endpoint is a relative path (prevent SSRF)
    if (
      endpoint.startsWith("http://") ||
      endpoint.startsWith("https://") ||
      endpoint.includes("://")
    ) {
      return c.json({ ok: false as const, error: "endpoint must be a relative path" }, 400);
    }

    const url = `${baseURL.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };

      const init: RequestInit = { method, headers };
      if (method === "POST" && body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const res = await fetch(url, init);

      // Read response with size limit
      const reader = res.body?.getReader();
      if (!reader) {
        return c.json({
          ok: true as const,
          status: res.status,
          data: null,
        });
      }

      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize > MAX_RESPONSE_SIZE) {
          truncated = true;
          reader.cancel();
          break;
        }
        chunks.push(value);
      }

      let combined: Uint8Array;
      if (chunks.length === 1) {
        combined = chunks[0]!;
      } else {
        const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        combined = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of chunks) {
          combined.set(chunk, pos);
          pos += chunk.byteLength;
        }
      }
      const text = new TextDecoder().decode(combined);

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      return c.json({
        ok: true as const,
        status: res.status,
        truncated,
        data,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false as const, error: `Request failed: ${msg}` }, 502);
    }
  });
}
