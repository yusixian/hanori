import { PluginConfigError } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PluginConfigStoreError } from "../services/plugins/config-store.js";
import { PluginManagerError, type PluginManager } from "../services/plugins/manager.js";
import { pluginMediaJobRoutes, type PluginMediaJobsOptions } from "./plugin-media-jobs.js";
import { pluginLoginRoutes } from "./plugin-login.js";

const id = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
  .max(100);
const param = z.object({ id });
const botParam = z.object({ id, botId: z.uuid() });
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const revision = z.number().int().min(1).max(2_147_483_646);
const configSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    enabled: z.boolean().optional(),
    configuration: z
      .object({
        values: z.record(
          z.string().max(64),
          z.union([z.string().max(16_384), z.number().finite(), z.boolean(), z.null()]),
        ),
        secrets: z.record(z.string().max(64), z.string().max(16_384).nullable()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Mounted behind workspace authentication AND owner/admin authorization in app.ts. */
export function pluginRoutes(manager?: PluginManager, mediaJobs?: PluginMediaJobsOptions) {
  const service = () => {
    if (!manager) throw new Error("Plugins are unavailable");
    return manager;
  };
  return new Hono()
    .use("*", bodyLimit({ maxSize: 128 * 1024 }))
    .onError((error, c) => {
      if (error instanceof PluginConfigStoreError || error instanceof PluginManagerError) {
        const status =
          error.code === "not_found"
            ? 404
            : ["stale_revision", "manifest_changed", "already_installed"].includes(error.code)
              ? 409
              : 400;
        return c.json({ ok: false as const, error: error.code }, status);
      }
      if (error instanceof PluginConfigError)
        return c.json({ ok: false as const, error: "invalid_configuration" }, 400);
      // Plugin exceptions may contain credentials. Never send or log their messages/stacks.
      return c.json(
        { ok: false as const, error: manager ? "plugin_operation_failed" : "plugins_unavailable" },
        manager ? 400 : 503,
      );
    })
    .route("/", pluginMediaJobRoutes(mediaJobs))
    .route("/", pluginLoginRoutes(manager?.logins))
    .get("/", async (c) => c.json({ ok: true as const, data: await service().list() }))
    .post(
      "/install",
      zValidator(
        "json",
        z.union([
          z.object({ builtinId: id, trustHostAccess: z.literal(true) }).strict(),
          z
            .object({ repository: z.string().max(300), commit, trustHostAccess: z.literal(true) })
            .strict(),
        ]),
      ),
      async (c) =>
        c.json(
          {
            ok: true as const,
            data: await service().install(c.req.valid("json"), c.req.raw.signal),
          },
          201,
        ),
    )
    .post(
      "/:id/update",
      zValidator("param", param),
      zValidator("json", z.object({ commit, expectedRevision: revision }).strict()),
      async (c) => {
        const body = c.req.valid("json");
        return c.json({
          ok: true as const,
          data: await service().update(
            c.req.valid("param").id,
            body.commit,
            body.expectedRevision,
            c.req.raw.signal,
          ),
        });
      },
    )
    .post(
      "/:id/rollback",
      zValidator("param", param),
      zValidator("json", z.object({ expectedRevision: revision }).strict()),
      async (c) =>
        c.json({
          ok: true as const,
          data: await service().rollback(
            c.req.valid("param").id,
            c.req.valid("json").expectedRevision,
          ),
        }),
    )
    .delete(
      "/:id",
      zValidator("param", param),
      zValidator("json", z.object({ expectedRevision: revision }).strict()),
      async (c) => {
        await service().uninstall(c.req.valid("param").id, c.req.valid("json").expectedRevision);
        return c.json({ ok: true as const });
      },
    )
    .get("/:id/bots/:botId", zValidator("param", botParam), async (c) => {
      const { id, botId } = c.req.valid("param");
      return c.json({ ok: true as const, data: await service().getBot(id, botId) });
    })
    .patch(
      "/:id/bots/:botId",
      zValidator("param", botParam),
      zValidator("json", configSchema),
      async (c) => {
        const { id, botId } = c.req.valid("param");
        return c.json({
          ok: true as const,
          data: await service().saveBot(id, botId, c.req.valid("json")),
        });
      },
    )
    .post("/:id/bots/:botId/test", zValidator("param", botParam), async (c) => {
      const { id, botId } = c.req.valid("param");
      return c.json({ ok: true as const, data: await service().checkBot(id, botId) });
    });
}
