import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { BotRunService } from "../services/bot-run-service.js";

const startSchema = z
  .object({
    text: z.string().max(65_536).optional(),
    channel: z.enum(["telegram", "lark-webhook", "fake"]).optional(),
    channelEvent: z.record(z.string(), z.unknown()).optional(),
    replayOf: z.string().uuid().optional(),
  })
  .refine((value) => Boolean(value.text?.trim() || value.channelEvent), {
    message: "text or channelEvent is required",
  });

export function botRunRoutes(service: BotRunService) {
  return new Hono()
    .get("/:botId/runs", async (c) => {
      const runs = await service.list(c.req.param("botId"), Number(c.req.query("limit") ?? "50"));
      return c.json({ ok: true as const, data: runs });
    })
    .post("/:botId/runs", zValidator("json", startSchema), async (c) => {
      try {
        const run = await service.start(c.req.param("botId"), c.req.valid("json"));
        return c.json({ ok: true as const, data: run }, 202);
      } catch (error) {
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .get("/:botId/runs/:runId", async (c) => {
      const run = await service.get(c.req.param("botId"), c.req.param("runId"));
      if (!run) throw new HTTPException(404, { message: "Bot Run not found" });
      return c.json({ ok: true as const, data: run });
    })
    .post("/:botId/runs/:runId/replay", async (c) => {
      const original = await service.get(c.req.param("botId"), c.req.param("runId"));
      if (!original) throw new HTTPException(404, { message: "Bot Run not found" });
      const input = original.input;
      const run = await service.start(c.req.param("botId"), {
        text: typeof input["text"] === "string" ? input["text"] : undefined,
        channelEvent:
          input["channelEvent"] && typeof input["channelEvent"] === "object"
            ? (input["channelEvent"] as Record<string, unknown>)
            : undefined,
        channel: original.channel,
        replayOf: original.id,
      });
      return c.json({ ok: true as const, data: run }, 202);
    })
    .post("/:botId/runs/:runId/cancel", async (c) => {
      const cancelled = await service.cancel(c.req.param("botId"), c.req.param("runId"));
      if (!cancelled) throw new HTTPException(409, { message: "Bot Run is not running" });
      return c.json({ ok: true as const });
    })
    .post(
      "/:botId/runs/:runId/pin",
      zValidator("json", z.object({ pinned: z.boolean() })),
      async (c) => {
        const run = await service.pin(
          c.req.param("botId"),
          c.req.param("runId"),
          c.req.valid("json").pinned,
        );
        if (!run) throw new HTTPException(404, { message: "Bot Run not found" });
        return c.json({ ok: true as const, data: run });
      },
    )
    .get("/:botId/runs/:runId/stream", (c) => {
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      return streamSSE(c, async (stream) => {
        const { botId, runId } = c.req.param();
        const requestedSequence = Number(
          c.req.header("Last-Event-ID") ?? c.req.query("after") ?? "0",
        );
        let sequence = Number.isFinite(requestedSequence) ? Math.max(0, requestedSequence) : 0;
        while (!stream.aborted) {
          const status = await service.getStatus(botId, runId);
          if (!status || stream.aborted) return;
          const events = await service.eventsAfter(runId, sequence);
          if (stream.aborted) return;
          for (const event of events) {
            if (stream.aborted) return;
            await stream.writeSSE({
              event: "bot-run-event",
              id: String(event.sequence),
              data: JSON.stringify(event),
            });
            sequence = event.sequence;
          }
          if (status !== "running" && events.length === 0) {
            break;
          }
          if (stream.aborted) return;
          await stream.sleep(300);
        }
        if (stream.aborted) return;
        const run = await service.get(botId, runId);
        if (!run || stream.aborted) return;
        await stream.writeSSE({ event: "bot-run-complete", data: JSON.stringify(run) });
      });
    });
}
