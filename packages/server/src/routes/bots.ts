import { randomUUID } from "node:crypto";
import { assemblePromptPreview } from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import { EMBEDDING_DIMENSIONS, bots } from "@cos-tool-bot/database";
import { DEFAULT_CONVERSATION_CONFIG, IMAGE_MAX_SIZE, IMAGE_MIN_SIZE } from "@cos-tool-bot/shared";
import type {
  AiConfigPublic,
  AiConfigStored,
  AiProviderEntry,
  BotPlatform,
  BotWithStatus,
  EmailEventType,
} from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { env } from "../env.js";
import type { BotPool } from "../services/bot-pool.js";
import { LarkBotManager } from "../services/lark-bot-manager.js";
import { mergeWebToolsApiKeys, toWebToolsConfigPublic } from "../services/ai-config-web-tools.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { mapProfileToDto } from "../services/people-profile-store.js";
import { resolvePixaiTaskTimeoutMs } from "../services/generation-recovery.js";
import { decrypt, encrypt, maskToken } from "../utils/crypto.js";
import { createDataFilesLoader } from "../utils/data-files-loader.js";
import { getActiveProvider, migrateAiConfig } from "../utils/ai-config-migrate.js";

const emailForwardFilterSchema = z.object({
  senderPattern: z.string().optional(),
  subjectPattern: z.string().optional(),
});

const emailForwardConfigSchema = z.object({
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapTls: z.boolean().default(true),
  email: z.string().min(1),
  password: z.string().default(""),
  pollIntervalSec: z.number().int().min(10).max(3600).default(60),
  filters: z.array(emailForwardFilterSchema).default([]),
  larkMentionMap: z.record(z.string(), z.string()).optional(),
  disabledEventTypes: z.array(z.string()).optional(),
});

const createBotSchema = z
  .object({
    name: z.string().min(1).max(100),
    platform: z.enum(["telegram", "lark-webhook"]).default("telegram"),
    token: z.string().optional().default(""),
    adminChatIds: z.array(z.number()).default([]),
    isActive: z.boolean().default(true),
    // Lark-specific fields
    webhookUrl: z.string().optional(),
    signSecret: z.string().optional(),
    emailForwardConfig: emailForwardConfigSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.platform === "telegram") return data.token.length > 0;
      if (data.platform === "lark-webhook") return !!data.webhookUrl;
      return true;
    },
    { message: "Telegram requires a token; Lark Webhook requires a webhook URL" },
  )
  .refine(
    (data) => {
      if (data.emailForwardConfig) return data.emailForwardConfig.password.length > 0;
      return true;
    },
    { message: "Email password is required when creating email forward config" },
  );

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  token: z.string().min(1).optional(),
  adminChatIds: z.array(z.number()).optional(),
  isActive: z.boolean().optional(),
  // Lark-specific fields
  webhookUrl: z.string().optional(),
  signSecret: z.string().optional(),
  emailForwardConfig: emailForwardConfigSchema.optional(),
  clearEmailForwardConfig: z.boolean().optional(),
});

function toBotWithStatus(bot: typeof bots.$inferSelect, botPool: BotPool): BotWithStatus {
  const manager = botPool.getManager(bot.id);
  const platform: BotPlatform = bot.platform === "lark-webhook" ? "lark-webhook" : "telegram";
  let tokenMasked: string;
  if (platform === "lark-webhook") {
    tokenMasked = "(Lark Webhook)";
  } else {
    try {
      const token = decrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
      tokenMasked = token === "__IMPORT_PLACEHOLDER__" ? "(未配置)" : maskToken(token);
    } catch {
      tokenMasked = "(密钥不匹配)";
    }
  }
  const larkCfg = bot.larkWebhookConfig;
  const emailCfg = bot.emailForwardConfig;
  return {
    id: bot.id,
    name: bot.name,
    platform,
    tokenMasked,
    adminChatIds: bot.adminChatIds,
    isActive: bot.isActive,
    aiEnabled: bot.aiConfig?.enabled ?? false,
    aiHasApiKey: !!(
      bot.aiConfig && getActiveProvider(migrateAiConfig(bot.aiConfig))?.encryptedApiKey
    ),
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt?.toISOString() ?? null,
    status: manager?.status ?? "stopped",
    uptime: manager?.uptime ?? null,
    larkWebhookConfig: larkCfg
      ? { webhookUrl: larkCfg.webhookUrl, hasSignSecret: !!larkCfg.encryptedSignSecret }
      : undefined,
    emailForwardConfig: emailCfg
      ? {
          imapHost: emailCfg.imapHost,
          imapPort: emailCfg.imapPort,
          email: emailCfg.email,
          pollIntervalSec: emailCfg.pollIntervalSec,
          filters: emailCfg.filters,
          larkMentionMap: emailCfg.larkMentionMap,
          disabledEventTypes: emailCfg.disabledEventTypes,
          hasPassword: !!emailCfg.encryptedPassword,
        }
      : undefined,
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
      providers: [],
    };
  }
  const migrated = migrateAiConfig(config);
  // migrateAiConfig guarantees providers[] non-empty, so active is always set.
  const active = getActiveProvider(migrated)!;
  const providers = migrated.providers!.map((p) => ({
    id: p.id,
    label: p.label,
    hasApiKey: !!p.encryptedApiKey,
    baseURL: p.baseURL,
    providerFormat: p.providerFormat,
    defaultModel: p.defaultModel,
    models: p.models,
  }));
  return {
    enabled: migrated.enabled,
    hasApiKey: !!active.encryptedApiKey,
    baseURL: active.baseURL,
    model: active.defaultModel,
    providerFormat: active.providerFormat,
    providers,
    activeProviderId: migrated.activeProviderId,
    systemPrompt: migrated.systemPrompt,
    behavioralPrompt: migrated.behavioralPrompt,
    groupBehavioralPrompt: migrated.groupBehavioralPrompt,
    triggerConfig: migrated.triggerConfig,
    groupOverrides: migrated.groupOverrides,
    conversationConfig: migrated.conversationConfig,
    memoryConfig: migrated.memoryConfig,
    stickerPacks: migrated.stickerPacks,
    webToolsConfig: toWebToolsConfigPublic(migrated.webToolsConfig),
    agentToolsConfig: migrated.agentToolsConfig,
    artworkToolsConfig: migrated.artworkToolsConfig,
    botMemoryConfig: migrated.botMemoryConfig,
    messageConfig: migrated.messageConfig,
    models: active.models ?? migrated.models,
    modelCommandAccess: migrated.modelCommandAccess,
    embeddingConfig: migrated.embeddingConfig
      ? {
          enabled: migrated.embeddingConfig.enabled,
          hasApiKey: !!migrated.embeddingConfig.encryptedApiKey,
          baseURL: migrated.embeddingConfig.baseURL,
          model: migrated.embeddingConfig.model,
          dimensions: EMBEDDING_DIMENSIONS,
        }
      : undefined,
    dataFilesConfig: migrated.dataFilesConfig,
    privateChatWhitelist: migrated.privateChatWhitelist,
    timeoutConfig:
      migrated.timeoutConfig?.pixaiTaskMs === undefined
        ? migrated.timeoutConfig
        : {
            ...migrated.timeoutConfig,
            pixaiTaskMs: resolvePixaiTaskTimeoutMs(migrated.timeoutConfig.pixaiTaskMs),
          },
    mcpServerIds: migrated.mcpServerIds,
    summaryConfig: migrated.summaryConfig,
    imageOcrConfig: migrated.imageOcrConfig,
  };
}

const aiConfigSchema = z
  .object({
    enabled: z.boolean(),
    apiKey: z.string().optional(),
    baseURL: z.string(),
    model: z.string(),
    providerFormat: z.enum(["openai", "gemini"]).optional(),
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
        imageGenerationEnabled: z.boolean().optional(),
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
        maxRawMessagesPerChat: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .default(DEFAULT_CONVERSATION_CONFIG.maxRawMessagesPerChat),
      })
      .optional(),
    memoryConfig: z
      .object({
        enabled: z.boolean(),
        maxSteps: z.number().min(1),
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
            provider: z.enum(["tavily", "searxng", "brave", "custom"]),
            apiKey: z.string().optional(),
            baseURL: z.string().optional(),
          })
          .optional(),
        imageGeneration: z
          .object({
            provider: z.enum(["openai", "custom", "pixai"]),
            apiKey: z.string().optional(),
            baseURL: z.string().optional(),
            model: z.string().optional(),
            size: z.string().optional(),
            pixaiConfig: z
              .object({
                negativePrompts: z.string().max(4096).optional(),
                samplingSteps: z.number().int().min(8).max(50).optional(),
                cfgScale: z.number().min(1.1).max(15).optional(),
                width: z.number().int().min(IMAGE_MIN_SIZE).max(IMAGE_MAX_SIZE).optional(),
                height: z.number().int().min(IMAGE_MIN_SIZE).max(IMAGE_MAX_SIZE).optional(),
                batchSize: z.number().int().min(1).max(4).optional(),
                promptHelper: z.boolean().optional(),
                systemImagePrompt: z.string().max(4096).optional(),
                apiMode: z.enum(["graphql", "rest"]).optional(),
                priority: z.number().int().min(0).max(10000).optional(),
                seed: z.string().max(100).optional(),
                clipSkip: z.number().int().min(1).max(12).optional(),
                lightning: z.boolean().optional(),
                modelStyle: z
                  .object({ type: z.literal("key"), keyId: z.string().max(100) })
                  .optional(),
                inferenceProfile: z.string().max(100).optional(),
                samplingMethod: z.string().max(100).optional(),
                qualityTag: z
                  .object({
                    prefix: z.string().max(500),
                    suffix: z.string().max(500),
                  })
                  .optional(),
                isPrivate: z.boolean().optional(),
              })
              .optional(),
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
    messageConfig: z
      .object({
        replyMode: z.enum(["stream", "segment"]).optional(),
        richMessageEnabled: z.boolean().optional(),
        autoSplitThreshold: z.number().min(0).max(4096),
        splitDelayMs: z.number().min(0).max(5000),
      })
      .optional(),
    embeddingConfig: z
      .object({
        enabled: z.boolean(),
        apiKey: z.string().optional(),
        baseURL: z.string(),
        model: z.string(),
      })
      .optional(),
    dataFilesConfig: z
      .object({
        injectableFiles: z.array(z.string().min(1).max(255)),
        maxTotalSize: z.number().int().min(0).max(1048576), // max 1MB
      })
      .optional(),
    timeoutConfig: z
      .object({
        aiReplyMs: z.number().int().min(1_000).optional(),
        perStepMs: z.number().int().min(1_000).optional(),
        searchMs: z.number().int().min(1_000).optional(),
        fetchPageMs: z.number().int().min(1_000).optional(),
        imageGenerationMs: z.number().int().min(1_000).optional(),
        researcherAgentMs: z.number().int().min(1_000).optional(),
        defaultAgentMs: z.number().int().min(1_000).optional(),
        imageDownloadMs: z.number().int().min(1_000).optional(),
        pixaiTaskMs: z.number().int().min(1_000).optional(),
      })
      .optional(),
    stickerPacks: z.array(z.string()).optional(),
    models: z
      .array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          capabilities: z
            .array(
              z.enum(["vision", "tool_calling", "web_search", "reasoning", "long_context", "code"]),
            )
            .optional(),
          temperature: z.number().min(0).max(2).optional(),
          maxTokens: z.number().positive().optional(),
          thinking: z.enum(["enabled", "disabled"]).optional(),
          thinkingBudget: z.number().int().optional(),
        }),
      )
      .optional(),
    modelCommandAccess: z.enum(["admin", "all"]).optional(),
    privateChatWhitelist: z.array(z.number().int()).optional(),
    mcpServerIds: z.array(z.number().int()).optional(),
    summaryConfig: z
      .object({
        enabled: z.boolean(),
        defaultWindowHours: z.number().int().min(1).max(72),
        defaultMaxMessages: z.number().int().min(10).max(2000),
        defaultCooldownSeconds: z.number().int().min(0).max(86400),
        globalScheduleHour: z.number().int().min(0).max(23).optional(),
        globalScheduleMinute: z.number().int().min(0).max(59).optional(),
        modelId: z.string().optional(),
        systemPrompt: z.string().optional(),
        roleFilter: z.array(z.enum(["user", "context", "assistant"])).optional(),
        timezone: z.string().optional(),
      })
      .optional(),
    imageOcrConfig: z
      .object({
        enabled: z.boolean(),
        providerId: z.string().optional(),
        modelId: z.string().optional(),
        systemPrompt: z.string().optional(),
        maxImagesPerMessage: z.number().int().min(0).optional(),
        cooldownSeconds: z.number().int().min(0).optional(),
        maxDescriptionLength: z.number().int().min(10).optional(),
        timeoutMs: z.number().int().min(1000).optional(),
      })
      .optional(),
    providers: z
      .array(
        z.object({
          id: z.string().optional(),
          label: z.string().min(1).max(100),
          apiKey: z.string().optional(),
          baseURL: z.string().min(1),
          providerFormat: z.enum(["openai", "gemini"]),
          defaultModel: z.string(),
          models: z
            .array(
              z.object({
                id: z.string(),
                label: z.string().optional(),
                capabilities: z
                  .array(
                    z.enum([
                      "vision",
                      "tool_calling",
                      "web_search",
                      "reasoning",
                      "long_context",
                      "code",
                    ]),
                  )
                  .optional(),
                temperature: z.number().min(0).max(2).optional(),
                maxTokens: z.number().positive().optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    activeProviderId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (!data.enabled) return true;
      if (data.providers && data.providers.length > 0) return true;
      if (data.baseURL.length === 0) return false;
      // model can be empty if models array is non-empty (first model used as default)
      if (data.model.length === 0 && (!data.models || data.models.length === 0)) return false;
      return true;
    },
    {
      message: "providers or baseURL+model must be configured when AI is enabled",
    },
  );

const aiModelsSchema = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export function botsRoutes(
  db: Database,
  botPool: BotPool,
  modelCapabilityService: ModelCapabilityService,
) {
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
      const platform = body.platform ?? "telegram";

      let encryptedToken: string;
      let larkWebhookConfig: { webhookUrl: string; encryptedSignSecret?: string } | undefined;
      let emailForwardConfig:
        | {
            imapHost: string;
            imapPort: number;
            imapTls: boolean;
            email: string;
            encryptedPassword: string;
            pollIntervalSec: number;
            filters: Array<{ senderPattern?: string; subjectPattern?: string }>;
            larkMentionMap?: Record<string, string>;
            disabledEventTypes?: EmailEventType[];
          }
        | undefined;

      if (platform === "lark-webhook") {
        encryptedToken = encrypt("__LARK_WEBHOOK__", env.ENCRYPTION_KEY);
        larkWebhookConfig = {
          webhookUrl: body.webhookUrl!,
          encryptedSignSecret: body.signSecret
            ? encrypt(body.signSecret, env.ENCRYPTION_KEY)
            : undefined,
        };
        if (body.emailForwardConfig) {
          emailForwardConfig = {
            imapHost: body.emailForwardConfig.imapHost,
            imapPort: body.emailForwardConfig.imapPort,
            imapTls: body.emailForwardConfig.imapTls,
            email: body.emailForwardConfig.email,
            encryptedPassword: encrypt(body.emailForwardConfig.password, env.ENCRYPTION_KEY),
            pollIntervalSec: body.emailForwardConfig.pollIntervalSec,
            filters: body.emailForwardConfig.filters,
            larkMentionMap: body.emailForwardConfig.larkMentionMap,
            disabledEventTypes: body.emailForwardConfig.disabledEventTypes as
              | EmailEventType[]
              | undefined,
          };
        }
      } else {
        encryptedToken = encrypt(body.token, env.ENCRYPTION_KEY);
      }

      const rows = await db
        .insert(bots)
        .values({
          name: body.name,
          platform,
          encryptedToken,
          adminChatIds: body.adminChatIds,
          isActive: body.isActive,
          larkWebhookConfig: larkWebhookConfig ?? null,
          emailForwardConfig: emailForwardConfig ?? null,
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

      // Lark-specific updates
      if (body.webhookUrl !== undefined || body.signSecret !== undefined) {
        const encryptedSignSecret = body.signSecret
          ? encrypt(body.signSecret, env.ENCRYPTION_KEY)
          : (existing.larkWebhookConfig?.encryptedSignSecret ?? undefined);
        updates.larkWebhookConfig = {
          webhookUrl: body.webhookUrl ?? existing.larkWebhookConfig?.webhookUrl ?? "",
          encryptedSignSecret,
        };
      }
      if (body.emailForwardConfig) {
        const existingEmail = existing.emailForwardConfig;
        // If password is empty, keep the existing encrypted password
        const encryptedPassword =
          body.emailForwardConfig.password.length > 0
            ? encrypt(body.emailForwardConfig.password, env.ENCRYPTION_KEY)
            : (existingEmail?.encryptedPassword ?? "");
        updates.emailForwardConfig = {
          imapHost: body.emailForwardConfig.imapHost,
          imapPort: body.emailForwardConfig.imapPort,
          imapTls: body.emailForwardConfig.imapTls,
          email: body.emailForwardConfig.email,
          encryptedPassword,
          pollIntervalSec: body.emailForwardConfig.pollIntervalSec,
          filters: body.emailForwardConfig.filters,
          larkMentionMap: body.emailForwardConfig.larkMentionMap,
          disabledEventTypes: body.emailForwardConfig.disabledEventTypes as
            | EmailEventType[]
            | undefined,
        };
      } else if (body.clearEmailForwardConfig) {
        updates.emailForwardConfig = null;
      }

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
        // Restart running bot if config changed
        const needsRestart =
          body.token !== undefined ||
          body.adminChatIds !== undefined ||
          body.webhookUrl !== undefined ||
          body.signSecret !== undefined ||
          body.emailForwardConfig !== undefined ||
          body.clearEmailForwardConfig;
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
      botPool.clearDeletedBotGenerationState(botId);
      return c.json({ ok: true as const });
    })
    .post("/:botId/start", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      try {
        await botPool.startBot(botId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 500);
      }
      return c.json({ ok: true as const });
    })
    .post("/:botId/stop", async (c) => {
      const botId = c.req.param("botId");
      try {
        await botPool.stopBot(botId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 500);
      }
      return c.json({ ok: true as const });
    })
    .post("/:botId/restart", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      try {
        await botPool.restartBot(botId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false as const, error: msg }, 500);
      }
      return c.json({ ok: true as const });
    })
    .post(
      "/:botId/ai-config/prompt-preview",
      zValidator(
        "json",
        z.object({
          isPrivate: z.boolean().default(true),
          systemPrompt: z.string(),
          behavioralPrompt: z.string().optional(),
          groupBehavioralPrompt: z.string().optional(),
          memoryEnabled: z.boolean().default(false),
          botMemoryEnabled: z.boolean().default(false),
          stickerPacks: z.array(z.string()).optional(),
          webToolsConfig: z.any().optional(),
          agentToolsConfig: z.any().optional(),
          artworkToolsEnabled: z.boolean().optional(),
          messageConfig: z.any().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const body = c.req.valid("json");

        // Data files are loaded from disk (not part of form state)
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        const dataFilesConfig = bot?.aiConfig?.dataFilesConfig;
        const dataFiles = await createDataFilesLoader(botId, {
          injectableFiles: dataFilesConfig?.injectableFiles,
          maxTotalSize: dataFilesConfig?.maxTotalSize,
          cacheTtlMs: 0, // no cache for preview
        });

        const result = await assemblePromptPreview({
          systemPrompt: body.systemPrompt,
          behavioralPrompt: body.behavioralPrompt,
          groupBehavioralPrompt: body.groupBehavioralPrompt,
          isPrivate: body.isPrivate,
          memoryEnabled: body.memoryEnabled,
          botMemoryEnabled: body.botMemoryEnabled,
          stickerPacks: body.stickerPacks,
          webToolsConfig: body.webToolsConfig,
          agentToolsConfig: body.agentToolsConfig,
          artworkToolsEnabled: body.artworkToolsEnabled,
          hasFileTools: !!dataFiles,
          dataFiles,
          messageConfig: body.messageConfig,
        });

        // Keep the public RPC response structurally named inside the server package. Returning
        // the imported result object directly makes declaration emit reference bot internals.
        return c.json({
          ok: true as const,
          data: {
            fullPrompt: result.fullPrompt,
            estimatedTokens: result.estimatedTokens,
            trace: {
              totalEstimatedTokens: result.trace.totalEstimatedTokens,
              staticPrefixHash: result.trace.staticPrefixHash,
              sections: result.trace.sections.map((section) => ({
                id: section.id,
                source: section.source,
                stability: String(section.stability),
                trust: String(section.trust),
                role: String(section.role),
                messageIndex: section.messageIndex,
                status: String(section.status),
                chars: section.chars,
                estimatedTokens: section.estimatedTokens,
                refs: section.refs,
                unestimatedParts: section.unestimatedParts,
              })),
            },
          },
        });
      },
    )
    .get("/:botId/ai-config", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({ ok: true as const, data: toAiConfigPublic(bot.aiConfig) });
    })
    .put("/:botId/ai-config", zValidator("json", aiConfigSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");

      const aiConfig = await botPool.withAiConfigLock(botId, async () => {
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return null;

        // Migrate existing stored config first so we can reliably look up per-provider
        // encrypted keys by id when the client sends back the same provider without a new apiKey.
        const existingMigrated = bot.aiConfig ? migrateAiConfig(bot.aiConfig) : null;
        const existingProvidersById = new Map<string, AiProviderEntry>();
        for (const p of existingMigrated?.providers ?? []) {
          existingProvidersById.set(p.id, p);
        }

        // Build new providers list with preserve-when-empty apiKey per entry.
        // Client sends temp ids like "__new_xxx" for unsaved providers; map them to real
        // UUIDs here and remap activeProviderId through the same mapping so the client's
        // selection survives the id rewrite.
        let providers: AiProviderEntry[] | undefined;
        let activeProviderId: string | undefined = body.activeProviderId;
        if (body.providers !== undefined) {
          const idMap = new Map<string, string>();
          providers = body.providers.map((p) => {
            const isTemp = !p.id || p.id.startsWith("__new_");
            const finalId = isTemp ? randomUUID() : p.id!;
            if (p.id) idMap.set(p.id, finalId);
            const existing = isTemp ? undefined : existingProvidersById.get(finalId);
            const encryptedApiKey =
              p.apiKey !== undefined && p.apiKey !== ""
                ? encrypt(p.apiKey, env.ENCRYPTION_KEY)
                : (existing?.encryptedApiKey ?? null);
            return {
              id: finalId,
              label: p.label,
              encryptedApiKey,
              baseURL: p.baseURL,
              providerFormat: p.providerFormat,
              defaultModel: p.defaultModel,
              models: p.models,
            };
          });
          if (activeProviderId && idMap.has(activeProviderId)) {
            activeProviderId = idMap.get(activeProviderId);
          }
          if (!activeProviderId || !providers.some((p) => p.id === activeProviderId)) {
            activeProviderId = providers[0]?.id;
          }
        }

        // Legacy top-level apiKey handling (kept for backward-compat clients that don't yet
        // send providers[]). Preserve-when-empty.
        let encryptedApiKey = bot.aiConfig?.encryptedApiKey ?? null;
        if (body.apiKey !== undefined && body.apiKey !== "") {
          encryptedApiKey = encrypt(body.apiKey, env.ENCRYPTION_KEY);
        }

        // If model is empty but models array has entries, use first model as default
        const effectiveModel =
          body.model || (body.models?.length ? body.models[0]!.id : (bot.aiConfig?.model ?? ""));

        // Handle embedding config encryption
        let embeddingConfig = bot.aiConfig?.embeddingConfig;
        if (body.embeddingConfig) {
          let embEncryptedApiKey = embeddingConfig?.encryptedApiKey ?? "";
          if (body.embeddingConfig.apiKey) {
            embEncryptedApiKey = encrypt(body.embeddingConfig.apiKey, env.ENCRYPTION_KEY);
          }
          embeddingConfig = {
            enabled: body.embeddingConfig.enabled,
            encryptedApiKey: embEncryptedApiKey,
            baseURL: body.embeddingConfig.baseURL,
            model: body.embeddingConfig.model,
            dimensions: EMBEDDING_DIMENSIONS,
          };
        }

        const updatedAiConfig: AiConfigStored = {
          enabled: body.enabled,
          encryptedApiKey,
          baseURL: body.baseURL,
          model: effectiveModel,
          providerFormat: body.providerFormat,
          providers: providers ?? existingMigrated?.providers,
          activeProviderId: activeProviderId ?? existingMigrated?.activeProviderId,
          systemPrompt: body.systemPrompt,
          behavioralPrompt: body.behavioralPrompt,
          groupBehavioralPrompt: body.groupBehavioralPrompt,
          triggerConfig: body.triggerConfig,
          groupOverrides: body.groupOverrides,
          conversationConfig: body.conversationConfig,
          memoryConfig: body.memoryConfig,
          stickerPacks: body.stickerPacks ?? bot.aiConfig?.stickerPacks,
          webToolsConfig: mergeWebToolsApiKeys(
            existingMigrated?.webToolsConfig,
            body.webToolsConfig,
          ),
          agentToolsConfig: body.agentToolsConfig,
          artworkToolsConfig: body.artworkToolsConfig,
          botMemoryConfig: body.botMemoryConfig,
          messageConfig: body.messageConfig,
          timeoutConfig:
            body.timeoutConfig?.pixaiTaskMs === undefined
              ? body.timeoutConfig
              : {
                  ...body.timeoutConfig,
                  pixaiTaskMs: resolvePixaiTaskTimeoutMs(body.timeoutConfig.pixaiTaskMs),
                },
          models: body.models,
          modelCommandAccess: body.modelCommandAccess,
          embeddingConfig,
          dataFilesConfig: body.dataFilesConfig ?? bot.aiConfig?.dataFilesConfig,
          privateChatWhitelist: body.privateChatWhitelist,
          mcpServerIds: body.mcpServerIds,
          summaryConfig: body.summaryConfig ?? bot.aiConfig?.summaryConfig,
          imageOcrConfig: body.imageOcrConfig ?? bot.aiConfig?.imageOcrConfig,
        };

        await db.update(bots).set({ aiConfig: updatedAiConfig }).where(eq(bots.id, botId));
        return updatedAiConfig;
      });

      if (!aiConfig) return c.json({ ok: false as const, error: "Bot not found" }, 404);

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
    .get(
      "/:botId/conversations/:chatId/summaries",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(20),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const chatId = Number(c.req.param("chatId"));
        if (Number.isNaN(chatId))
          return c.json({ ok: false as const, error: "Invalid chatId" }, 400);
        const { page, limit } = c.req.valid("query");
        const store = botPool.getConversationStore();
        const result = await store.getConversationSummaries(botId, chatId, page, limit);
        return c.json({ ok: true as const, ...result });
      },
    )
    .delete("/:botId/conversations/:chatId/summaries/:id", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      const id = Number(c.req.param("id"));
      if (Number.isNaN(chatId) || Number.isNaN(id))
        return c.json({ ok: false as const, error: "Invalid chatId or id" }, 400);
      const store = botPool.getConversationStore();
      const result = await store.deleteConversationSummary(botId, chatId, id);
      if (result === "active") {
        return c.json({ ok: false as const, error: "Active summary cannot be deleted" }, 409);
      }
      if (result === "not_found") {
        return c.json({ ok: false as const, error: "Summary not found" }, 404);
      }
      return c.json({ ok: true as const });
    })
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
    .delete("/:botId/conversations/:chatId/messages/:messageId", async (c) => {
      const botId = c.req.param("botId");
      const chatId = Number(c.req.param("chatId"));
      const messageId = Number(c.req.param("messageId"));
      if (Number.isNaN(chatId) || Number.isNaN(messageId))
        return c.json({ ok: false as const, error: "Invalid chatId or messageId" }, 400);
      const store = botPool.getConversationStore();
      const deleted = await store.deleteMessage(botId, chatId, messageId);
      if (!deleted) return c.json({ ok: false as const, error: "Message not found" }, 404);
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
            data: profiles.map((p) => ({ id: p.id, ...mapProfileToDto(p) })),
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

      // Fall back to stored values (active provider first, then legacy top-level)
      if (!apiKey || !baseURL) {
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

        const migrated = bot.aiConfig ? migrateAiConfig(bot.aiConfig) : null;
        const active = migrated ? getActiveProvider(migrated) : null;
        if (!baseURL) baseURL = active?.baseURL ?? migrated?.baseURL;
        const encryptedKey = active?.encryptedApiKey ?? migrated?.encryptedApiKey ?? null;
        if (!apiKey && encryptedKey) {
          try {
            apiKey = decrypt(encryptedKey, env.ENCRYPTION_KEY);
          } catch {
            return c.json(
              {
                ok: false as const,
                error: "密钥不匹配，无法解密 API Key，请重新输入 API Key",
              },
              400,
            );
          }
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
          data: models.map((m) => ({
            id: m.id,
            owned_by: m.owned_by,
            capabilities: modelCapabilityService.inferCapabilities(m.id),
          })),
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
    })
    .post(
      "/:botId/lark/test",
      zValidator(
        "json",
        z.object({
          message: z.string().min(1).max(500).default("Test message from cos-tool-bot panel"),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const { message } = c.req.valid("json");
        const manager = botPool.getManager(botId);
        if (!manager || !(manager instanceof LarkBotManager)) {
          return c.json(
            { ok: false as const, error: "Bot is not a running Lark webhook bot" },
            400,
          );
        }
        if (manager.status !== "running") {
          return c.json({ ok: false as const, error: "Bot is not running" }, 400);
        }
        const result = await manager.getLarkClient().sendText(message);
        if (!result.ok) {
          return c.json({ ok: false as const, error: result.error ?? "Failed to send" }, 502);
        }
        return c.json({ ok: true as const });
      },
    );
}
