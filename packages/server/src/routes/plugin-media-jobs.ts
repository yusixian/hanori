import { boundedTranscriptPage, serializeSrt, serializeVtt } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { MediaJobConfiguration } from "../services/media-jobs/contracts.js";
import { MediaJobError, type MediaJobService } from "../services/media-jobs/service.js";

export interface PluginMediaJobsOptions {
  jobs: Pick<MediaJobService, "listForBot" | "getForOwner" | "cancelForOwner" | "readForOwner">;
  configuration(botId: string): Promise<MediaJobConfiguration | null>;
}
const botParam = z.object({ id: z.literal("hanori.bilibili"), botId: z.uuid() });
const jobParam = botParam.extend({ jobId: z.uuid() });
const pageQuery = z.object({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(40).default(20),
  query: z.string().trim().min(1).max(200).optional(),
});

/** Parent router enforces workspace owner/admin access, including every transcript and export. */
export function pluginMediaJobRoutes(options?: PluginMediaJobsOptions) {
  const service = () => {
    if (!options) throw new MediaJobError("configuration_required");
    return options.jobs;
  };
  return new Hono()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .onError((error, c) => {
      const code = error instanceof MediaJobError ? error.code : "job_failed";
      return c.json(
        { ok: false as const, error: code },
        code === "not_found" ? 404 : code === "forbidden" ? 403 : 400,
      );
    })
    .get("/:id/bots/:botId/jobs", zValidator("param", botParam), async (c) => {
      const { botId } = c.req.valid("param");
      // A broken/revoked provider must not hide existing jobs or prevent cancellation.
      const configuration = await options?.configuration(botId).catch(() => null);
      return c.json({
        ok: true as const,
        data: options ? await options.jobs.listForBot(botId) : [],
        available: Boolean(configuration),
        allowExport: configuration?.allowExport === true,
      });
    })
    .get("/:id/bots/:botId/jobs/:jobId", zValidator("param", jobParam), async (c) => {
      const { botId, jobId } = c.req.valid("param");
      return c.json({ ok: true as const, data: await service().getForOwner(botId, jobId) });
    })
    .post("/:id/bots/:botId/jobs/:jobId/cancel", zValidator("param", jobParam), async (c) => {
      const { botId, jobId } = c.req.valid("param");
      return c.json({ ok: true as const, data: await service().cancelForOwner(botId, jobId) });
    })
    .get(
      "/:id/bots/:botId/jobs/:jobId/transcript",
      zValidator("param", jobParam),
      zValidator("query", pageQuery),
      async (c) => {
        const { botId, jobId } = c.req.valid("param");
        const document = await service().readForOwner(botId, jobId);
        return c.json({
          ok: true as const,
          data: boundedTranscriptPage(document, c.req.valid("query")),
        });
      },
    )
    .post(
      "/:id/bots/:botId/jobs/:jobId/export",
      zValidator("param", jobParam),
      zValidator(
        "json",
        z.object({ format: z.enum(["srt", "vtt"]), rightsConfirmed: z.literal(true) }).strict(),
      ),
      async (c) => {
        const { botId, jobId } = c.req.valid("param");
        const { format } = c.req.valid("json");
        if (!(await options?.configuration(botId))?.allowExport)
          throw new MediaJobError("forbidden");
        const document = await service().readForOwner(botId, jobId);
        // readForOwner rechecks the job's configuration revision; changes revoke old exports.
        const text = format === "srt" ? serializeSrt(document) : serializeVtt(document);
        c.header("Content-Disposition", `attachment; filename="${jobId}.${format}"`);
        c.header(
          "Content-Type",
          format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
        );
        c.header("X-Content-Type-Options", "nosniff");
        return c.body(text);
      },
    );
}
