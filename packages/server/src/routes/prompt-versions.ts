import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Database } from "@cos-tool-bot/database";
import {
  PromptVersionError,
  PromptVersionService,
  promptSnapshotSchema,
} from "../services/prompt-versions.js";
import { resolveDeploymentVersion } from "../runtime-health.js";
export function promptVersionRoutes(db: Database) {
  const service = new PromptVersionService(
    db,
    resolveDeploymentVersion({ environmentValue: process.env.APP_VERSION }),
  );
  return new Hono()
    .onError((error, c) => {
      if (error instanceof PromptVersionError)
        return c.json({ ok: false as const, error: error.message }, error.status);
      throw error;
    })
    .get("/:botId/prompt-versions", async (c) =>
      c.json({ ok: true as const, data: await service.list(c.req.param("botId")) }),
    )
    .get("/:botId/prompt-versions/working", async (c) =>
      c.json({ ok: true as const, data: await service.working(c.req.param("botId")) }),
    )
    .get("/:botId/prompt-versions/:id", async (c) =>
      c.json({
        ok: true as const,
        data: await service.get(c.req.param("botId"), c.req.param("id")),
      }),
    )
    .post(
      "/:botId/prompt-versions/preview",
      zValidator("json", z.object({ snapshot: promptSnapshotSchema })),
      async (c) =>
        c.json({
          ok: true as const,
          data: await service.preview(c.req.param("botId"), c.req.valid("json").snapshot),
        }),
    )
    .post(
      "/:botId/prompt-versions",
      zValidator(
        "json",
        z.object({
          name: z.string().trim().min(1).max(100),
          description: z.string().max(2000).default(""),
          snapshot: promptSnapshotSchema,
        }),
      ),
      async (c) =>
        c.json(
          {
            ok: true as const,
            data: await service.create(c.req.param("botId"), c.req.valid("json")),
          },
          201,
        ),
    )
    .post(
      "/:botId/prompt-versions/activate",
      zValidator("json", z.object({ id: z.string().uuid().nullable() })),
      async (c) =>
        c.json({
          ok: true as const,
          data: await service.activate(c.req.param("botId"), c.req.valid("json").id),
        }),
    )
    .delete("/:botId/prompt-versions/:id", async (c) => {
      await service.remove(c.req.param("botId"), c.req.param("id"));
      return c.json({ ok: true as const });
    });
}
