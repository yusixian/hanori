import {
  AI_SETTING_BOUNDS,
  clampToBounds,
  DEFAULT_CONVERSATION_CONFIG,
  IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH,
  IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH,
  IMAGE_MAX_SIZE,
  IMAGE_MIN_SIZE,
  MAX_CONCURRENT_AI_REPLIES,
  MAX_SUB_AGENT_STEPS,
  MAX_TIMER_MAX_SECONDS,
  MIN_TIMER_MAX_SECONDS,
  type NumericSettingBounds,
} from "@cos-tool-bot/shared";
import { z } from "zod";

export function boundedNumberSchema(bounds: NumericSettingBounds) {
  const number = bounds.integer ? z.number().int() : z.number();
  return number.min(bounds.min).max(bounds.max);
}

/** Older admin saves allowed decimals for this in-range setting; store them rounded. */
function roundedNumberSchema(bounds: NumericSettingBounds) {
  return z.number().min(bounds.min).max(bounds.max).transform(Math.round);
}

/**
 * Older admin saves allowed decimals and had no upper bound here, and the admin page saves back
 * whatever is stored. Keep rejecting values below the minimum, but store the rest clamped into
 * range so re-saving an existing config never starts failing.
 */
function clampedNumberSchema(bounds: NumericSettingBounds) {
  return z
    .number()
    .min(bounds.min)
    .transform((value) => clampToBounds(value, bounds));
}

const triggerConfigSchema = z.object({
  replyToBot: z.boolean(),
  mentionBot: z.boolean(),
  triggerWords: z.array(z.string()),
  randomReplyPercent: boundedNumberSchema(AI_SETTING_BOUNDS.randomReplyPercent),
  randomReplyCooldown: clampedNumberSchema(AI_SETTING_BOUNDS.randomReplyCooldown),
});

export const modelDiscoveryPathSchema = z
  .string()
  .trim()
  .refine((path) => path === "" || isValidModelDiscoveryPath(path), {
    message: "Model discovery path must be empty or begin with a single slash",
  });

export const aiExecutionConfigSchema = z
  .object({
    maxConcurrentReplies: z.number().int().min(1).max(MAX_CONCURRENT_AI_REPLIES),
    timerMaxSeconds: z
      .number()
      .int()
      .min(MIN_TIMER_MAX_SECONDS)
      .max(MAX_TIMER_MAX_SECONDS)
      .optional(),
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

export const engagementPolicySchema = z.object({
  mode: z.enum(["off", "shadow", "active"]),
  style: z.enum(["natural", "assistant", "filter"]),
  preferences: z.string().max(1_000),
  keywordDirect: z.boolean(),
  cooldownSeconds: z.number().int().min(0).max(3_600),
  confidenceThreshold: z.number().min(0).max(1),
  addressedConfidenceThreshold: z.number().min(0).max(1).optional(),
  continueConfidenceThreshold: z.number().min(0).max(1).optional(),
  continuationWindowSeconds: z.number().int().min(0).max(300).optional(),
  contextMessages: z.number().int().min(1).max(20),
  timeoutMs: z.number().int().min(100).max(5_000),
});

export const aiConfigSchema = z
  .object({
    revision: z.string().min(1).max(100),
    engagement: engagementPolicySchema
      .extend({ apiKey: z.string().trim().max(512).optional() })
      .optional(),
    enabled: z.boolean(),
    apiKey: z.string().optional(),
    baseURL: z.string(),
    model: z.string(),
    providerFormat: z.enum(["openai", "gemini"]).optional(),
    systemPrompt: z.string(),
    behavioralPrompt: z.string().optional(),
    groupBehavioralPrompt: z.string().optional(),
    triggerConfig: triggerConfigSchema,
    groupOverrides: z.record(
      z.string(),
      z.object({
        chatId: z.number(),
        chatTitle: z.string().optional(),
        enabled: z.boolean().optional(),
        whitelisted: z.boolean(),
        systemPrompt: z.string().optional(),
        triggerConfig: triggerConfigSchema.partial().optional(),
        conversationEnabled: z.boolean().optional(),
        maxContextMessages: roundedNumberSchema(AI_SETTING_BOUNDS.maxContextMessages).optional(),
        groupHistoryMaxTokens: boundedNumberSchema(
          AI_SETTING_BOUNDS.groupHistoryMaxTokens,
        ).optional(),
        imageGenerationEnabled: z.boolean().optional(),
        imageGenerationConfirmation: z.enum(["always", "never"]).optional(),
        engagement: engagementPolicySchema.partial().nullable().optional(),
      }),
    ),
    imageGenerationConfirmation: z.enum(["always", "never"]).default("always"),
    conversationConfig: z
      .object({
        enabled: z.boolean(),
        maxContextMessages: roundedNumberSchema(AI_SETTING_BOUNDS.maxContextMessages),
        groupHistoryMaxTokens: boundedNumberSchema(AI_SETTING_BOUNDS.groupHistoryMaxTokens).default(
          DEFAULT_CONVERSATION_CONFIG.groupHistoryMaxTokens,
        ),
        historyFormat: z.enum(["prompt", "messages"]).optional(),
        groupBufferSize: z.number().min(10).max(200),
        groupContextMode: z.enum(["all", "random_only", "none"]),
        saveGroupContext: z.enum(["random_only", "all", "none"]),
        autoSummarize: z.boolean(),
        summarizeThreshold: z.number().min(10).max(200),
        compressionProviderId: z.string().trim().min(1).max(100).optional(),
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
    unifiedSearchEnabled: z.boolean().optional(),
    webToolsConfig: z
      .object({
        enabled: z.boolean(),
        trustedPrivateHosts: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
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
    imageGenerationReceiptConfig: z
      .object({
        promptPreviewLength: z
          .number()
          .int()
          .min(0)
          .max(IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH)
          .optional(),
        truncationNoticeEnabled: z.boolean().optional(),
        truncationNoticeText: z
          .string()
          .trim()
          .max(IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH)
          .refine((value) => !/[\r\n]/.test(value), "Notice text must be a single line")
          .optional(),
        albumNoticeEnabled: z.boolean().optional(),
        albumNoticeText: z
          .string()
          .trim()
          .max(IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH)
          .refine((value) => !/[\r\n]/.test(value), "Notice text must be a single line")
          .optional(),
      })
      .optional(),
    agentToolsConfig: z
      .object({
        enabled: z.boolean(),
        subAgentModel: z.string().optional(),
        maxSubAgentSteps: z.number().int().min(1).max(MAX_SUB_AGENT_STEPS).optional(),
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
        createIssueConfirmationTtlMinutes: z.number().int().positive().safe().nullable().optional(),
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
    privateChatAccess: z.enum(["all", "admin", "allowlist"]).optional(),
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
        maxInputImageBytes: z
          .number()
          .int()
          .min(1024)
          .max(50 * 1024 * 1024)
          .optional(),
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
          excludedModelIds: z.array(z.string().trim().min(1)).optional(),
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

export type AiConfigPatch = z.infer<typeof aiConfigSchema>;

export function normalizeBaseURLForComparison(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

export function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isValidModelDiscoveryPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !containsControlCharacter(path)
  );
}
