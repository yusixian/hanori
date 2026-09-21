import { zValidator } from "@hono/zod-validator";
import type { GenerationLibraryActor, LibraryListQuery } from "@cos-tool-bot/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../middleware/better-auth.js";
import { ownerOrAdmin } from "../middleware/better-auth.js";
import {
  GenerationLibraryError,
  type GenerationLibraryService,
} from "../services/generation-library-service.js";

const id = z.coerce.number().int().positive();
const telegramId = z.coerce.number().int().positive().max(9_007_199_254_740_991);
const botParamSchema = z.object({ botId: z.string().min(1) });
const itemParamSchema = botParamSchema.extend({ id });
const bindingParamSchema = botParamSchema.extend({ telegramId });
const bindingItemParamSchema = bindingParamSchema.extend({
  characterId: id,
  relation: z.enum(["representation", "favorite"]),
});
const listQuerySchema = z
  .object({
    search: z.string().trim().max(160).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    source: z.enum(["danbooru", "original"]).optional(),
    type: z.enum(["artist_string", "style", "outfit", "trait", "composition"]).optional(),
    safety: z.enum(["safe", "nsfw"]).optional(),
    sort: z.enum(["frequency", "recent"]).optional(),
  })
  .strict();
const characterSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    aliases: z.array(z.string().trim().min(1).max(160)).max(100),
    appearance: z.string().trim().max(4_000),
    defaultOutfit: z.string().trim().max(2_000),
    notes: z.string().trim().max(4_000),
    copyright: z.string().trim().max(200).optional(),
    ownerTelegramId: z.number().int().positive().max(9_007_199_254_740_991).optional(),
  })
  .strict();
const assetSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: z.enum(["artist_string", "style", "outfit", "trait", "composition"]),
    content: z.string().trim().min(1).max(8_000),
    notes: z.string().trim().max(4_000),
    safety: z.enum(["safe", "nsfw"]),
    pinned: z.boolean(),
  })
  .strict();
const settingsSchema = z
  .object({
    charactersEnabled: z.boolean(),
    assetsEnabled: z.boolean(),
    injectionEnabled: z.boolean(),
    nsfwEnabled: z.boolean(),
  })
  .strict();
const bindingSchema = z
  .object({
    characterId: z.number().int().positive(),
    relation: z.enum(["representation", "favorite"]),
    isDefault: z.boolean(),
  })
  .strict();

type RouteContext = Context<{ Variables: AuthVariables }>;

export function generationLibraryRoutes(service: GenerationLibraryService) {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/:botId/generation-library/settings", zValidator("param", botParamSchema), async (c) =>
      respond(c, () => service.getSettings(actor(c))),
    )
    .put(
      "/:botId/generation-library/settings",
      zValidator("param", botParamSchema),
      zValidator("json", settingsSchema),
      async (c) => adminWrite(c, () => service.updateSettings(actor(c), c.req.valid("json"))),
    )
    .get(
      "/:botId/generation-library/characters",
      zValidator("param", botParamSchema),
      zValidator("query", listQuerySchema),
      async (c) => {
        const query = c.req.valid("query") as LibraryListQuery;
        return respondPage(c, () => service.listCharacters(actor(c), query));
      },
    )
    .post(
      "/:botId/generation-library/characters",
      zValidator("param", botParamSchema),
      zValidator("json", characterSchema),
      async (c) => adminWrite(c, () => service.saveCharacter(actor(c), c.req.valid("json"))),
    )
    .put(
      "/:botId/generation-library/characters/:id",
      zValidator("param", itemParamSchema),
      zValidator("json", characterSchema),
      async (c) =>
        adminWrite(c, () =>
          service.saveCharacter(actor(c), c.req.valid("json"), c.req.valid("param").id),
        ),
    )
    .delete(
      "/:botId/generation-library/characters/:id",
      zValidator("param", itemParamSchema),
      async (c) =>
        adminWrite(c, () => service.deleteCharacter(actor(c), c.req.valid("param").id), true),
    )
    .get(
      "/:botId/generation-library/assets",
      zValidator("param", botParamSchema),
      zValidator("query", listQuerySchema),
      async (c) => {
        const query = c.req.valid("query") as LibraryListQuery;
        return respondPage(c, () => service.listAssets(actor(c), query));
      },
    )
    .post(
      "/:botId/generation-library/assets",
      zValidator("param", botParamSchema),
      zValidator("json", assetSchema),
      async (c) => adminWrite(c, () => service.saveAsset(actor(c), c.req.valid("json"))),
    )
    .put(
      "/:botId/generation-library/assets/:id",
      zValidator("param", itemParamSchema),
      zValidator("json", assetSchema),
      async (c) =>
        adminWrite(c, () =>
          service.saveAsset(actor(c), c.req.valid("json"), c.req.valid("param").id),
        ),
    )
    .delete(
      "/:botId/generation-library/assets/:id",
      zValidator("param", itemParamSchema),
      async (c) =>
        adminWrite(c, () => service.deleteAsset(actor(c), c.req.valid("param").id), true),
    )
    .get(
      "/:botId/generation-library/bindings/:telegramId",
      zValidator("param", bindingParamSchema),
      async (c) => respond(c, () => service.getBindings(actor(c), c.req.valid("param").telegramId)),
    )
    .put(
      "/:botId/generation-library/bindings/:telegramId",
      zValidator("param", bindingParamSchema),
      zValidator("json", bindingSchema),
      async (c) =>
        adminWrite(
          c,
          () => service.setBinding(actor(c), c.req.valid("param").telegramId, c.req.valid("json")),
          true,
        ),
    )
    .delete(
      "/:botId/generation-library/bindings/:telegramId/:characterId/:relation",
      zValidator("param", bindingItemParamSchema),
      async (c) =>
        adminWrite(
          c,
          () => {
            const params = c.req.valid("param");
            return service.removeBinding(
              actor(c),
              params.telegramId,
              params.characterId,
              params.relation,
            );
          },
          true,
        ),
    );
}

function actor(c: RouteContext): GenerationLibraryActor {
  return {
    botId: c.req.param("botId"),
    source: "panel",
    isAdmin: ownerOrAdmin.has(c.get("authMember").role),
  };
}

async function adminWrite<T>(c: RouteContext, operation: () => Promise<T>, empty = false) {
  if (!ownerOrAdmin.has(c.get("authMember").role)) {
    return c.json({ ok: false as const, error: "当前角色没有权限执行该操作" }, 403);
  }
  return empty ? respondEmpty(c, operation) : respond(c, operation);
}

async function respond<T>(c: RouteContext, operation: () => Promise<T>) {
  try {
    return c.json({ ok: true as const, data: await operation() });
  } catch (error) {
    return generationLibraryErrorResponse(c, error);
  }
}

async function respondPage<T>(
  c: RouteContext,
  operation: () => Promise<{ data: T[]; total: number }>,
) {
  try {
    const page = await operation();
    return c.json({ ok: true as const, data: page.data, total: page.total });
  } catch (error) {
    return generationLibraryErrorResponse(c, error);
  }
}

async function respondEmpty<T>(c: RouteContext, operation: () => Promise<T>) {
  try {
    await operation();
    return c.json({ ok: true as const });
  } catch (error) {
    return generationLibraryErrorResponse(c, error);
  }
}

function generationLibraryErrorResponse(c: RouteContext, error: unknown) {
  if (!(error instanceof GenerationLibraryError)) throw error;
  const status =
    error.code === "invalid_input"
      ? 400
      : error.code === "forbidden" || error.code === "privacy_denied"
        ? 403
        : error.code === "not_found"
          ? 404
          : error.code === "prompt_too_long" || error.code === "too_many_selections"
            ? 422
            : 409;
  return c.json({ ok: false as const, code: error.code, error: error.message }, status);
}
