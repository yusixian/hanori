import { Hono } from "hono";
import { Readable } from "node:stream";
import type { MediaAudioStore } from "../services/media/audio-store.js";

/** A narrowly scoped bearer URL is needed by URL-only ASR APIs. No application cookie is forwarded. */
export function asrAudioRoutes(store?: MediaAudioStore) {
  return new Hono().get("/:id", async (c) => {
    const audio = await store?.openStream(
      c.req.param("id"),
      c.req.query("expires") ?? "",
      c.req.query("signature") ?? "",
      c.req.raw.signal,
    );
    if (!audio) return c.json({ ok: false as const, error: "not_found" }, 404);
    const body = Readable.toWeb(audio.stream, {
      strategy: { highWaterMark: 65_536, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(audio.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}
