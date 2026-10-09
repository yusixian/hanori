import type { Database } from "@cos-tool-bot/database";
import {
  bots,
  imageGenerationConfigs,
  peopleProfiles,
  usageGovernancePolicies,
} from "@cos-tool-bot/database";
import {
  getDefaultUsageLimits,
  type ImageGovernanceConfig,
  type UsageLimits,
  type UsageResource,
  type UsageScope,
} from "@cos-tool-bot/shared";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ilike, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../middleware/better-auth.js";
import type { ImageGenerationService } from "../services/image-generation-service.js";
import type { ImageMcpConnectionService } from "../services/image-mcp-connection-service.js";
import {
  normalizeTelegramChatSubjectQuery,
  searchTelegramChatSubjects,
} from "../services/telegram-chat-subjects.js";
import { escapeLike } from "../utils/search.js";

const LIMIT_KEYS = [
  "ai_bot",
  "ai_chat_user",
  "ai_user_global",
  "ai_chat",
  "image_bot",
  "image_chat_user",
  "image_user_global",
  "image_chat",
  "proactive_bot",
] as const;

const backendIdSchema = z.enum(["mcp_pixai", "mcp_openai", "mcp_gemini", "general_backend"]);
const routeSchema = z.object({
  defaultBackendId: backendIdSchema.optional(),
  backends: z
    .array(
      z.object({
        backendId: backendIdSchema,
        enabled: z.boolean(),
        defaultPresetKey: z.string().min(1).max(128).optional(),
        allowedPresetKeys: z.array(z.string().min(1).max(128)).max(200),
      }),
    )
    .max(4)
    .refine(
      (rows) => new Set(rows.map((row) => row.backendId)).size === rows.length,
      "Duplicate image backend",
    )
    .optional(),
  purpose: z.enum(["anime_illustration", "general_image"]),
  enabled: z.boolean(),
  label: z.string().min(1).max(120),
  useWhen: z.string().min(1).max(1_000),
  avoidWhen: z.string().min(1).max(1_000),
  examples: z.array(z.string().max(300)).max(20),
  defaultPresetKey: z.string().max(128).optional(),
  allowedPresetKeys: z.array(z.string().min(1).max(128)).max(200),
});

const limitSchema = z.object({
  key: z.enum(LIMIT_KEYS),
  label: z.string(),
  cooldownSeconds: z.number().int().min(0).optional(),
  hourly: z.number().int().min(0).optional(),
  daily: z.number().int().min(0).optional(),
  monthly: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(0).optional(),
});

const overrideSchema = z
  .object({
    resource: z.enum(["ai_reply", "image"]),
    scope: z.enum(["chat", "user_global", "chat_user"]),
    subjectKey: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => value !== "*"),
    cooldownSeconds: z.number().int().min(0).optional(),
    hourly: z.number().int().min(0).optional(),
    daily: z.number().int().min(0).optional(),
    monthly: z.number().int().min(0).optional(),
    concurrency: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    const valid =
      value.scope === "chat"
        ? /^-\d+$/.test(value.subjectKey)
        : value.scope === "user_global"
          ? /^\d+$/.test(value.subjectKey)
          : /^-\d+:\d+$/.test(value.subjectKey);
    if (!valid) ctx.addIssue({ code: "custom", path: ["subjectKey"], message: "invalid subject" });
  });

const updateSchema = z
  .object({
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
          return true;
        } catch {
          return false;
        }
      }, "invalid timezone"),
    generalRouteMode: z.enum(["off", "explicit_only", "semantic_auto"]),
    privateChatUserIds: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .max(1_000)
      .default([]),
    routes: z.array(routeSchema).length(2),
    limits: z.array(limitSchema).max(LIMIT_KEYS.length),
    overrides: z.array(overrideSchema).max(200).default([]),
  })
  .superRefine((value, ctx) => {
    const hasDuplicate = <T>(items: T[], key: (item: T) => string) => {
      const seen = new Set<string>();
      return items.some((item) => {
        const current = key(item);
        if (seen.has(current)) return true;
        seen.add(current);
        return false;
      });
    };
    if (hasDuplicate(value.routes, (route) => route.purpose)) {
      ctx.addIssue({ code: "custom", path: ["routes"], message: "duplicate route purpose" });
    }
    if (hasDuplicate(value.privateChatUserIds, String)) {
      ctx.addIssue({
        code: "custom",
        path: ["privateChatUserIds"],
        message: "duplicate private chat user",
      });
    }
    if (hasDuplicate(value.limits, (limit) => limit.key)) {
      ctx.addIssue({ code: "custom", path: ["limits"], message: "duplicate limit key" });
    }
    if (
      hasDuplicate(
        value.overrides,
        (override) => `${override.resource}:${override.scope}:${override.subjectKey}`,
      )
    ) {
      ctx.addIssue({ code: "custom", path: ["overrides"], message: "duplicate override" });
    }
  });

const LIMIT_MAPPINGS: Record<
  (typeof LIMIT_KEYS)[number],
  { resource: UsageResource; scope: UsageScope; label: string }
> = {
  ai_bot: { resource: "ai_reply", scope: "bot", label: "AI · Bot total" },
  ai_chat_user: { resource: "ai_reply", scope: "chat_user", label: "AI · group user" },
  ai_user_global: { resource: "ai_reply", scope: "user_global", label: "AI · user across groups" },
  ai_chat: { resource: "ai_reply", scope: "chat", label: "AI · group total" },
  image_bot: { resource: "image", scope: "bot", label: "Image · Bot total" },
  image_chat_user: { resource: "image", scope: "chat_user", label: "Image · group user" },
  image_user_global: {
    resource: "image",
    scope: "user_global",
    label: "Image · user across groups",
  },
  image_chat: { resource: "image", scope: "chat", label: "Image · group total" },
  proactive_bot: { resource: "proactive_reply", scope: "bot", label: "Proactive replies · Bot" },
};

export function governanceRoutes(
  db: Database,
  imageService: ImageGenerationService,
  connectionService: ImageMcpConnectionService,
  connections?: Partial<Record<"mcp_openai" | "mcp_gemini", ImageMcpConnectionService>>,
) {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/:botId/governance", async (c) => {
      const botId = c.req.param("botId");
      const [bot] = await db.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).limit(1);
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
      const [config, connection, policies] = await Promise.all([
        imageService.getConfig(botId),
        connectionService.getStatus(),
        db
          .select({
            resource: usageGovernancePolicies.resource,
            scope: usageGovernancePolicies.scope,
            subjectKey: usageGovernancePolicies.subjectKey,
            limits: usageGovernancePolicies.limits,
          })
          .from(usageGovernancePolicies)
          .where(eq(usageGovernancePolicies.botId, botId)),
      ]);
      return c.json({
        ok: true as const,
        data: {
          ...config,
          connection,
          connections: {
            mcp_openai: await connections?.mcp_openai?.getStatus(),
            mcp_gemini: await connections?.mcp_gemini?.getStatus(),
          },
          limits: Object.entries(LIMIT_MAPPINGS).map(([key, mapping]) => {
            const configured = policies.find(
              (policy) =>
                policy.resource === mapping.resource &&
                policy.scope === mapping.scope &&
                policy.subjectKey === "*",
            )?.limits;
            const defaults =
              configured ?? getDefaultUsageLimits(mapping.resource, mapping.scope, "group") ?? {};
            return toLimitDraft(key, mapping.label, defaults);
          }),
          overrides: policies
            .filter((policy) => policy.subjectKey !== "*")
            .map((policy) => ({
              resource: policy.resource,
              scope: policy.scope,
              subjectKey: policy.subjectKey,
              ...toLimitValues(policy.limits),
            })),
        },
      });
    })
    .get("/:botId/governance/subjects", async (c) => {
      const botId = c.req.param("botId");
      const kind = c.req.query("kind");
      const query = normalizeTelegramChatSubjectQuery(c.req.query("query"));
      if ((kind !== "chat" && kind !== "user") || query.length > 64) {
        return c.json({ ok: false as const, error: "invalid_subject_search" }, 400);
      }
      const [bot] = await db.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).limit(1);
      if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);

      const pattern = `%${escapeLike(query)}%`;
      if (kind === "chat") {
        return c.json({
          ok: true as const,
          subjects: await searchTelegramChatSubjects(db, botId, query),
        });
      }

      const numericId = /^\d+$/.test(query) ? Number(query) : undefined;
      const matches = query
        ? numericId !== undefined && Number.isSafeInteger(numericId)
          ? eq(peopleProfiles.telegramId, numericId)
          : or(ilike(peopleProfiles.displayName, pattern), ilike(peopleProfiles.username, pattern))
        : undefined;
      const subjects = await db
        .select({
          id: peopleProfiles.telegramId,
          name: peopleProfiles.displayName,
          username: peopleProfiles.username,
        })
        .from(peopleProfiles)
        .where(and(eq(peopleProfiles.botId, botId), matches))
        .orderBy(desc(peopleProfiles.lastSeen))
        .limit(20);
      return c.json({
        ok: true as const,
        subjects: subjects.map((subject) => ({ ...subject, id: String(subject.id) })),
      });
    })
    .put(
      "/:botId/governance",
      zValidator("json", updateSchema, (result, c) => {
        if (result.success) return;
        const invalidSubject = result.error.issues.some(
          (issue) => issue.path[0] === "overrides" && issue.path.includes("subjectKey"),
        );
        return c.json(
          {
            ok: false as const,
            error: invalidSubject ? "invalid_override_subject" : "invalid_governance_settings",
          },
          400,
        );
      }),
      async (c) => {
        const botId = c.req.param("botId");
        const body = c.req.valid("json");
        const [bot] = await db
          .select({ id: bots.id })
          .from(bots)
          .where(eq(bots.id, botId))
          .limit(1);
        if (!bot) return c.json({ ok: false as const, error: "Bot not found" }, 404);
        const config: ImageGovernanceConfig = {
          timezone: body.timezone,
          generalRouteMode: body.generalRouteMode,
          privateChatUserIds: body.privateChatUserIds,
          routes: body.routes,
        };
        await db.transaction(async (tx) => {
          await tx
            .insert(imageGenerationConfigs)
            .values({ botId, config })
            .onConflictDoUpdate({
              target: imageGenerationConfigs.botId,
              set: { config, updatedAt: new Date() },
            });
          for (const limit of body.limits) {
            const mapping = LIMIT_MAPPINGS[limit.key];
            const limits = fromLimitDraft(limit);
            await tx
              .insert(usageGovernancePolicies)
              .values({
                botId,
                resource: mapping.resource,
                scope: mapping.scope,
                subjectKey: "*",
                limits,
                updatedByKind: "owner",
                updatedById: c.get("authUser").id,
              })
              .onConflictDoUpdate({
                target: [
                  usageGovernancePolicies.botId,
                  usageGovernancePolicies.resource,
                  usageGovernancePolicies.scope,
                  usageGovernancePolicies.subjectKey,
                ],
                set: {
                  limits,
                  updatedByKind: "owner",
                  updatedById: c.get("authUser").id,
                  updatedAt: new Date(),
                },
              });
          }
          await tx
            .delete(usageGovernancePolicies)
            .where(
              and(
                eq(usageGovernancePolicies.botId, botId),
                ne(usageGovernancePolicies.subjectKey, "*"),
              ),
            );
          if (body.overrides.length > 0) {
            await tx.insert(usageGovernancePolicies).values(
              body.overrides.map((override) => ({
                botId,
                resource: override.resource,
                scope: override.scope,
                subjectKey: override.subjectKey,
                limits: fromLimitDraft(override),
                updatedByKind: "owner" as const,
                updatedById: c.get("authUser").id,
              })),
            );
          }
        });
        return c.json({
          ok: true as const,
          data: {
            ...config,
            connection: await connectionService.getStatus(),
            connections: {
              mcp_openai: await connections?.mcp_openai?.getStatus(),
              mcp_gemini: await connections?.mcp_gemini?.getStatus(),
            },
            limits: body.limits,
            overrides: body.overrides,
          },
        });
      },
    );
}

function toLimitDraft(key: string, label: string, limits: UsageLimits) {
  return {
    key,
    label,
    ...toLimitValues(limits),
  };
}

function toLimitValues(limits: UsageLimits) {
  return {
    cooldownSeconds:
      limits.cooldownMs === undefined ? undefined : Math.floor(limits.cooldownMs / 1_000),
    hourly: limits.hour,
    daily: limits.day,
    monthly: limits.month,
    concurrency: limits.maxConcurrent,
  };
}

function fromLimitDraft(input: {
  cooldownSeconds?: number;
  hourly?: number;
  daily?: number;
  monthly?: number;
  concurrency?: number;
}): UsageLimits {
  return {
    cooldownMs: input.cooldownSeconds === undefined ? undefined : input.cooldownSeconds * 1_000,
    hour: input.hourly,
    day: input.daily,
    month: input.monthly,
    maxConcurrent: input.concurrency,
  };
}
