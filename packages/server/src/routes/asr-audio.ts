import { Hono } from "hono";
import type { MediaAudioStore } from "../services/media/audio-store.js";

/** A narrowly scoped bearer URL is needed by URL-only ASR APIs. No application cookie is forwarded. */
export function asrAudioRoutes(store?: MediaAudioStore) {
  return new Hono().get("/:id", async (c) => {
    const bytes = await store?.read(
      c.req.param("id"),
      c.req.query("expires") ?? "",
      c.req.query("signature") ?? "",
    );
    if (!bytes) return c.json({ ok: false as const, error: "not_found" }, 404);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
