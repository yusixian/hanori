import { randomUUID } from "node:crypto";
import {
  assemblePromptPreview,
  cleanupBotAvatarFiles,
  cleanupProfileAvatarFiles,
  isBuiltInSkillId,
  listBotSkills,
  resolveBotSkills,
} from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import { EMBEDDING_DIMENSIONS, bots } from "@cos-tool-bot/database";
import {
  DEFAULT_AI_EXECUTION_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  IMAGE_MAX_SIZE,
  IMAGE_MIN_SIZE,
} from "@cos-tool-bot/shared";
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
import { Hono, type Context } from "hono";
import * as fs from "node:fs/promises";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { env } from "../env.js";
import { ownerOrAdmin, type AuthVariables } from "../middleware/better-auth.js";
import type { BotPool } from "../services/bot-pool.js";
import { BotLifecycleError, type BotLifecycleService } from "../services/bot-lifecycle-service.js";
import {
  ChatAiSelectionError,
  type ChatAiSelectionService,
} from "../services/chat-ai-selection-service.js";
import { LarkBotManager } from "../services/lark-bot-manager.js";
import { mergeWebToolsApiKeys, toWebToolsConfigPublic } from "../services/ai-config-web-tools.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { mapProfileToDto } from "../services/people-profile-store.js";
import { resolvePixaiTaskTimeoutMs } from "../services/generation-recovery.js";
import {
  assertGitHubCodingModelSelection,
  assertGitHubCredentialUpdateAllowed,
} from "../services/github-credential-policy.js";
import { decrypt, encrypt, maskToken } from "../utils/crypto.js";
import { createDataFilesLoader } from "../utils/data-files-loader.js";
import {
  DEFAULT_MODEL_DISCOVERY_PATH,
  getActiveProvider,
  migrateAiConfig,
  normalizeAiProvider,
} from "../utils/ai-config-migrate.js";
import { getDataDir, resolveAndValidate } from "../utils/file-validation.js";

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
    miniAppEnabled: z.boolean().default(false),
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
  )
  .refine((data) => data.platform === "telegram" || !data.miniAppEnabled, {
    message: "Telegram Mini App is only available for Telegram bots",
    path: ["miniAppEnabled"],
  });

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  token: z.string().min(1).optional(),
  adminChatIds: z.array(z.number()).optional(),
  isActive: z.boolean().optional(),
  miniAppEnabled: z.boolean().optional(),
  // Lark-specific fields
  webhookUrl: z.string().optional(),
  signSecret: z.string().optional(),
  emailForwardConfig: emailForwardConfigSchema.optional(),
  clearEmailForwardConfig: z.boolean().optional(),
});

const globalAiSelectionSchema = z
  .object({
    expectedRevision: z.string().min(1).max(2_000),
    providerId: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(200).nullable(),
    displayDefault: z.enum(["show", "hide"]),
  })
  .strict();

const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Skill name must use lowercase letters, numbers, and hyphens");
const skillResourceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      !name.startsWith("/") &&
      !name.includes("\\") &&
      !name.split("/").some((part) => part === ".." || part === ""),
    "Resource names must be safe relative paths",
  );
const customSkillSchema = z
  .object({
    id: z.string().uuid(),
    name: skillNameSchema,
    displayName: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1_000),
    instructions: z.string().trim().min(1).max(100_000),
    resources: z.record(skillResourceNameSchema, z.string().max(100_000)),
    enabled: z.boolean(),
  })
  .strict();
const skillConfigSchema = z
  .object({
    revision: z.string().min(1).max(100),
    enabledBuiltInIds: z.array(z.string().trim().min(1).max(100)).max(50),
    customSkills: z.array(customSkillSchema).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const builtInIds = new Set<string>();
    for (const [index, id] of value.enabledBuiltInIds.entries()) {
      if (!isBuiltInSkillId(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Unknown built-in Skill",
          path: ["enabledBuiltInIds", index],
        });
      }
      if (builtInIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate built-in Skill",
          path: ["enabledBuiltInIds", index],
        });
      }
      builtInIds.add(id);
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    let totalChars = 0;
    for (const [index, skill] of value.customSkills.entries()) {
      if (ids.has(skill.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate custom Skill id",
          path: ["customSkills", index, "id"],
        });
      }
      if (names.has(skill.name) || isBuiltInSkillId(skill.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Skill names must be unique and cannot shadow a built-in Skill",
          path: ["customSkills", index, "name"],
        });
      }
      ids.add(skill.id);
      names.add(skill.name);
      totalChars += skill.instructions.length;
      totalChars += Object.values(skill.resources).reduce(
        (sum, content) => sum + content.length,
        0,
      );
    }
    if (totalChars > 500_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Custom Skill content exceeds the 500,000 character limit",
        path: ["customSkills"],
      });
    }
  });

function canManageAiSelection(role: string): boolean {
  return ownerOrAdmin.has(role);
}

function aiSelectionErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof ChatAiSelectionError)) {
    console.error("AI selection request failed", { error });
    return c.json({ ok: false as const, error: "AI selection request failed" }, 500);
  }
  const status =
    error.code === "not_found"
      ? 404
      : error.code === "stale_revision"
        ? 409
        : error.code === "invalid_actor"
          ? 400
          : 422;
  return c.json({ ok: false as const, code: error.code, error: error.message }, status);
}

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
    miniAppEnabled: bot.miniAppEnabled,
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
      executionConfig: DEFAULT_AI_EXECUTION_CONFIG,
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
    modelDiscoveryPath: p.modelDiscoveryPath,
    providerFormat: p.providerFormat,
    defaultModel: p.defaultModel,
    models: p.models,
  }));
  return {
    enabled: migrated.enabled,
    hasApiKey: !!active.encryptedApiKey,
    baseURL: active.baseURL,
    model: migrated.activeModelId ?? active.defaultModel,
    providerFormat: active.providerFormat,
    providers,
    activeProviderId: migrated.activeProviderId,
    activeModelId: migrated.activeModelId,
    aiSelectionDisplayDefault: migrated.aiSelectionDisplayDefault,
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
    githubToolsConfig: migrated.githubToolsConfig
      ? {
          enabled: migrated.githubToolsConfig.enabled,
          publicReadEnabled: migrated.githubToolsConfig.publicReadEnabled,
          codingAgentEnabled: migrated.githubToolsConfig.codingAgentEnabled ?? false,
          codingProviderId: migrated.githubToolsConfig.codingProviderId,
          codingModelId: migrated.githubToolsConfig.codingModelId,
          hasToken: !!migrated.githubToolsConfig.encryptedToken,
          login:
            migrated.githubToolsConfig.githubAppInstallation?.accountLogin ??
            migrated.githubToolsConfig.login,
          authorName: migrated.githubToolsConfig.authorName,
          authorEmail: migrated.githubToolsConfig.authorEmail,
          repositories: migrated.githubToolsConfig.repositories,
        }
      : undefined,
    artworkToolsConfig: migrated.artworkToolsConfig,
    botMemoryConfig: migrated.botMemoryConfig,
    messageConfig: migrated.messageConfig,
    executionConfig: migrated.executionConfig ?? DEFAULT_AI_EXECUTION_CONFIG,
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

function aiConfigRevision(updatedAt: Date | null | undefined): string {
  return updatedAt?.toISOString() ?? "0";
}

const modelDiscoveryPathSchema = z
  .string()
  .trim()
  .refine((path) => path === "" || isValidModelDiscoveryPath(path), {
    message: "Model discovery path must be empty or begin with a single slash",
  });

const aiExecutionConfigSchema = z
  .object({
    maxConcurrentReplies: z.number().int().min(1).max(32),
    queueNotice: z.object({
      enabled: z.boolean(),
      text: z.string().trim().max(200),
    }),
  })
  .superRefine((config, context) => {
    if (config.queueNotice.enabled && config.queueNotice.text.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Queue notice text is required when the notice is enabled",
        path: ["queueNotice", "text"],
      });
    }
  });

const aiConfigSchema = z
  .object({
    revision: z.string().min(1).max(100),
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
        groupHistoryMaxTokens: z.number().int().min(2_000).max(64_000).optional(),
        imageGenerationEnabled: z.boolean().optional(),
      }),
    ),
    conversationConfig: z
      .object({
        enabled: z.boolean(),
        maxContextMessages: z.number().min(1).max(100),
        groupHistoryMaxTokens: z
          .number()
          .int()
          .min(2_000)
          .max(64_000)
          .default(DEFAULT_CONVERSATION_CONFIG.groupHistoryMaxTokens),
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
    githubToolsConfig: z
      .object({
        enabled: z.boolean(),
        publicReadEnabled: z.boolean(),
        codingAgentEnabled: z.boolean().default(false),
        codingProviderId: z.string().trim().min(1).max(100).optional(),
        codingModelId: z.string().trim().min(1).max(200).optional(),
        token: z.string().max(512).optional(),
        login: z.string().trim().max(100).optional(),
        authorName: z.string().trim().min(1).max(100),
        authorEmail: z.string().trim().email().max(254),
        repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(100),
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
    executionConfig: aiExecutionConfigSchema.optional(),
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
          modelDiscoveryPath: modelDiscoveryPathSchema.optional(),
          providerFormat: z.enum(["openai", "gemini"]),
          defaultModel: z.string().trim(),
          models: z
            .array(
              z.object({
                id: z.string().trim().min(1),
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
                thinking: z.enum(["enabled", "disabled"]).optional(),
                thinkingBudget: z.number().int().optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    activeProviderId: z.string().optional(),
    activeModelId: z.string().trim().min(1).optional(),
    aiSelectionDisplayDefault: z.enum(["show", "hide"]).optional(),
  })
  .refine(
    (data) => {
      const providerIds = (data.providers ?? [])
        .map((provider) => provider.id)
        .filter((id): id is string => id !== undefined);
      return new Set(providerIds).size === providerIds.length;
    },
    {
      message: "Provider IDs must be unique",
      path: ["providers"],
    },
  )
  .refine(
    (data) => {
      if (!data.enabled) return true;
      if (data.providers && data.providers.length > 0) {
        return data.providers.every(
          (provider) =>
            provider.defaultModel.trim().length > 0 ||
            provider.models?.some((model) => model.id.trim().length > 0),
        );
      }
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
  providerId: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  modelDiscoveryPath: modelDiscoveryPathSchema.optional(),
});

const aiModelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        owned_by: z.string().optional(),
      }),
    )
    .max(5_000),
});

const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_ERROR_LENGTH = 500;
const MAX_UPSTREAM_ERROR_BYTES = 16 * 1024;
const MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

function normalizeBaseURLForComparison(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isValidModelDiscoveryPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !containsControlCharacter(path)
  );
}

function resolveModelDiscoveryURL(baseURL: string, path: string): string | null {
  if (!isValidModelDiscoveryPath(path)) return null;

  try {
    const normalizedBaseURL = normalizeBaseURLForComparison(baseURL);
    const parsedBaseURL = new URL(normalizedBaseURL);
    if (parsedBaseURL.protocol !== "http:" && parsedBaseURL.protocol !== "https:") return null;
    const resolved = new URL(`${normalizedBaseURL}${path}`);
    return resolved.origin === parsedBaseURL.origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeDiscoveryError(detail: string, apiKey: string): string {
  const redacted = detail.replaceAll(apiKey, "[REDACTED]").replace(/\s+/g, " ").trim();
  if (!redacted) return "";
  return redacted.length > MAX_UPSTREAM_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_UPSTREAM_ERROR_LENGTH)}…`
    : redacted;
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Upstream response exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Upstream response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function readSafeUpstreamError(response: Response, apiKey: string): Promise<string> {
  try {
    return sanitizeDiscoveryError(
      await readResponseTextLimited(response, MAX_UPSTREAM_ERROR_BYTES),
      apiKey,
    );
  } catch (error) {
    return error instanceof Error ? error.message : "Unable to read upstream error response";
  }
}

export function botsRoutes(
  db: Database,
  botPool: BotPool,
  modelCapabilityService: ModelCapabilityService,
  botLifecycleService?: BotLifecycleService,
  chatAiSelectionService?: ChatAiSelectionService,
) {
  return new Hono<{ Variables: AuthVariables }>()
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
      if (!ownerOrAdmin.has(c.get("authMember").role)) {
        return c.json({ ok: false as const, error: "当前角色没有权限创建 Bot" }, 403);
      }
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
          miniAppEnabled: body.miniAppEnabled,
          larkWebhookConfig: larkWebhookConfig ?? null,
          emailForwardConfig: emailForwardConfig ?? null,
        })
        .returning();
      const created = rows[0]!;
      if (body.isActive) {
        if (botLifecycleService) {
          await botLifecycleService.enable({
            botId: created.id,
            actor: { kind: "better_auth_user", id: c.get("authUser").id },
          });
        } else {
          try {
            await botPool.startBot(created.id);
          } catch {
            // Test-only fallback for route units that do not install lifecycle services.
          }
        }
      }
      return c.json({ ok: true as const, data: toBotWithStatus(created, botPool) }, 201);
    })
    .put("/:botId", zValidator("json", updateBotSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");
      const [existing] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!existing) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const normalizedAdminIds = (ids: readonly number[]) =>
        [...new Set(ids)].sort((a, b) => a - b);
      const adminIdsChanged =
        body.adminChatIds !== undefined &&
        JSON.stringify(normalizedAdminIds(body.adminChatIds)) !==
          JSON.stringify(normalizedAdminIds(existing.adminChatIds));
      const protectedSettingChanged =
        body.token !== undefined ||
        adminIdsChanged ||
        (body.isActive !== undefined && body.isActive !== existing.isActive) ||
        (body.miniAppEnabled !== undefined && body.miniAppEnabled !== existing.miniAppEnabled);
      if (protectedSettingChanged && !ownerOrAdmin.has(c.get("authMember").role)) {
        return c.json(
          { ok: false as const, error: "当前角色没有权限管理 Bot 身份或生命周期" },
          403,
        );
      }
      if (body.miniAppEnabled && existing.platform !== "telegram") {
        return c.json(
          { ok: false as const, error: "Telegram Mini App is only available for Telegram bots" },
          400,
        );
      }

      const updates: Partial<typeof bots.$inferInsert> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.token !== undefined)
        updates.encryptedToken = encrypt(body.token, env.ENCRYPTION_KEY);
      if (body.adminChatIds !== undefined) updates.adminChatIds = body.adminChatIds;
      if (body.miniAppEnabled !== undefined) updates.miniAppEnabled = body.miniAppEnabled;

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
      let updated = rows[0]!;

      const manager = botPool.getManager(botId);

      // Handle isActive lifecycle changes
      if (body.isActive !== undefined && body.isActive !== existing.isActive) {
        if (botLifecycleService) {
          const input = {
            botId,
            actor: { kind: "better_auth_user" as const, id: c.get("authUser").id },
          };
          const lifecycle = body.isActive
            ? await botLifecycleService.enable(input)
            : await botLifecycleService.disable(input);
          updated = { ...updated, isActive: lifecycle.desiredActive };
        } else {
          try {
            if (!body.isActive && manager) {
              await botPool.stopBot(botId);
            } else if (body.isActive && !manager) {
              await botPool.startBot(botId);
            }
          } catch {
            // Test-only fallback for route units that do not install lifecycle services.
          }
        }
      } else {
        // Restart running bot if config changed
        const miniAppFlagChanged =
          body.miniAppEnabled !== undefined && body.miniAppEnabled !== existing.miniAppEnabled;
        let miniAppRestartHandled = false;
        if (miniAppFlagChanged && updated.isActive) {
          miniAppRestartHandled = true;
          try {
            if (botLifecycleService) {
              const lifecycle = await botLifecycleService.restart({
                botId,
                actor: { kind: "better_auth_user", id: c.get("authUser").id },
              });
              if (!lifecycle.applied) throw new Error(lifecycle.errorCode ?? "restart_failed");
            } else if (manager) {
              await botPool.restartBot(botId);
            } else {
              await botPool.startBot(botId);
            }
          } catch (error) {
            console.error("Bot restart after Mini App flag update failed", { botId, error });
            throw new HTTPException(503, {
              message: "Mini App 设置已保存，但 Bot 重启失败。请检查 HTTPS 配置和服务端日志后重试",
            });
          }
        }
        const needsRestart =
          body.token !== undefined ||
          body.adminChatIds !== undefined ||
          body.webhookUrl !== undefined ||
          body.signSecret !== undefined ||
          body.miniAppEnabled !== undefined ||
          body.emailForwardConfig !== undefined ||
          body.clearEmailForwardConfig;
        if (manager && needsRestart && !miniAppRestartHandled) {
          try {
            await botPool.restartBot(botId);
          } catch {
            // Preserve the existing best-effort behavior for non-lifecycle settings.
          }
        }
      }

      return c.json({ ok: true as const, data: toBotWithStatus(updated, botPool) });
    })
    .delete("/:botId", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      const dataDir = getDataDir(botId);
      if (!bot) {
        await cleanupBotAvatarFiles(dataDir);
        return c.json({ ok: false as const, error: "Bot not found" }, 404);
      }
      await botPool.stopBot(botId);
      await cleanupBotAvatarFiles(dataDir);
      await db.delete(bots).where(eq(bots.id, botId));
      botPool.clearDeletedBotGenerationState(botId);
      await cleanupBotAvatarFiles(dataDir);
      return c.json({ ok: true as const });
    })
    .post("/:botId/start", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      try {
        const data = botLifecycleService
          ? await botLifecycleService.enable({
              botId,
              actor: { kind: "better_auth_user", id: c.get("authUser").id },
            })
          : await botPool.startBot(botId);
        return c.json({ ok: true as const, ...(data ? { data } : {}) });
      } catch (err) {
        const msg = err instanceof BotLifecycleError ? err.message : "Bot could not be enabled";
        return c.json({ ok: false as const, error: msg }, 500);
      }
    })
    .post("/:botId/stop", async (c) => {
      const botId = c.req.param("botId");
      try {
        const data = botLifecycleService
          ? await botLifecycleService.disable({
              botId,
              actor: { kind: "better_auth_user", id: c.get("authUser").id },
            })
          : await botPool.stopBot(botId);
        return c.json({ ok: true as const, ...(data ? { data } : {}) });
      } catch (err) {
        const msg = err instanceof BotLifecycleError ? err.message : "Bot could not be disabled";
        return c.json({ ok: false as const, error: msg }, 500);
      }
    })
    .post("/:botId/restart", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      try {
        const data = botLifecycleService
          ? await botLifecycleService.restart({
              botId,
              actor: { kind: "better_auth_user", id: c.get("authUser").id },
            })
          : await botPool.restartBot(botId);
        return c.json({ ok: true as const, ...(data ? { data } : {}) });
      } catch (err) {
        const msg = err instanceof BotLifecycleError ? err.message : "Bot could not be restarted";
        return c.json({ ok: false as const, error: msg }, 500);
      }
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
          hasImageGeneration: true,
          skills: resolveBotSkills(bot?.aiConfig?.skillConfig),
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
    .get("/:botId/ai-selection", async (c) => {
      if (!chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection service is unavailable" }, 503);
      }
      try {
        return c.json({
          ok: true as const,
          data: await chatAiSelectionService.readGlobal(c.req.param("botId")),
          canManage: canManageAiSelection(c.get("authMember").role),
        });
      } catch (error) {
        return aiSelectionErrorResponse(c, error);
      }
    })
    .patch("/:botId/ai-selection", zValidator("json", globalAiSelectionSchema), async (c) => {
      if (!canManageAiSelection(c.get("authMember").role)) {
        return c.json({ ok: false as const, error: "当前角色没有权限执行该操作" }, 403);
      }
      if (!chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection service is unavailable" }, 503);
      }
      const botId = c.req.param("botId");
      const body = c.req.valid("json");
      try {
        const data = await chatAiSelectionService.setGlobal({
          botId,
          expectedRevision: body.expectedRevision,
          pair: { providerId: body.providerId, modelId: body.modelId },
          displayDefault: body.displayDefault,
          actor: { kind: "better_auth_user", id: c.get("authUser").id },
        });
        return c.json({ ok: true as const, data });
      } catch (error) {
        if (error instanceof ChatAiSelectionError && error.code === "stale_revision") {
          try {
            return c.json(
              {
                ok: false as const,
                code: error.code,
                error: error.message,
                latest: await chatAiSelectionService.readGlobal(botId),
              },
              409,
            );
          } catch {
            // Fall through to the safe mapped error when the latest state cannot be read.
          }
        }
        return aiSelectionErrorResponse(c, error);
      }
    })
    .post("/:botId/ai-selection/retry", async (c) => {
      if (!canManageAiSelection(c.get("authMember").role)) {
        return c.json({ ok: false as const, error: "当前角色没有权限执行该操作" }, 403);
      }
      if (!chatAiSelectionService) {
        return c.json({ ok: false as const, error: "AI selection service is unavailable" }, 503);
      }
      const botId = c.req.param("botId");
      try {
        const publish = await chatAiSelectionService.retryPublish(botId);
        return c.json({
          ok: true as const,
          data: { ...publish, global: await chatAiSelectionService.readGlobal(botId) },
        });
      } catch (error) {
        return aiSelectionErrorResponse(c, error);
      }
    })
    .get("/:botId/ai-config", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({
        ok: true as const,
        data: toAiConfigPublic(bot.aiConfig),
        revision: aiConfigRevision(bot.updatedAt),
      });
    })
    .get("/:botId/skills", async (c) => {
      if (!ownerOrAdmin.has(c.get("authMember").role)) {
        return c.json({ ok: false as const, error: "当前角色没有权限管理 Skill" }, 403);
      }
      const botId = c.req.param("botId");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({
        ok: true as const,
        data: listBotSkills(bot.aiConfig?.skillConfig),
        revision: aiConfigRevision(bot.updatedAt),
      });
    })
    .put("/:botId/skills", zValidator("json", skillConfigSchema), async (c) => {
      if (!ownerOrAdmin.has(c.get("authMember").role)) {
        return c.json({ ok: false as const, error: "当前角色没有权限管理 Skill" }, 403);
      }
      const botId = c.req.param("botId");
      const body = c.req.valid("json");
      const saveResult = await botPool.withAiConfigLock(botId, async () => {
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return { kind: "not_found" as const };
        if (!bot.aiConfig) return { kind: "ai_not_configured" as const };
        const currentRevision = aiConfigRevision(bot.updatedAt);
        if (body.revision !== currentRevision) {
          return {
            kind: "conflict" as const,
            data: listBotSkills(bot.aiConfig.skillConfig),
            revision: currentRevision,
          };
        }
        const skillConfig = {
          enabledBuiltInIds: body.enabledBuiltInIds,
          customSkills: body.customSkills.map((skill) => ({
            ...skill,
            resources: { ...skill.resources },
          })),
        };
        const changedAt = new Date(Math.max(Date.now(), (bot.updatedAt?.getTime() ?? 0) + 1));
        await db
          .update(bots)
          .set({ aiConfig: { ...bot.aiConfig, skillConfig }, updatedAt: changedAt })
          .where(eq(bots.id, botId));
        return { kind: "saved" as const, skillConfig, revision: aiConfigRevision(changedAt) };
      });

      if (saveResult.kind === "not_found") {
        return c.json({ ok: false as const, error: "Bot not found" }, 404);
      }
      if (saveResult.kind === "ai_not_configured") {
        return c.json({ ok: false as const, error: "请先完成 AI 配置" }, 409);
      }
      if (saveResult.kind === "conflict") {
        return c.json(
          {
            ok: false as const,
            code: "stale_revision" as const,
            error: "Skill configuration changed since it was loaded",
            latest: { data: saveResult.data, revision: saveResult.revision },
          },
          409,
        );
      }

      if (botPool.getManager(botId)) {
        try {
          await botPool.restartBot(botId);
        } catch (error) {
          console.error("Bot restart after Skill config save failed", { botId, error });
          return c.json(
            {
              ok: false as const,
              code: "saved_apply_failed" as const,
              error: "Skill 已保存，但 Bot 重启失败。请检查服务端日志并手动重启 Bot",
              revision: saveResult.revision,
            },
            503,
          );
        }
      }

      return c.json({
        ok: true as const,
        data: listBotSkills(saveResult.skillConfig),
        revision: saveResult.revision,
      });
    })
    .put("/:botId/ai-config", zValidator("json", aiConfigSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");

      const saveResult = await botPool.withAiConfigLock(botId, async () => {
        const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
        if (!bot) return { kind: "not_found" as const };
        const currentRevision = aiConfigRevision(bot.updatedAt);
        if (body.revision !== currentRevision) {
          return {
            kind: "conflict" as const,
            data: toAiConfigPublic(bot.aiConfig),
            revision: currentRevision,
          };
        }

        // Migrate existing stored config first so we can reliably look up per-provider
        // encrypted keys by id when the client sends back the same provider without a new apiKey.
        const existingMigrated = bot.aiConfig ? migrateAiConfig(bot.aiConfig) : null;
        const existingProvidersById = new Map<string, AiProviderEntry>();
        for (const p of existingMigrated?.providers ?? []) {
          existingProvidersById.set(p.id, p);
        }

        // Build new providers list with preserve-when-empty apiKey per entry.
        // Client sends temp ids like "__new_xxx" for unsaved providers; map them to real
        // UUIDs here. Runtime selection is deliberately preserved from the latest stored
        // config; the dedicated ai-selection endpoint is its only ordinary writer.
        let providers: AiProviderEntry[] | undefined;
        let requestedInitialProviderId: string | undefined = body.activeProviderId;
        const providerIdMap = new Map<string, string>();
        if (body.providers !== undefined) {
          providers = body.providers.map((p) => {
            const isTemp = !p.id || p.id.startsWith("__new_");
            const finalId = isTemp ? randomUUID() : p.id!;
            if (p.id) providerIdMap.set(p.id, finalId);
            const existing = isTemp ? undefined : existingProvidersById.get(finalId);
            const suppliedApiKey = p.apiKey?.trim();
            const changedBaseURL =
              existing !== undefined &&
              normalizeBaseURLForComparison(existing.baseURL) !==
                normalizeBaseURLForComparison(p.baseURL);
            if (existing?.encryptedApiKey && changedBaseURL && !suppliedApiKey) {
              throw new HTTPException(400, {
                message: `Provider "${p.label}" requires a new API key when its base URL changes`,
              });
            }
            const encryptedApiKey = suppliedApiKey
              ? encrypt(suppliedApiKey, env.ENCRYPTION_KEY)
              : (existing?.encryptedApiKey ?? null);
            return normalizeAiProvider({
              id: finalId,
              label: p.label,
              encryptedApiKey,
              baseURL: p.baseURL,
              modelDiscoveryPath: p.modelDiscoveryPath,
              providerFormat: p.providerFormat,
              defaultModel: p.defaultModel,
              models: p.models,
            });
          });
          if (requestedInitialProviderId && providerIdMap.has(requestedInitialProviderId)) {
            requestedInitialProviderId = providerIdMap.get(requestedInitialProviderId);
          }
        }
        const effectiveProviders = providers ?? existingMigrated?.providers ?? [];
        const existingProviderId = existingMigrated?.activeProviderId;
        const selectedProviderId = existingMigrated
          ? effectiveProviders.some((provider) => provider.id === existingProviderId)
            ? existingProviderId
            : effectiveProviders[0]?.id
          : effectiveProviders.some((provider) => provider.id === requestedInitialProviderId)
            ? requestedInitialProviderId
            : effectiveProviders[0]?.id;
        const selectedProvider = effectiveProviders.find(
          (provider) => provider.id === selectedProviderId,
        );
        const requestedActiveModelId =
          existingMigrated && selectedProviderId === existingMigrated.activeProviderId
            ? existingMigrated.activeModelId
            : !existingMigrated
              ? body.activeModelId
              : undefined;
        if (
          requestedActiveModelId &&
          selectedProvider &&
          requestedActiveModelId !== selectedProvider.defaultModel &&
          !selectedProvider.models?.some((model) => model.id === requestedActiveModelId)
        ) {
          throw new HTTPException(400, {
            message: "The selected model is not available for the active Provider",
          });
        }
        const activeModelId = requestedActiveModelId ?? selectedProvider?.defaultModel;

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

        let githubToolsConfig = bot.aiConfig?.githubToolsConfig;
        if (body.githubToolsConfig) {
          const requestedCodingProviderId = body.githubToolsConfig.codingProviderId
            ? (providerIdMap.get(body.githubToolsConfig.codingProviderId) ??
              body.githubToolsConfig.codingProviderId)
            : undefined;
          const effectiveProviders = providers ?? existingMigrated?.providers ?? [];
          assertGitHubCodingModelSelection(
            effectiveProviders,
            requestedCodingProviderId,
            body.githubToolsConfig.codingModelId,
          );
          assertGitHubCredentialUpdateAllowed(
            c.get("authMember").role,
            githubToolsConfig,
            body.githubToolsConfig,
          );
          const encryptedToken = body.githubToolsConfig.token
            ? encrypt(body.githubToolsConfig.token, env.ENCRYPTION_KEY)
            : githubToolsConfig?.encryptedToken;
          githubToolsConfig = {
            ...githubToolsConfig,
            enabled: body.githubToolsConfig.enabled,
            publicReadEnabled: body.githubToolsConfig.publicReadEnabled,
            codingAgentEnabled: body.githubToolsConfig.codingAgentEnabled,
            codingProviderId: requestedCodingProviderId,
            codingModelId: body.githubToolsConfig.codingModelId,
            encryptedToken,
            login:
              body.githubToolsConfig.login === undefined
                ? githubToolsConfig?.login
                : body.githubToolsConfig.login || undefined,
            authorName: body.githubToolsConfig.authorName,
            authorEmail: body.githubToolsConfig.authorEmail,
            repositories: [
              ...new Set(body.githubToolsConfig.repositories.map((repo) => repo.toLowerCase())),
            ],
          };
        }
        if (githubToolsConfig) {
          assertGitHubCodingModelSelection(
            providers ?? existingMigrated?.providers ?? [],
            githubToolsConfig.codingProviderId,
            githubToolsConfig.codingModelId,
          );
        }
        const imageOcrConfig = body.imageOcrConfig
          ? {
              ...body.imageOcrConfig,
              providerId: body.imageOcrConfig.providerId
                ? (providerIdMap.get(body.imageOcrConfig.providerId) ??
                  body.imageOcrConfig.providerId)
                : undefined,
            }
          : bot.aiConfig?.imageOcrConfig;

        const updatedAiConfig: AiConfigStored = {
          enabled: body.enabled,
          encryptedApiKey,
          baseURL: body.baseURL,
          model: effectiveModel,
          providerFormat: body.providerFormat,
          providers: providers ?? existingMigrated?.providers,
          activeProviderId: selectedProviderId,
          activeModelId,
          aiSelectionDisplayDefault:
            existingMigrated?.aiSelectionDisplayDefault ?? body.aiSelectionDisplayDefault ?? "show",
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
          githubToolsConfig,
          artworkToolsConfig: body.artworkToolsConfig,
          botMemoryConfig: body.botMemoryConfig,
          messageConfig: body.messageConfig,
          executionConfig:
            body.executionConfig ??
            existingMigrated?.executionConfig ??
            DEFAULT_AI_EXECUTION_CONFIG,
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
          imageOcrConfig,
          skillConfig: existingMigrated?.skillConfig,
        };

        const changedAt = new Date(Math.max(Date.now(), (bot.updatedAt?.getTime() ?? 0) + 1));
        await db
          .update(bots)
          .set({ aiConfig: updatedAiConfig, updatedAt: changedAt })
          .where(eq(bots.id, botId));
        return {
          kind: "saved" as const,
          aiConfig: updatedAiConfig,
          revision: aiConfigRevision(changedAt),
        };
      });

      if (saveResult.kind === "not_found") {
        return c.json({ ok: false as const, error: "Bot not found" }, 404);
      }
      if (saveResult.kind === "conflict") {
        return c.json(
          {
            ok: false as const,
            error: "AI configuration changed since it was loaded",
            code: "stale_revision" as const,
            latest: { data: saveResult.data, revision: saveResult.revision },
          },
          409,
        );
      }

      botPool.invalidateGitHubCredentials(botId);

      if (
        chatAiSelectionService &&
        saveResult.aiConfig.providers?.some((provider) => provider.encryptedApiKey)
      ) {
        try {
          await chatAiSelectionService.reconcileCatalog(botId);
        } catch (error) {
          console.error("AI selection reconciliation after catalog save failed", { botId, error });
          return c.json(
            {
              ok: false as const,
              code: "saved_apply_failed" as const,
              error: "AI 配置已保存，但当前 Provider / Model 同步失败。请重试运行选择同步",
              revision: saveResult.revision,
            },
            503,
          );
        }
      }

      // Restart bot if running so new config takes effect
      const manager = botPool.getManager(botId);
      if (manager) {
        try {
          await botPool.restartBot(botId);
        } catch (error) {
          console.error("Bot restart after AI config save failed", { botId, error });
          return c.json(
            {
              ok: false as const,
              code: "saved_apply_failed" as const,
              error: "AI 配置已保存，但 Bot 重启失败。请检查服务端日志并手动重启 Bot",
              revision: saveResult.revision,
            },
            503,
          );
        }
      }

      return c.json({
        ok: true as const,
        data: toAiConfigPublic(saveResult.aiConfig),
        revision: saveResult.revision,
      });
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
    .get("/:botId/profiles/:profileId/avatar", async (c) => {
      const botId = c.req.param("botId");
      const profileId = Number(c.req.param("profileId"));
      if (!Number.isInteger(profileId) || profileId <= 0) {
        return c.json({ ok: false as const, error: "Invalid profileId" }, 400);
      }
      const profile = await botPool.getProfileStore().getProfileById(botId, profileId);
      if (!profile?.avatarPath) {
        return c.json({ ok: false as const, error: "Avatar not found" }, 404);
      }
      const resolved = resolveAndValidate(getDataDir(botId), profile.avatarPath);
      if (!resolved) return c.json({ ok: false as const, error: "Invalid avatar path" }, 403);
      try {
        const buffer = await fs.readFile(resolved);
        return c.body(buffer, 200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, max-age=86400",
          ETag: `"${profile.avatarVersion ?? profile.telegramId}"`,
        });
      } catch {
        return c.json({ ok: false as const, error: "Avatar not found" }, 404);
      }
    })
    .delete("/:botId/profiles/:profileId", async (c) => {
      const botId = c.req.param("botId");
      const profileId = Number(c.req.param("profileId"));
      const store = botPool.getProfileStore();
      await store.deleteProfile(botId, profileId, (profile) =>
        cleanupProfileAvatarFiles(getDataDir(botId), profile.telegramId),
      );
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
        const result = await store.createProfile(botId, c.req.valid("json"));
        if (!result.created) {
          return c.json({ ok: false as const, error: "Profile already exists" }, 409);
        }
        return c.json({ ok: true as const, data: result.profile }, 201);
      },
    )
    .post("/:botId/ai-models", zValidator("json", aiModelsSchema), async (c) => {
      const botId = c.req.param("botId");
      const body = c.req.valid("json");
      const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const migrated = bot.aiConfig ? migrateAiConfig(bot.aiConfig) : null;
      const storedProvider = body.providerId
        ? migrated?.providers?.find((provider) => provider.id === body.providerId)
        : migrated
          ? getActiveProvider(migrated)
          : null;
      const draftApiKey = body.apiKey?.trim() || undefined;

      let apiKey = draftApiKey;
      let baseURL = body.baseURL;
      let modelDiscoveryPath = body.modelDiscoveryPath;

      if (storedProvider) {
        baseURL ??= storedProvider.baseURL;
        modelDiscoveryPath ??= storedProvider.modelDiscoveryPath ?? DEFAULT_MODEL_DISCOVERY_PATH;

        const changedBaseURL =
          body.baseURL !== undefined &&
          normalizeBaseURLForComparison(body.baseURL) !==
            normalizeBaseURLForComparison(storedProvider.baseURL);
        if (changedBaseURL && !draftApiKey) {
          return c.json(
            {
              ok: false as const,
              error: "An API key is required when testing a changed base URL",
            },
            400,
          );
        }

        if (!apiKey && storedProvider.encryptedApiKey) {
          try {
            apiKey = decrypt(storedProvider.encryptedApiKey, env.ENCRYPTION_KEY);
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
      } else {
        if (body.providerId === undefined) {
          modelDiscoveryPath ??= DEFAULT_MODEL_DISCOVERY_PATH;
        }
        if (!baseURL || !apiKey || modelDiscoveryPath === undefined) {
          return c.json(
            {
              ok: false as const,
              error:
                "Unknown providers require a complete draft with base URL, API key, and discovery path",
            },
            400,
          );
        }
      }

      if (!baseURL) {
        return c.json({ ok: false as const, error: "No base URL configured" }, 400);
      }
      if (!apiKey) {
        return c.json({ ok: false as const, error: "No API key configured" }, 400);
      }
      if (!modelDiscoveryPath) {
        return c.json({ ok: false as const, error: "Model discovery is disabled" }, 400);
      }
      const discoveryURL = resolveModelDiscoveryURL(baseURL, modelDiscoveryPath);
      if (!discoveryURL) {
        return c.json(
          {
            ok: false as const,
            error: "Model discovery path must be a relative path beginning with a single slash",
          },
          400,
        );
      }

      try {
        const res = await fetch(discoveryURL, {
          headers: { Authorization: `Bearer ${apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
        });
        if (!res.ok) {
          const upstreamDetail = await readSafeUpstreamError(res, apiKey);
          return c.json(
            {
              ok: false as const,
              error: `Model discovery failed with HTTP ${res.status}${
                upstreamDetail ? `: ${upstreamDetail}` : ""
              }`,
            },
            502,
          );
        }
        let payload: unknown;
        try {
          payload = JSON.parse(
            await readResponseTextLimited(res, MAX_MODEL_DISCOVERY_RESPONSE_BYTES),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
          ) {
            throw error;
          }
          const detail = error instanceof Error ? error.message : String(error);
          return c.json(
            {
              ok: false as const,
              error: `Model discovery returned an invalid response: ${detail}`,
            },
            502,
          );
        }
        const parsed = aiModelsResponseSchema.safeParse(payload);
        if (!parsed.success) {
          return c.json(
            {
              ok: false as const,
              error: "Model discovery returned an invalid response",
            },
            502,
          );
        }
        const seenModelIds = new Set<string>();
        return c.json({
          ok: true as const,
          data: parsed.data.data.flatMap((model) => {
            if (seenModelIds.has(model.id)) return [];
            seenModelIds.add(model.id);
            return [
              {
                id: model.id,
                owned_by: model.owned_by,
                capabilities: modelCapabilityService.inferCapabilities(model.id),
              },
            ];
          }),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          return c.json(
            {
              ok: false as const,
              error: `Model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1000} seconds`,
            },
            504,
          );
        }
        const msg = sanitizeDiscoveryError(
          err instanceof Error ? err.message : String(err),
          apiKey,
        );
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
