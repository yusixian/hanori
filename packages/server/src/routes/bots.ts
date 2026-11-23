import {
  assemblePromptPreview,
  cleanupBotAvatarFiles,
  cleanupProfileAvatarFiles,
  isBuiltInSkillId,
  listBotSkills,
  resolveBotSkills,
} from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import { bots } from "@cos-tool-bot/database";
import type { AiConfigStored, BotWithStatus } from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq, ilike } from "drizzle-orm";
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
import type { HistoricalBatchPage } from "../services/memory-consolidator.js";
import {
  MemoryLegacyCleanup,
  MEMORY_DUPLICATE_BATCH_MAX,
} from "../services/memory-legacy-cleanup.js";
import { AiConfigPatchError, absorbAiConfigPatch } from "../services/ai-config-patch.js";
import {
  aiConfigRevision,
  hasActiveApiKey,
  toAiConfigPublic,
} from "../services/ai-config-public-view.js";
import {
  aiConfigSchema,
  isValidModelDiscoveryPath,
  modelDiscoveryPathSchema,
  normalizeBaseURLForComparison,
} from "../services/ai-config-schema.js";
import type { ModelCapabilityService } from "../services/model-capability-service.js";
import { decrypt, encrypt, maskToken } from "../utils/crypto.js";
import { createDataFilesLoader } from "../utils/data-files-loader.js";
import {
  DEFAULT_MODEL_DISCOVERY_PATH,
  getActiveProvider,
  migrateAiConfig,
} from "../utils/ai-config-migrate.js";
import { getDataDir, resolveAndValidate } from "../utils/file-validation.js";
import { escapeLike } from "../utils/search.js";

const cosInsideConfigSchema = z
  .object({
    targets: z
      .array(
        z.object({
          alias: z
            .string()
            .trim()
            .min(1)
            .max(32)
            .regex(
              /^[a-z0-9_-]+$/i,
              "Alias may only contain letters, digits, hyphen or underscore",
            ),
          chatId: z.number().int().max(-1).min(-9007199254740991),
        }),
      )
      .max(20),
  })
  .refine(
    ({ targets }) =>
      new Set(targets.map(({ alias }) => alias.toLowerCase())).size === targets.length,
    { message: "Relay target aliases must be unique" },
  );

const memoryTelegramIdFilterSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (value === "" || value === "general") return true;
    return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
  }, "telegramId must be general or a decimal safe integer")
  .optional();

export interface MemoryConsolidationPreviewPort {
  previewHistoricalBatches(
    botId: string,
    options: { afterMessageId?: number; limit?: number },
  ): Promise<HistoricalBatchPage>;
}

const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.literal("telegram").default("telegram"),
  token: z.string().min(1),
  adminChatIds: z.array(z.number()).default([]),
  isActive: z.boolean().default(true),
  miniAppEnabled: z.boolean().default(false),
  cosInsideConfig: cosInsideConfigSchema.optional(),
});

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  token: z.string().min(1).optional(),
  adminChatIds: z.array(z.number()).optional(),
  isActive: z.boolean().optional(),
  miniAppEnabled: z.boolean().optional(),
  cosInsideConfig: cosInsideConfigSchema.optional(),
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
  let tokenMasked: string;
  try {
    const token = decrypt(bot.encryptedToken, env.ENCRYPTION_KEY);
    tokenMasked = token === "__IMPORT_PLACEHOLDER__" ? "(未配置)" : maskToken(token);
  } catch {
    tokenMasked = "(密钥不匹配)";
  }
  return {
    id: bot.id,
    name: bot.name,
    platform: "telegram",
    tokenMasked,
    adminChatIds: bot.adminChatIds,
    isActive: bot.isActive,
    miniAppEnabled: bot.miniAppEnabled,
    aiEnabled: bot.aiConfig?.enabled ?? false,
    aiHasApiKey: hasActiveApiKey(bot.aiConfig),
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt?.toISOString() ?? null,
    status: manager?.status ?? "stopped",
    uptime: manager?.uptime ?? null,
    cosInsideConfig: bot.cosInsideConfig ?? undefined,
  };
}

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
  memoryConsolidationPreview?: MemoryConsolidationPreviewPort,
) {
  return new Hono<{ Variables: AuthVariables }>()
    .get(
      "/",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(20),
          search: z.string().max(100).trim().optional(),
        }),
      ),
      async (c) => {
        const { page, limit, search } = c.req.valid("query");
        const offset = (page - 1) * limit;
        const nameFilter = search ? ilike(bots.name, `%${escapeLike(search)}%`) : undefined;

        const botFilter = and(eq(bots.platform, "telegram"), nameFilter);
        const [allBots, [countResult]] = await Promise.all([
          db
            .select()
            .from(bots)
            .where(botFilter)
            .orderBy(asc(bots.createdAt), asc(bots.id))
            .limit(limit)
            .offset(offset),
          db.select({ total: count() }).from(bots).where(botFilter),
        ]);

        const data = allBots.map((b) => toBotWithStatus(b, botPool));
        return c.json({ ok: true as const, data, total: Number(countResult?.total ?? 0) });
      },
    )
    .get("/:botId", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      return c.json({ ok: true as const, data: toBotWithStatus(bot, botPool) });
    })
    .post("/", zValidator("json", createBotSchema), async (c) => {
      const body = c.req.valid("json");
      if (!ownerOrAdmin.has(c.get("authMember").role)) {
        return c.json({ ok: false as const, error: "当前角色没有权限创建 Bot" }, 403);
      }

      const rows = await db
        .insert(bots)
        .values({
          name: body.name,
          platform: "telegram",
          encryptedToken: encrypt(body.token, env.ENCRYPTION_KEY),
          adminChatIds: body.adminChatIds,
          isActive: body.isActive,
          miniAppEnabled: body.miniAppEnabled,
          cosInsideConfig: body.cosInsideConfig ?? null,
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
      const [existing] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
        body.cosInsideConfig !== undefined ||
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

      if (body.cosInsideConfig !== undefined) updates.cosInsideConfig = body.cosInsideConfig;

      const rows = await db
        .update(bots)
        .set(updates)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")))
        .returning();
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
          body.miniAppEnabled !== undefined ||
          body.cosInsideConfig !== undefined;
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
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
      const dataDir = getDataDir(botId);
      if (!bot) {
        await cleanupBotAvatarFiles(dataDir);
        return c.json({ ok: false as const, error: "Bot not found" }, 404);
      }
      await botPool.stopBot(botId);
      await cleanupBotAvatarFiles(dataDir);
      await db.delete(bots).where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
      botPool.clearDeletedBotGenerationState(botId);
      await cleanupBotAvatarFiles(dataDir);
      return c.json({ ok: true as const });
    })
    .post("/:botId/start", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
          unifiedSearchEnabled: z.boolean().optional(),
          agentToolsConfig: z.any().optional(),
          artworkToolsEnabled: z.boolean().optional(),
          messageConfig: z.any().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const body = c.req.valid("json");

        // Data files are loaded from disk (not part of form state)
        const [bot] = await db
          .select()
          .from(bots)
          .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
          unifiedSearchEnabled: body.unifiedSearchEnabled !== false,
          agentToolsConfig: body.agentToolsConfig,
          artworkToolsEnabled: body.artworkToolsEnabled,
          hasFileTools: !!dataFiles,
          dataFiles,
          messageConfig: body.messageConfig,
          hasImageGeneration: true,
          skills: resolveBotSkills(bot?.aiConfig?.skillConfig),
          timerMaxSeconds: bot?.aiConfig?.executionConfig?.timerMaxSeconds,
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
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
        const [bot] = await db
          .select()
          .from(bots)
          .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
          .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
        const [bot] = await db
          .select()
          .from(bots)
          .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
        if (!bot) return { kind: "not_found" as const };
        const currentRevision = aiConfigRevision(bot.updatedAt);
        if (body.revision !== currentRevision) {
          return {
            kind: "conflict" as const,
            data: toAiConfigPublic(bot.aiConfig),
            revision: currentRevision,
          };
        }

        let updatedAiConfig: AiConfigStored;
        try {
          updatedAiConfig = absorbAiConfigPatch({
            current: bot.aiConfig,
            patch: body,
            actorRole: c.get("authMember").role,
            encryptionKey: env.ENCRYPTION_KEY,
          });
        } catch (error) {
          if (error instanceof AiConfigPatchError) {
            throw new HTTPException(400, { message: error.message });
          }
          throw error;
        }

        const changedAt = new Date(Math.max(Date.now(), (bot.updatedAt?.getTime() ?? 0) + 1));
        await db
          .update(bots)
          .set({ aiConfig: updatedAiConfig, updatedAt: changedAt })
          .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
          search: z.string().trim().max(100).optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const { page, limit, search } = c.req.valid("query");
        const store = botPool.getConversationStore();
        const result = await store.getConversationList(botId, page, limit, search);
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
    .get("/:botId/conversations/:chatId/summaries/cleanup-preview", async (c) => {
      const chatId = Number(c.req.param("chatId"));
      if (!Number.isSafeInteger(chatId))
        return c.json({ ok: false as const, error: "Invalid chatId" }, 400);
      const store = botPool.getConversationStore();
      const result = await store.previewConversationSummaryCleanup(c.req.param("botId"), chatId);
      return c.json({ ok: true as const, ...result });
    })
    .post(
      "/:botId/conversations/:chatId/summaries/cleanup-batch",
      zValidator(
        "json",
        z.object({
          expectedActiveSummaryId: z.number().int().positive().nullable(),
          limit: z.number().int().positive().max(100).optional().default(100),
        }),
      ),
      async (c) => {
        if (!ownerOrAdmin.has(c.get("authMember").role))
          return c.json({ ok: false as const, error: "Forbidden" }, 403);
        const chatId = Number(c.req.param("chatId"));
        if (!Number.isSafeInteger(chatId))
          return c.json({ ok: false as const, error: "Invalid chatId" }, 400);
        const store = botPool.getConversationStore();
        const result = await store.cleanupConversationSummaryBatch({
          botId: c.req.param("botId"),
          chatId,
          ...c.req.valid("json"),
        });
        if (!result) return c.json({ ok: false as const, error: "Active summary changed" }, 409);
        return c.json({ ok: true as const, ...result });
      },
    )
    .patch(
      "/:botId/conversations/:chatId/summaries/active",
      zValidator(
        "json",
        z.object({
          expectedActiveSummaryId: z.number().int().positive(),
          content: z.string().trim().min(1).max(40_000),
        }),
      ),
      async (c) => {
        if (!ownerOrAdmin.has(c.get("authMember").role))
          return c.json({ ok: false as const, error: "Forbidden" }, 403);
        const chatId = Number(c.req.param("chatId"));
        if (!Number.isSafeInteger(chatId))
          return c.json({ ok: false as const, error: "Invalid chatId" }, 400);
        const store = botPool.getConversationStore();
        const result = await store.editActiveConversationSummary({
          botId: c.req.param("botId"),
          chatId,
          ...c.req.valid("json"),
        });
        if (!result) return c.json({ ok: false as const, error: "Active summary changed" }, 409);
        return c.json({ ok: true as const, ...result });
      },
    )
    .delete("/:botId/conversations/:chatId/summaries/:id", async (c) => {
      if (!ownerOrAdmin.has(c.get("authMember").role))
        return c.json({ ok: false as const, error: "Forbidden" }, 403);
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
        const result = await store.listProfiles(botId, page, limit, search);
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
      const [bot] = await db
        .select()
        .from(bots)
        .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
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
    .get("/:botId/memories/duplicate-preview", async (c) => {
      if (!ownerOrAdmin.has(c.get("authMember").role))
        return c.json({ ok: false as const, error: "Forbidden" }, 403);
      const result = await new MemoryLegacyCleanup(db).preview(c.req.param("botId"));
      return c.json({ ok: true as const, ...result });
    })
    .get(
      "/:botId/memories/consolidation-preview",
      zValidator(
        "query",
        z.object({
          afterMessageId: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
          limit: z.coerce.number().int().min(1).max(5).optional(),
        }),
      ),
      async (c) => {
        if (!ownerOrAdmin.has(c.get("authMember").role))
          return c.json({ ok: false as const, error: "Forbidden" }, 403);
        if (!memoryConsolidationPreview)
          return c.json({ ok: false as const, error: "Memory preview unavailable" }, 503);

        const result = await memoryConsolidationPreview.previewHistoricalBatches(
          c.req.param("botId"),
          c.req.valid("query"),
        );
        return c.json({ ok: true as const, ...result });
      },
    )
    .post(
      "/:botId/memories/retire-duplicates",
      zValidator(
        "json",
        z.object({
          candidates: z
            .array(
              z.object({
                candidateId: z.number().int().positive().safe(),
                survivorId: z.number().int().positive().safe(),
                expectedCandidateUpdatedAt: z.string().datetime({ offset: true }),
                expectedSurvivorUpdatedAt: z.string().datetime({ offset: true }),
              }),
            )
            .min(1)
            .max(MEMORY_DUPLICATE_BATCH_MAX)
            .refine((candidates) => {
              const candidateIds = candidates.map(({ candidateId }) => candidateId);
              const unique = new Set(candidateIds);
              return (
                unique.size === candidateIds.length &&
                candidates.every(({ survivorId }) => !unique.has(survivorId))
              );
            }, "Duplicate or chained cleanup candidates are not allowed"),
        }),
      ),
      async (c) => {
        if (!ownerOrAdmin.has(c.get("authMember").role))
          return c.json({ ok: false as const, error: "Forbidden" }, 403);
        const result = await new MemoryLegacyCleanup(db).retireBatch(
          c.req.param("botId"),
          c.req.valid("json").candidates,
        );
        if (!result)
          return c.json({ ok: false as const, error: "Memories changed; refresh preview" }, 409);
        return c.json({ ok: true as const, ...result });
      },
    )
    .get(
      "/:botId/memories",
      zValidator(
        "query",
        z.object({
          page: z.coerce.number().int().positive().optional().default(1),
          limit: z.coerce.number().int().positive().max(100).optional().default(20),
          category: z.string().optional(),
          telegramId: memoryTelegramIdFilterSchema,
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
        } else if (telegramId) tidFilter = Number(telegramId);

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
          kind: z.enum(["fact", "preference", "event", "commitment", "relationship"]).optional(),
          scopeChatId: z.number().int().safe().optional(),
          expiresAt: z.string().datetime({ offset: true }).optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const body = c.req.valid("json");
        const memory = await botPool.createBotMemoryForAdmin(botId, { ...body, origin: "admin" });
        return c.json({ ok: true as const, data: memory }, 201);
      },
    )
    .put(
      "/:botId/memories/:memoryId",
      zValidator(
        "json",
        z.object({
          content: z.string().min(1).optional(),
          expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
          category: z.string().nullable().optional(),
          telegramId: z.number().nullable().optional(),
          kind: z
            .enum(["fact", "preference", "event", "commitment", "relationship"])
            .nullable()
            .optional(),
          scopeChatId: z.number().int().safe().nullable().optional(),
          expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
        }),
      ),
      async (c) => {
        const botId = c.req.param("botId");
        const memoryId = Number(c.req.param("memoryId"));
        const body = c.req.valid("json");
        const updated = await botPool.updateBotMemoryForAdmin(botId, memoryId, body);
        if (!updated) {
          const existing = await botPool.getBotMemoryStore().getMemory(botId, memoryId);
          return existing
            ? c.json({ ok: false as const, error: "Memory changed; refresh before saving" }, 409)
            : c.json({ ok: false as const, error: "Memory not found" }, 404);
        }
        return c.json({ ok: true as const, data: updated });
      },
    )
    .post(
      "/:botId/memories/:memoryId/retire",
      zValidator("json", z.object({ supersededById: z.number().int().positive().optional() })),
      async (c) => {
        const botId = c.req.param("botId");
        const memoryId = Number(c.req.param("memoryId"));
        const { supersededById } = c.req.valid("json");
        const retired = await botPool
          .getBotMemoryStore()
          .retireMemory(botId, memoryId, supersededById);
        if (!retired)
          return c.json({ ok: false as const, error: "Memory not found or changed" }, 404);
        return c.json({ ok: true as const });
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
