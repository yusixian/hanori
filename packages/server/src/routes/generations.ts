import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "@cos-tool-bot/database";
import { imageGenerationEvents, imageGenerations, pixaiGenerations } from "@cos-tool-bot/database";
import { type ImageGenerationRequestSnapshot } from "@cos-tool-bot/shared";
import { getDataDir } from "@cos-tool-bot/shared/file-validation";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { BotPool } from "../services/bot-pool.js";
import type { ImageGenerationService } from "../services/image-generation-service.js";

const querySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.enum(["active", "succeeded", "failed", "cancelled", "attention"]).optional(),
  source: z.enum(["unified", "legacy"]).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

type StatusGroup = NonNullable<z.infer<typeof querySchema>["status"]>;

export function generationRoutes(
  db: Database,
  botPool: BotPool,
  imageGenerationService: ImageGenerationService,
) {
  return (
    new Hono()
      .get("/:botId/generations", zValidator("query", querySchema), async (c) => {
        const botId = c.req.param("botId");
        const { page, pageSize, status, source, q, from, to } = c.req.valid("query");
        const [currentRows, legacyRows] = await Promise.all([
          source === "legacy"
            ? Promise.resolve([])
            : db
                .select()
                .from(imageGenerations)
                .where(eq(imageGenerations.botId, botId))
                .orderBy(desc(imageGenerations.createdAt)),
          source === "unified"
            ? Promise.resolve([])
            : db
                .select()
                .from(pixaiGenerations)
                .where(eq(pixaiGenerations.botId, botId))
                .orderBy(desc(pixaiGenerations.createdAt)),
        ]);

        const needle = q?.toLocaleLowerCase();
        const data = [...currentRows.map(mapCurrentListItem), ...legacyRows.map(mapLegacyListItem)]
          .filter((item) => !status || item.statusGroup === status)
          .filter((item) => !from || new Date(item.createdAt) >= from)
          .filter((item) => !to || new Date(item.createdAt) <= endOfDay(to))
          .filter(
            (item) =>
              !needle ||
              [item.id, item.prompt, item.presetKey, item.provider]
                .filter(Boolean)
                .some((value) => String(value).toLocaleLowerCase().includes(needle)),
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const total = data.length;
        const offset = (page - 1) * pageSize;
        return c.json({
          ok: true as const,
          data: data.slice(offset, offset + pageSize),
          total,
          page,
          pageSize,
        });
      })
      .get("/:botId/generations/unified/:generationId", async (c) => {
        const botId = c.req.param("botId");
        const generationId = c.req.param("generationId");
        const [row] = await db
          .select()
          .from(imageGenerations)
          .where(and(eq(imageGenerations.botId, botId), eq(imageGenerations.id, generationId)));
        if (!row) return c.json({ ok: false as const, error: "Generation not found" }, 404);

        const [events, requestSnapshot] = await Promise.all([
          db
            .select()
            .from(imageGenerationEvents)
            .where(
              and(
                eq(imageGenerationEvents.botId, botId),
                eq(imageGenerationEvents.generationId, generationId),
              ),
            )
            .orderBy(asc(imageGenerationEvents.createdAt)),
          imageGenerationService.getAdminRequestSnapshot(botId, generationId),
        ]);

        return c.json({
          ok: true as const,
          data: {
            ...mapCurrentListItem(row),
            negativePrompt: row.negativePrompt,
            seed: row.seed,
            purpose: row.purpose,
            approvalState: row.approvalState,
            providerOperationId: row.providerOperationId,
            providerState: row.providerState,
            requestSnapshot: requestSnapshot ?? row.requestSnapshot,
            artifacts: row.artifacts,
            errorCode: row.errorCode,
            deliveredAt: toIso(row.deliveredAt),
            updatedAt: row.updatedAt.toISOString(),
            technical: sanitizeProviderMetadata(row.providerMetadata),
            events: events.map((event) => ({
              id: event.id,
              kind: event.kind,
              state: event.state,
              providerState: event.providerState,
              metadata: sanitizeEventMetadata(event.metadata),
              createdAt: event.createdAt.toISOString(),
            })),
          },
        });
      })
      .get("/:botId/generations/legacy/:generationId", async (c) => {
        const botId = c.req.param("botId");
        const generationId = Number(c.req.param("generationId"));
        if (!Number.isSafeInteger(generationId)) {
          return c.json({ ok: false as const, error: "Invalid generationId" }, 400);
        }
        const [row] = await db
          .select()
          .from(pixaiGenerations)
          .where(and(eq(pixaiGenerations.botId, botId), eq(pixaiGenerations.id, generationId)));
        if (!row) return c.json({ ok: false as const, error: "Generation not found" }, 404);
        return c.json({
          ok: true as const,
          data: {
            ...mapLegacyListItem(row),
            negativePrompt: row.negativePrompt,
            seed: null,
            purpose: "anime_illustration",
            approvalState: null,
            providerOperationId: row.taskId,
            providerState: row.status,
            requestSnapshot: legacySnapshot(row),
            artifacts: [],
            errorCode: null,
            deliveredAt: toIso(row.completedAt),
            updatedAt: toIso(row.completedAt) ?? row.createdAt.toISOString(),
            technical: sanitizeLegacyConfig(row.pixaiConfig),
            events: legacyMilestones(row),
          },
        });
      })
      .delete("/:botId/generations/unified/:generationId", async (c) => {
        const result = await imageGenerationService.deleteAdminGeneration(
          c.req.param("botId"),
          c.req.param("generationId"),
        );
        if (result === "not_found") {
          return c.json({ ok: false as const, error: "Generation not found" }, 404);
        }
        if (result === "not_terminal") {
          return c.json(
            { ok: false as const, error: "Cancel an active generation before deleting it" },
            409,
          );
        }
        return c.json({ ok: true as const });
      })
      .delete("/:botId/generations/legacy/:generationId", async (c) => {
        const generationId = Number(c.req.param("generationId"));
        if (!Number.isSafeInteger(generationId)) {
          return c.json({ ok: false as const, error: "Invalid generationId" }, 400);
        }
        const result = await deleteLegacyGeneration(
          db,
          botPool,
          c.req.param("botId"),
          generationId,
        );
        if (result === "not_found") {
          return c.json({ ok: false as const, error: "Generation not found" }, 404);
        }
        if (result === "not_terminal") {
          return c.json(
            { ok: false as const, error: "Cancel an active generation before deleting it" },
            409,
          );
        }
        return c.json({ ok: true as const });
      })
      // Compatibility for existing clients: the unqualified numeric route is legacy history.
      .delete("/:botId/generations/:generationId", async (c) => {
        const generationId = Number(c.req.param("generationId"));
        if (!Number.isSafeInteger(generationId)) {
          return c.json({ ok: false as const, error: "Invalid generationId" }, 400);
        }
        const result = await deleteLegacyGeneration(
          db,
          botPool,
          c.req.param("botId"),
          generationId,
        );
        if (result === "not_found") {
          return c.json({ ok: false as const, error: "Generation not found" }, 404);
        }
        if (result === "not_terminal") {
          return c.json(
            { ok: false as const, error: "Cancel an active generation before deleting it" },
            409,
          );
        }
        return c.json({ ok: true as const });
      })
  );
}

function mapCurrentListItem(row: typeof imageGenerations.$inferSelect) {
  return {
    source: "unified" as const,
    legacy: false,
    id: row.id,
    provider: row.provider,
    state: row.state,
    statusGroup: currentStatusGroup(row.state),
    prompt: row.prompt,
    presetKey: row.presetKey,
    requestSnapshot: row.requestSnapshot,
    localFiles: row.localFiles.map((file) => `generations/${file}`),
    filesPurgedAt: toIso(row.filesPurgedAt),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: toIso(row.completedAt),
    nsfwScores: row.artifacts.some((artifact) => artifact.nsfw?.scores)
      ? row.artifacts.flatMap((artifact) => (artifact.nsfw?.scores ? [artifact.nsfw.scores] : []))
      : null,
  };
}

function mapLegacyListItem(row: typeof pixaiGenerations.$inferSelect) {
  return {
    source: "legacy" as const,
    legacy: true,
    id: String(row.id),
    provider: "legacy_pixai",
    state: row.status,
    statusGroup: legacyStatusGroup(row.status),
    prompt: row.prompt,
    presetKey: null,
    requestSnapshot: legacySnapshot(row),
    localFiles: row.localFiles?.map((file) => `generations/${file}`) ?? [],
    filesPurgedAt: toIso(row.filesPurgedAt),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: toIso(row.completedAt),
    nsfwScores: row.nsfwScores,
  };
}

function legacySnapshot(row: typeof pixaiGenerations.$inferSelect): ImageGenerationRequestSnapshot {
  return {
    modelId: row.modelId,
    width: row.width,
    height: row.height,
    batchSize: row.batchSize,
    samplingSteps: row.samplingSteps ?? undefined,
    cfgScale: row.cfgScale ?? undefined,
    promptHelper: row.promptHelper ?? undefined,
  };
}

function currentStatusGroup(state: string): StatusGroup {
  if (state === "succeeded") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "cancelled" || state === "waiting_stopped") return "cancelled";
  if (state === "attention_required" || state === "cancel_rejected") return "attention";
  return "active";
}

function legacyStatusGroup(status: string): StatusGroup {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "active";
}

function sanitizeProviderMetadata(metadata: Record<string, unknown> | null) {
  if (!metadata) return {};
  return pickDefined(metadata, ["planId", "phase", "terminal", "nextAction", "cancelRequested"]);
}

function sanitizeEventMetadata(metadata: Record<string, unknown> | null) {
  if (!metadata) return {};
  return pickDefined(metadata, ["artifactCount", "deliveryMessageCount", "errorCode"]);
}

function sanitizeLegacyConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return pickDefined(value as Record<string, unknown>, [
    "sampler",
    "samplingSteps",
    "cfgScale",
    "promptHelper",
  ]);
}

function pickDefined(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
}

function legacyMilestones(row: typeof pixaiGenerations.$inferSelect) {
  const events = [
    {
      id: `legacy-${row.id}-created`,
      kind: "created",
      state: "pending",
      providerState: "pending",
      metadata: {},
      createdAt: row.createdAt.toISOString(),
    },
  ];
  if (row.completedAt) {
    events.push({
      id: `legacy-${row.id}-completed`,
      kind: row.status === "failed" ? "failed" : "artifacts_saved",
      state: row.status,
      providerState: row.status,
      metadata: {},
      createdAt: row.completedAt.toISOString(),
    });
  }
  return events;
}

async function deleteLegacyGeneration(
  db: Database,
  botPool: BotPool,
  botId: string,
  generationId: number,
): Promise<"deleted" | "not_found" | "not_terminal"> {
  const where = and(eq(pixaiGenerations.id, generationId), eq(pixaiGenerations.botId, botId));
  const [existing] = await db.select().from(pixaiGenerations).where(where);
  if (!existing) return "not_found";
  if (existing.status !== "completed" && existing.status !== "failed") return "not_terminal";
  botPool.suppressGenerationFallback(botId, existing.taskId);
  const [deleted] = await db.delete(pixaiGenerations).where(where).returning();
  if (!deleted) return "not_found";
  const dir = join(getDataDir(botId), "generations");
  await Promise.allSettled(
    (deleted.localFiles ?? [])
      .filter((file) => file === file.split(/[\\/]/).at(-1))
      .map((file) => unlink(join(dir, file))),
  );
  return "deleted";
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function endOfDay(value: Date): Date {
  const end = new Date(value);
  end.setHours(23, 59, 59, 999);
  return end;
}
