import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { RssFeedService } from "../services/rss-feed-service.js";

const createCollectionSchema = z.object({
  chatId: z.number(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  digestPrompt: z.string().optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  digestMinute: z.number().int().min(0).max(59).optional(),
});

const updateCollectionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  digestPrompt: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  digestMinute: z.number().int().min(0).max(59).optional(),
  chatId: z.number().optional(),
});

const addFeedSchema = z.object({
  feedUrl: z.string().url(),
  title: z.string().optional(),
});

const idParamSchema = z.object({
  botId: z.string(),
  id: z.coerce.number().int().positive(),
});

const feedIdParamSchema = z.object({
  botId: z.string(),
  id: z.coerce.number().int().positive(),
  feedId: z.coerce.number().int().positive(),
});

const notFound = { ok: false as const, error: "Not found" } as const;

export function rssRoutes(rssFeedService: RssFeedService) {
  async function requireCollection(botId: string, id: number) {
    const collection = await rssFeedService.getCollection(id);
    if (!collection || collection.botId !== botId) return null;
    return collection;
  }

  return new Hono()
    .get("/:botId/rss/collections", async (c) => {
      const botId = c.req.param("botId");
      const data = await rssFeedService.listCollections(botId);
      return c.json({ ok: true as const, data });
    })
    .post("/:botId/rss/collections", zValidator("json", createCollectionSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");
      const data = await rssFeedService.createCollection({ botId, ...body });
      return c.json({ ok: true as const, data });
    })
    .get("/:botId/rss/collections/:id", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      const collection = await requireCollection(botId, id);
      if (!collection) return c.json(notFound, 404);
      const feeds = await rssFeedService.listFeeds(id);
      return c.json({ ok: true as const, data: { ...collection, feeds } });
    })
    .patch(
      "/:botId/rss/collections/:id",
      zValidator("param", idParamSchema),
      zValidator("json", updateCollectionSchema),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
        const body = c.req.valid("json");
        const data = await rssFeedService.updateCollection(id, body);
        if (!data) return c.json(notFound, 404);
        return c.json({ ok: true as const, data });
      },
    )
    .delete("/:botId/rss/collections/:id", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
      const ok = await rssFeedService.deleteCollection(id);
      if (!ok) return c.json(notFound, 404);
      return c.json({ ok: true as const });
    })
    .post(
      "/:botId/rss/collections/:id/feeds",
      zValidator("param", idParamSchema),
      zValidator("json", addFeedSchema),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
        const body = c.req.valid("json");
        const data = await rssFeedService.addFeed(id, body.feedUrl, body.title);
        return c.json({ ok: true as const, data });
      },
    )
    .delete(
      "/:botId/rss/collections/:id/feeds/:feedId",
      zValidator("param", feedIdParamSchema),
      async (c) => {
        const { botId, id, feedId } = c.req.valid("param");
        if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
        const ok = await rssFeedService.removeFeed(feedId);
        if (!ok) return c.json(notFound, 404);
        return c.json({ ok: true as const });
      },
    )
    .get(
      "/:botId/rss/collections/:id/items",
      zValidator("param", idParamSchema),
      zValidator(
        "query",
        z.object({
          limit: z.string().optional(),
          offset: z.string().optional(),
          undigested: z.string().optional(),
        }),
      ),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
        const query = c.req.valid("query");
        const limit = Number(query.limit ?? 50);
        const offset = Number(query.offset ?? 0);
        const undigested = query.undigested === "true";
        const data = await rssFeedService.getItems(id, { limit, offset, undigested });
        return c.json({ ok: true as const, data });
      },
    )
    .post("/:botId/rss/collections/:id/digest", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
      const triggered = await rssFeedService.triggerDigest(id);
      return c.json({ ok: true as const, triggered });
    })
    .post("/:botId/rss/collections/:id/poll", zValidator("param", idParamSchema), async (c) => {
      const { botId, id } = c.req.valid("param");
      if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
      const newItems = await rssFeedService.pollCollection(id);
      return c.json({ ok: true as const, newItems });
    })
    .post(
      "/:botId/rss/collections/:id/mark-digest",
      zValidator("param", idParamSchema),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
        await rssFeedService.markDigested(id);
        return c.json({ ok: true as const });
      },
    )
    .post(
      "/:botId/rss/collections/:id/unmark-digest",
      zValidator("param", idParamSchema),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
        await rssFeedService.unmarkDigested(id);
        return c.json({ ok: true as const });
      },
    )
    .post(
      "/:botId/rss/collections/:id/unmark-items",
      zValidator("param", idParamSchema),
      zValidator("json", z.object({ itemIds: z.array(z.number()).min(1) })),
      async (c) => {
        const { botId, id } = c.req.valid("param");
        if (!(await requireCollection(botId, id))) return c.json(notFound, 404);
        const body = c.req.valid("json");
        await rssFeedService.unmarkItemsDigested(body.itemIds);
        return c.json({ ok: true as const });
      },
    );
}
