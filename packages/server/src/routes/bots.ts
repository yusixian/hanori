import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import type { AiConfigPublic, AiConfigStored, BotWithStatus } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { env } from "../env.js";
import type { BotPool } from "../services/bot-pool.js";
import { decrypt, encrypt, maskToken } from "../utils/crypto.js";

const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  token: z.string().min(1),
  adminChatIds: z.array(z.number()).default([]),
  isActive: z.boolean().default(true),
});

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  token: z.string().min(1).optional(),
  adminChatIds: z.array(z.number()).optional(),
  isActive: z.boolean().optional(),
});

function toBotWithStatus(bot: typeof bots.$inferSelect, botPool: BotPool): BotWithStatus {
  const manager = botPool.getManager(bot.id);
  const token = decrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
  const tokenMasked = token === "__IMPORT_PLACEHOLDER__" ? "(未配置)" : maskToken(token);
  return {
    id: bot.id,
    name: bot.name,
    tokenMasked,
    adminChatIds: bot.adminChatIds,
    isActive: bot.isActive,
    aiEnabled: bot.aiConfig?.enabled ?? false,
    aiHasApiKey: !!bot.aiConfig?.encryptedApiKey,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt?.toISOString() ?? null,
    status: manager?.status ?? "stopped",
    uptime: manager?.uptime ?? null,
  };
}

function toAiConfigPublic(config: AiConfigStored | null | undefined): AiConfigPublic {
  if (!config) {
    return {
      enabled: false,
      hasApiKey: false,
      baseURL: "",
      model: "",
      systemPrompt: "",
      triggerConfig: {
        replyToBot: true,
        mentionBot: true,
        triggerWords: [],
        randomReplyPercent: 0,
        randomReplyCooldown: 60,
      },
      groupOverrides: {},
    };
  }
  return {
    enabled: config.enabled,
    hasApiKey: !!config.encryptedApiKey,
    baseURL: config.baseURL,
    model: config.model,
    systemPrompt: config.systemPrompt,
    behavioralPrompt: config.behavioralPrompt,
    groupBehavioralPrompt: config.groupBehavioralPrompt,
    triggerConfig: config.triggerConfig,
    groupOverrides: config.groupOverrides,
    conversationConfig: config.conversationConfig,
    memoryConfig: config.memoryConfig,
    stickerPacks: config.stickerPacks,
    webToolsConfig: config.webToolsConfig,
    agentToolsConfig: config.agentToolsConfig,
    artworkToolsConfig: config.artworkToolsConfig,
    botMemoryConfig: config.botMemoryConfig,
  };
}

const aiConfigSchema = z
  .object({
    enabled: z.boolean(),
    apiKey: z.string().optional(),
    baseURL: z.string(),
    model: z.string(),
    systemPrompt: z.string(),
    behavioralPrompt: z.string().optional(),
    groupBehavioralPrompt: z.string().optional(),
    triggerConfig: z.object({
      replyToBot: z.boolean(),
      mentionBot: z.boolean(),
      triggerWords: z.array(z.string()),
      randomReplyPercent: z.number().min(0).max(100),
      randomReplyCooldown: z.number().min(0),
    }),
    groupOverrides: z.record(
      z.string(),
      z.object({
        chatId: z.number(),
        chatTitle: z.string().optional(),
        enabled: z.boolean().optional(),
        whitelisted: z.boolean(),
        systemPrompt: z.string().optional(),
        triggerConfig: z
          .object({
            replyToBot: z.boolean(),
            mentionBot: z.boolean(),
            triggerWords: z.array(z.string()),
            randomReplyPercent: z.number().min(0).max(100),
            randomReplyCooldown: z.number().min(0),
          })
          .partial()
          .optional(),
        conversationEnabled: z.boolean().optional(),
        maxContextMessages: z.number().min(1).max(100).optional(),
      }),
    ),
    conversationConfig: z
      .object({
        enabled: z.boolean(),
        maxContextMessages: z.number().min(1).max(100),
        historyFormat: z.enum(["prompt", "messages"]).optional(),
        groupBufferSize: z.number().min(10).max(200),
        groupContextMode: z.enum(["all", "random_only", "none"]),
        saveGroupContext: z.enum(["random_only", "all", "none"]),
        autoSummarize: z.boolean(),
        summarizeThreshold: z.number().min(10).max(200),
        retentionDays: z.number().min(0).max(365),
      })
      .optional(),
    memoryConfig: z
      .object({
        enabled: z.boolean(),
        maxSteps: z.number().min(1).max(10),
        autoReadProfile: z.boolean(),
        autoUpdateLastSeen: z.boolean(),
        toolChoice: z.enum(["auto", "required"]),
      })
      .optional(),
    webToolsConfig: z
      .object({
        enabled: z.boolean(),
        search: z
          .object({
            provider: z.enum(["tavily", "searxng", "custom"]),
            apiKey: z.string().optional(),
            baseURL: z.string().optional(),
          })
          .optional(),
        imageGeneration: z
          .object({
            provider: z.enum(["openai", "custom"]),
            apiKey: z.string().optional(),
            baseURL: z.string().optional(),
            model: z.string().optional(),
            size: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    agentToolsConfig: z
      .object({
        enabled: z.boolean(),
        subAgentModel: z.string().optional(),
        maxSubAgentSteps: z.number().min(1).max(15).optional(),
        agents: z
          .record(
            z.string(),
            z.object({
              enabled: z.boolean().optional(),
              systemPrompt: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    artworkToolsConfig: z
      .object({
        enabled: z.boolean(),
        pixivCookie: z.string().optional(),
      })
      .optional(),
    botMemoryConfig: z
      .object({
        enabled: z.boolean(),
        maxMemories: z.number().min(1).max(100),
        autoInjectMemories: z.boolean(),
      })
      .optional(),
    stickerPacks: z.array(z.string()).optional(),
  })
  .refine((data) => !data.enabled || (data.baseURL.length > 0 && data.model.length > 0), {
    message: "baseURL and model are required when AI is enabled",
  });

const aiModelsSchema = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export function botsRoutes(db: Database, botPool: BotPool) {
  return new Hono()
    .get(
      "/",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(20),
        }),
      ),
      async (c) => {
        const { page, limit } = c.req.valid("query");
        const offset = (page - 1) * limit;

        const [allBots, [countResult]] = await Promise.all([
          db.select().from(bots).limit(limit).offset(offset),
          db.select({ total: count() }).from(bots),
        ]);

        const data = allBots.map((b) => toBotWithStatus(b, botPool));
        return c.json({ ok: true as const, data, total: Number(countResult?.total ?? 0) });
      },
    )
    .get("/:botId", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({ ok: true as const, data: toBotWithStatus(bot, botPool) });
    })
    .post("/", zValidator("json", createBotSchema), async (c) => {
      const body = c.req.valid("json");
      const encryptedToken = encrypt(body.token, env.ENCRYPTION_KEY);
      const rows = await db
        .insert(bots)
        .values({
          name: body.name,
          encryptedToken,
          adminChatIds: body.adminChatIds,
          isActive: body.isActive,
        })
        .returning();
      const created = rows[0]!;
      if (body.isActive) {
        try {
          await botPool.startBot(created.id);
        } catch {
          // Bot created but failed to start — still return success
        }
      }
      return c.json({ ok: true as const, data: toBotWithStatus(created, botPool) }, 201);
    })
    .put("/:botId", zValidator("json", updateBotSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");

      const [existing] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!existing) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const updates: Partial<typeof bots.$inferInsert> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.token !== undefined)
        updates.encryptedToken = encrypt(body.token, env.ENCRYPTION_KEY);
      if (body.adminChatIds !== undefined) updates.adminChatIds = body.adminChatIds;
      if (body.isActive !== undefined) updates.isActive = body.isActive;

      const rows = await db.update(bots).set(updates).where(eq(bots.id, botId)).returning();
      const updated = rows[0]!;

      const manager = botPool.getManager(botId);

      // Handle isActive lifecycle changes
      if (body.isActive !== undefined && body.isActive !== existing.isActive) {
        try {
          if (!body.isActive && manager) {
            await botPool.stopBot(botId);
          } else if (body.isActive && !manager) {
            await botPool.startBot(botId);
          }
        } catch {
          // continue
        }
      } else {
        // Restart running bot if token or adminChatIds changed
        const needsRestart = body.token !== undefined || body.adminChatIds !== undefined;
        if (manager && needsRestart) {
          try {
            await botPool.restartBot(botId);
          } catch {
            // continue
          }
        }
      }

      return c.json({ ok: true as const, data: toBotWithStatus(updated, botPool) });
    })
    .delete("/:botId", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      await botPool.stopBot(botId);
      await db.delete(bots).where(eq(bots.id, botId));
      return c.json({ ok: true as const });
    })
    .post("/:botId/start", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      await botPool.startBot(botId);
      return c.json({ ok: true as const });
    })
    .post("/:botId/stop", async (c) => {
      const botId = c.req.param("botId");
      await botPool.stopBot(botId);
      return c.json({ ok: true as const });
    })
    .post("/:botId/restart", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      await botPool.restartBot(botId);
      return c.json({ ok: true as const });
    })
    .get("/:botId/ai-config", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({ ok: true as const, data: toAiConfigPublic(bot.aiConfig) });
    })
    .put("/:botId/ai-config", zValidator("json", aiConfigSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");

      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      let encryptedApiKey = bot.aiConfig?.encryptedApiKey ?? null;
      if (body.apiKey !== undefined && body.apiKey !== "") {
        encryptedApiKey = encrypt(body.apiKey, env.ENCRYPTION_KEY);
      }

      const aiConfig: AiConfigStored = {
        enabled: body.enabled,
        encryptedApiKey,
        baseURL: body.baseURL,
        model: body.model,
        systemPrompt: body.systemPrompt,
        behavioralPrompt: body.behavioralPrompt,
        groupBehavioralPrompt: body.groupBehavioralPrompt,
        triggerConfig: body.triggerConfig,
        groupOverrides: body.groupOverrides,
        conversationConfig: body.conversationConfig,
        memoryConfig: body.memoryConfig,
        stickerPacks: body.stickerPacks ?? bot.aiConfig?.stickerPacks,
        webToolsConfig: body.webToolsConfig,
        agentToolsConfig: body.agentToolsConfig,
        artworkToolsConfig: body.artworkToolsConfig,
        botMemoryConfig: body.botMemoryConfig,
      };

      await db.update(bots).set({ aiConfig }).where(eq(bots.id, botId));

      // Restart bot if running so new config takes effect
      const manager = botPool.getManager(botId);
      if (manager) {
        try {
          await botPool.restartBot(botId);
        } catch {
          // continue
        }
      }

      return c.json({ ok: true as const, data: toAiConfigPublic(aiConfig) });
    })
    .get(
      "/:botId/conversations",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(20),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const { page, limit } = c.req.valid("query");
        const store = botPool.getConversationStore();
        const result = await store.getConversationList(botId, page, limit);
        return c.json({ ok: true as const, ...result });
      },
    )
    .get(
      "/:botId/conversations/:chatId",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(50),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const chatId = Number(c.req.param("chatId"));
        const { page, limit } = c.req.valid("query");
        const store = botPool.getConversationStore();
        const result = await store.getConversationMessages(botId, chatId, page, limit);
        return c.json({ ok: true as const, ...result });
      },
    )
    .delete("/:botId/conversations", async (c) => {
      const botId = c.req.param("botId");
      const store = botPool.getConversationStore();
      await store.clearAllForBot(botId);
      return c.json({ ok: true as const });
    })
    .delete("/:botId/conversations/:chatId", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      const store = botPool.getConversationStore();
      await store.clearHistory(botId, chatId);
      return c.json({ ok: true as const });
    })
    .get(
      "/:botId/profiles",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(20),
          search: z.string().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const { page, limit, search } = c.req.valid("query");
        const store = botPool.getProfileStore();
        if (search) {
          const profiles = await store.searchProfiles(botId, search);
          return c.json({
            ok: true as const,
            data: profiles.map((p) => ({
              id: p.id,
              telegramId: p.telegramId,
              username: p.username,
              displayName: p.displayName,
              notes: p.notes,
              traits: p.traits,
              interests: p.interests,
              relationship: p.relationship,
              firstSeen: p.firstSeen.toISOString(),
              lastSeen: p.lastSeen.toISOString(),
            })),
            total: profiles.length,
          });
        }
        const result = await store.listProfiles(botId, page, limit);
        return c.json({ ok: true as const, ...result });
      },
    )
    .delete("/:botId/profiles/:profileId", async (c) => {
      const botId = c.req.param("botId");
      const profileId = Number(c.req.param("profileId"));
      const store = botPool.getProfileStore();
      await store.deleteProfile(botId, profileId);
      return c.json({ ok: true as const });
    })
    .put(
      "/:botId/profiles/:profileId",
      zValidator(
        "json",
        z.object({
          displayName: z.string().nullable().optional(),
          username: z.string().nullable().optional(),
          notes: z.string().nullable().optional(),
          traits: z.array(z.string()).nullable().optional(),
          interests: z.array(z.string()).nullable().optional(),
          relationship: z.string().nullable().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const profileId = Number(c.req.param("profileId"));
        const store = botPool.getProfileStore();
        const updated = await store.updateProfile(botId, profileId, c.req.valid("json"));
        if (!updated) return c.json({ ok: false as const, error: "Profile not found" }, 404);
        return c.json({ ok: true as const, data: updated });
      },
    )
    .post(
      "/:botId/profiles",
      zValidator(
        "json",
        z.object({
          telegramId: z.number(),
          displayName: z.string().nullable().optional(),
          username: z.string().nullable().optional(),
          notes: z.string().nullable().optional(),
          traits: z.array(z.string()).optional(),
          interests: z.array(z.string()).optional(),
          relationship: z.string().nullable().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const store = botPool.getProfileStore();
        const created = await store.createProfile(botId, c.req.valid("json"));
        return c.json({ ok: true as const, data: created }, 201);
      },
    )
    .post("/:botId/ai-models", zValidator("json", aiModelsSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");

      let apiKey = body.apiKey;
      let baseURL = body.baseURL;

      // Fall back to stored values
      if (!apiKey || !baseURL) {
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

        if (!baseURL) baseURL = bot.aiConfig?.baseURL;
        if (!apiKey && bot.aiConfig?.encryptedApiKey) {
          apiKey = decrypt(bot.aiConfig.encryptedApiKey, env.ENCRYPTION_KEY);
        }
      }

      if (!baseURL) {
        return c.json({ ok: false as const, error: "No base URL configured" }, 400);
      }
      if (!apiKey) {
        return c.json({ ok: false as const, error: "No API key configured" }, 400);
      }

      try {
        const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data: models } = (await res.json()) as {
          data: Array<{ id: string; owned_by: string }>;
        };
        return c.json({
          ok: true as const,
          data: models.map((m) => ({ id: m.id, owned_by: m.owned_by })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: `Failed to fetch models: ${msg}` }, 502);
      }
    })
    .get("/:botId/memories/meta", async (c) => {
      const botId = c.req.param("botId");
      const store = botPool.getBotMemoryStore();
      const categories = await store.getCategories(botId);
      return c.json({ ok: true as const, data: { categories } });
    })
    .get(
      "/:botId/memories",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(20),
          category: z.string().optional(),
          telegramId: z.string().optional(),
          search: z.string().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const { page, limit, category, telegramId, search } = c.req.valid("query");
        const store = botPool.getBotMemoryStore();

        let tidFilter: number | "general" | undefined;
        if (telegramId === "general") {
          tidFilter = "general";
        } else if (telegramId) {
          const num = Number(telegramId);
          if (!Number.isNaN(num)) tidFilter = num;
        }

        const result = await store.listMemories(botId, page, limit, {
          category,
          telegramId: tidFilter,
          search,
        });
        return c.json({ ok: true as const, ...result });
      },
    )
    .post(
      "/:botId/memories",
      zValidator(
        "json",
        z.object({
          content: z.string().min(1),
          category: z.string().optional(),
          telegramId: z.number().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const body = c.req.valid("json");
        const store = botPool.getBotMemoryStore();
        const memory = await store.saveMemory(botId, body);
        return c.json({ ok: true as const, data: memory }, 201);
      },
    )
    .put(
      "/:botId/memories/:memoryId",
      zValidator(
        "json",
        z.object({
          content: z.string().min(1).optional(),
          category: z.string().nullable().optional(),
          telegramId: z.number().nullable().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const memoryId = Number(c.req.param("memoryId"));
        const body = c.req.valid("json");
        const store = botPool.getBotMemoryStore();
        const updated = await store.updateMemory(botId, memoryId, body);
        if (!updated) return c.json({ ok: false as const, error: "Memory not found" }, 404);
        return c.json({ ok: true as const, data: updated });
      },
    )
    .delete("/:botId/memories/:memoryId", async (c) => {
      const botId = c.req.param("botId");
      const memoryId = Number(c.req.param("memoryId"));
      const store = botPool.getBotMemoryStore();
      const deleted = await store.deleteMemory(botId, memoryId);
      if (!deleted) return c.json({ ok: false as const, error: "Memory not found" }, 404);
      return c.json({ ok: true as const });
    });
}
