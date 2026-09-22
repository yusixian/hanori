import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { EngagementSampleService } from "../services/engagement-sample-service.js";

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const querySchema = z
  .object({
    page: z.coerce.number().int().positive().max(1_000_000).optional().default(1),
    pageSize: z.coerce.number().int().positive().max(100).optional().default(20),
    chatId: z.coerce.number().int().safe().optional(),
    mode: z.enum(["off", "shadow", "active"]).optional(),
    choice: z.enum(["continue", "join", "silent"]).optional(),
    engagement: z.enum(["answer", "silent"]).optional(),
    actualOutcome: z.enum(["answer", "silent"]).optional(),
    actualTrigger: z.string().trim().min(1).max(100).optional(),
    errorCategory: z.string().trim().min(1).max(100).optional(),
    label: z.enum(["answer", "silent", "uncertain", "unreviewed"]).optional(),
    decisionFormat: z.enum(["all", "two_stage", "legacy"]).optional().default("all"),
    configVersion: z.string().trim().min(1).max(100).optional(),
    createdFrom: isoDateTime.optional(),
    createdTo: isoDateTime.optional(),
  })
  .superRefine((value, context) => {
    if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) {
      context.addIssue({
        code: "custom",
        path: ["createdTo"],
        message: "createdTo must be on or after createdFrom",
      });
    }
  });

const labelSchema = z.object({
  label: z.enum(["answer", "silent", "uncertain"]).nullable(),
});

const batchLabelSchema = z.object({
  ids: z
    .array(z.number().int().positive().safe())
    .min(1)
    .max(100)
    .transform((ids) => [...new Set(ids)]),
  label: z.enum(["answer", "silent", "uncertain"]).nullable(),
});

export function engagementSampleRoutes(
  service: Pick<EngagementSampleService, "list" | "updateLabel" | "updateLabels">,
) {
  return new Hono()
    .get("/:botId/engagement-samples", zValidator("query", querySchema), async (c) => {
      const result = await service.list({
        botId: c.req.param("botId"),
        ...c.req.valid("query"),
      });
      if (!result) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({ ok: true as const, ...result });
    })
    .patch("/:botId/engagement-samples", zValidator("json", batchLabelSchema), async (c) => {
      const body = c.req.valid("json");
      const result = await service.updateLabels(c.req.param("botId"), body.ids, body.label);
      return c.json({ ok: true as const, ...result });
    })
    .patch("/:botId/engagement-samples/:sampleId", zValidator("json", labelSchema), async (c) => {
      const sampleId = Number(c.req.param("sampleId"));
      if (!Number.isSafeInteger(sampleId) || sampleId <= 0) {
        return c.json({ ok: false as const, error: "Invalid sampleId" }, 400);
      }
      const updated = await service.updateLabel(
        c.req.param("botId"),
        sampleId,
        c.req.valid("json").label,
      );
      if (!updated) {
        return c.json({ ok: false as const, error: "Engagement sample not found" }, 404);
      }
      return c.json({ ok: true as const, data: updated });
    });
}
