import type { Database } from "@cos-tool-bot/database";
import { bots, miniAppAuditEvents, summaryConfigs, telegramChats } from "@cos-tool-bot/database";
import {
  DEFAULT_CONVERSATION_CONFIG,
  type AiConfigStored,
  type AiGroupOverride,
} from "@cos-tool-bot/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { migrateAiConfig } from "../utils/ai-config-migrate.js";
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_TIMEZONE,
  DEFAULT_WINDOW_HOURS,
} from "./summary-prompts.js";

export interface GroupConfigRuntime {
  applyGroupOverride(input: {
    botId: string;
    chatId: number;
    override: AiGroupOverride;
  }): Promise<void>;
}

export interface GroupConfigPatch {
  group?: {
    enabled?: boolean;
    whitelisted?: boolean;
    trigger?: {
      replyToBot?: boolean;
      mentionBot?: boolean;
      triggerWords?: string[];
      randomReplyPercent?: number;
      randomReplyCooldown?: number;
    };
    conversation?: {
      enabled?: boolean;
      maxContextMessages?: number;
      groupHistoryMaxTokens?: number;
    };
  };
  summary?: {
    enabled?: boolean;
    scheduleHour?: number | null;
    scheduleMinute?: number | null;
    timezone?: string | null;
    windowHours?: number;
    maxMessages?: number | null;
    cooldownSeconds?: number | null;
  };
}

export class GroupConfigConflictError extends Error {
  constructor() {
    super("Stale group configuration revision");
    this.name = "GroupConfigConflictError";
  }
}

export class GroupConfigNotFoundError extends Error {
  constructor() {
    super("Group configuration was not found");
    this.name = "GroupConfigNotFoundError";
  }
}

export class GroupConfigArchivedError extends Error {
  constructor() {
    super("Archived groups are read-only");
    this.name = "GroupConfigArchivedError";
  }
}

export class GroupConfigUnavailableError extends Error {
  constructor() {
    super("AI configuration is not available for this Bot");
    this.name = "GroupConfigUnavailableError";
  }
}

interface BotConfigRow {
  aiConfig: AiConfigStored | null;
  updatedAt: Date | null;
}

type SummaryRow = typeof summaryConfigs.$inferSelect;
type ChatRow = typeof telegramChats.$inferSelect;

function revision(bot: BotConfigRow, summary: SummaryRow | undefined): string {
  return `${bot.updatedAt?.toISOString() ?? "0"}:${summary?.updatedAt?.toISOString() ?? "0"}`;
}

function normalizedConfig(aiConfig: AiConfigStored | null) {
  return aiConfig ? migrateAiConfig(aiConfig) : null;
}

export function nextGroupConfigUpdatedAt(
  now: Date,
  botUpdatedAt: Date | null,
  summaryUpdatedAt: Date | null | undefined,
): Date {
  return new Date(
    Math.max(
      now.getTime(),
      (botUpdatedAt?.getTime() ?? 0) + 1,
      (summaryUpdatedAt?.getTime() ?? 0) + 1,
    ),
  );
}

export function projectGroupConfig(
  bot: BotConfigRow,
  chatId: number,
  summary: SummaryRow | undefined,
) {
  const ai = normalizedConfig(bot.aiConfig);
  const override = ai?.groupOverrides[String(chatId)];
  const trigger = ai?.triggerConfig;
  const conversation = { ...DEFAULT_CONVERSATION_CONFIG, ...ai?.conversationConfig };
  const summaryDefaults = ai?.summaryConfig;
  return {
    revision: revision(bot, summary),
    aiConfigured: ai !== null,
    group: {
      enabled: override?.enabled ?? true,
      whitelisted: override?.whitelisted ?? false,
      trigger: {
        replyToBot: override?.triggerConfig?.replyToBot ?? trigger?.replyToBot ?? true,
        mentionBot: override?.triggerConfig?.mentionBot ?? trigger?.mentionBot ?? true,
        triggerWords: override?.triggerConfig?.triggerWords ?? trigger?.triggerWords ?? [],
        randomReplyPercent:
          override?.triggerConfig?.randomReplyPercent ?? trigger?.randomReplyPercent ?? 0,
        randomReplyCooldown:
          override?.triggerConfig?.randomReplyCooldown ?? trigger?.randomReplyCooldown ?? 0,
      },
      conversation: {
        enabled: override?.conversationEnabled ?? conversation.enabled,
        maxContextMessages: override?.maxContextMessages ?? conversation.maxContextMessages,
        groupHistoryMaxTokens:
          override?.groupHistoryMaxTokens ?? conversation.groupHistoryMaxTokens,
      },
    },
    summary: {
      enabled: summary?.isActive ?? false,
      scheduleHour: summary?.scheduleHour ?? null,
      scheduleMinute: summary?.scheduleMinute ?? null,
      timezone: summary?.timezone ?? summaryDefaults?.timezone ?? DEFAULT_TIMEZONE,
      windowHours:
        summary?.windowHours ?? summaryDefaults?.defaultWindowHours ?? DEFAULT_WINDOW_HOURS,
      maxMessages:
        summary?.maxMessages ?? summaryDefaults?.defaultMaxMessages ?? DEFAULT_MAX_MESSAGES,
      cooldownSeconds:
        summary?.cooldownSeconds ??
        summaryDefaults?.defaultCooldownSeconds ??
        DEFAULT_COOLDOWN_SECONDS,
    },
  };
}

function publicChat(chat: ChatRow) {
  return {
    chatId: chat.chatId,
    type: chat.type as "group" | "supergroup",
    title: chat.title,
    username: chat.username,
    botMembershipStatus: chat.botMembershipStatus,
    membershipObservedAt: chat.membershipObservedAt?.toISOString() ?? null,
    lastObservedAt: chat.lastObservedAt.toISOString(),
    archived: chat.leftAt !== null,
  };
}

export function mergeGroupOverride(
  existing: AiGroupOverride | undefined,
  chatId: number,
  patch: NonNullable<GroupConfigPatch["group"]>,
): AiGroupOverride {
  return {
    ...(existing ?? { chatId, whitelisted: false }),
    chatId,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.whitelisted !== undefined ? { whitelisted: patch.whitelisted } : {}),
    ...(patch.trigger ? { triggerConfig: { ...existing?.triggerConfig, ...patch.trigger } } : {}),
    ...(patch.conversation?.enabled !== undefined
      ? { conversationEnabled: patch.conversation.enabled }
      : {}),
    ...(patch.conversation?.maxContextMessages !== undefined
      ? { maxContextMessages: patch.conversation.maxContextMessages }
      : {}),
    ...(patch.conversation?.groupHistoryMaxTokens !== undefined
      ? { groupHistoryMaxTokens: patch.conversation.groupHistoryMaxTokens }
      : {}),
  };
}

export class GroupConfigService {
  private readonly pendingApply = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly runtime: GroupConfigRuntime,
    private readonly withBotLock: <T>(botId: string, operation: () => Promise<T>) => Promise<T>,
    private readonly now = () => new Date(),
  ) {}

  async list(botId: string, chatIds: readonly number[] | "all") {
    const [bot] = await this.db
      .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
      .from(bots)
      .where(eq(bots.id, botId));
    if (!bot) throw new GroupConfigNotFoundError();
    if (chatIds !== "all" && chatIds.length === 0) return [];
    const condition =
      chatIds === "all"
        ? eq(telegramChats.botId, botId)
        : and(eq(telegramChats.botId, botId), inArray(telegramChats.chatId, [...chatIds]));
    const chats = await this.db
      .select()
      .from(telegramChats)
      .where(condition)
      .orderBy(desc(telegramChats.lastObservedAt));
    const summaries = await this.db
      .select()
      .from(summaryConfigs)
      .where(eq(summaryConfigs.botId, botId));
    const byChat = new Map(summaries.map((row) => [row.chatId, row]));
    return chats.map((chat) => {
      const config = projectGroupConfig(bot, chat.chatId, byChat.get(chat.chatId));
      return {
        ...publicChat(chat),
        config,
        applyState: this.pendingApply.has(`${botId}:${chat.chatId}`) ? "pending" : "applied",
      };
    });
  }

  async read(botId: string, chatId: number) {
    const [[bot], [chat], [summary]] = await Promise.all([
      this.db
        .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
        .from(bots)
        .where(eq(bots.id, botId)),
      this.db
        .select()
        .from(telegramChats)
        .where(and(eq(telegramChats.botId, botId), eq(telegramChats.chatId, chatId))),
      this.db
        .select()
        .from(summaryConfigs)
        .where(and(eq(summaryConfigs.botId, botId), eq(summaryConfigs.chatId, chatId))),
    ]);
    if (!bot || !chat) throw new GroupConfigNotFoundError();
    const config = projectGroupConfig(bot, chatId, summary);
    return {
      ...publicChat(chat),
      config,
      applyState: this.pendingApply.has(`${botId}:${chatId}`) ? "pending" : "applied",
    };
  }

  async patch(input: {
    botId: string;
    chatId: number;
    actorTelegramUserId: number;
    actorRole: "admin" | "operator";
    expectedRevision: string;
    patch: GroupConfigPatch;
  }) {
    const changedFields = [
      ...Object.keys(input.patch.group ?? {}).map((field) => `group.${field}`),
      ...Object.keys(input.patch.summary ?? {}).map((field) => `summary.${field}`),
    ];
    if (changedFields.length === 0)
      return { persisted: true, applied: true, group: await this.read(input.botId, input.chatId) };

    return this.withBotLock(input.botId, async () => {
      const result = await this.db.transaction(async (tx) => {
        const [bot] = await tx
          .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
          .from(bots)
          .where(eq(bots.id, input.botId))
          .for("update");
        const [chat] = await tx
          .select()
          .from(telegramChats)
          .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.chatId)));
        let [summary] = await tx
          .select()
          .from(summaryConfigs)
          .where(
            and(eq(summaryConfigs.botId, input.botId), eq(summaryConfigs.chatId, input.chatId)),
          )
          .for("update");
        if (!bot || !chat) throw new GroupConfigNotFoundError();
        if (chat.leftAt !== null) throw new GroupConfigArchivedError();
        if (revision(bot, summary) !== input.expectedRevision) throw new GroupConfigConflictError();

        const ai = normalizedConfig(bot.aiConfig);
        if (input.patch.group && !ai) throw new GroupConfigUnavailableError();
        let override = ai?.groupOverrides[String(input.chatId)];
        const changedAt = nextGroupConfigUpdatedAt(this.now(), bot.updatedAt, summary?.updatedAt);
        if (input.patch.group) {
          if (!ai) throw new GroupConfigUnavailableError();
          override = mergeGroupOverride(override, input.chatId, input.patch.group);
          const nextAi = {
            ...ai,
            groupOverrides: { ...ai.groupOverrides, [String(input.chatId)]: override },
          };
          await tx
            .update(bots)
            .set({ aiConfig: nextAi, updatedAt: changedAt })
            .where(eq(bots.id, input.botId));
          bot.aiConfig = nextAi;
          bot.updatedAt = changedAt;
        }
        if (input.patch.summary) {
          const values = input.patch.summary;
          if (summary) {
            const [updated] = await tx
              .update(summaryConfigs)
              .set({
                ...(values.enabled !== undefined ? { isActive: values.enabled } : {}),
                ...(values.scheduleHour !== undefined ? { scheduleHour: values.scheduleHour } : {}),
                ...(values.scheduleMinute !== undefined
                  ? { scheduleMinute: values.scheduleMinute }
                  : {}),
                ...(values.timezone !== undefined ? { timezone: values.timezone } : {}),
                ...(values.windowHours !== undefined ? { windowHours: values.windowHours } : {}),
                ...(values.maxMessages !== undefined ? { maxMessages: values.maxMessages } : {}),
                ...(values.cooldownSeconds !== undefined
                  ? { cooldownSeconds: values.cooldownSeconds }
                  : {}),
                updatedAt: changedAt,
              })
              .where(eq(summaryConfigs.id, summary.id))
              .returning();
            if (!updated) throw new GroupConfigNotFoundError();
            summary = updated;
          } else {
            const [created] = await tx
              .insert(summaryConfigs)
              .values({
                botId: input.botId,
                chatId: input.chatId,
                isActive: values.enabled ?? false,
                scheduleHour: values.scheduleHour ?? null,
                scheduleMinute: values.scheduleMinute ?? null,
                timezone: values.timezone ?? null,
                windowHours: values.windowHours ?? DEFAULT_WINDOW_HOURS,
                maxMessages: values.maxMessages ?? null,
                cooldownSeconds: values.cooldownSeconds ?? null,
                updatedAt: changedAt,
              })
              .returning();
            if (!created) throw new GroupConfigNotFoundError();
            summary = created;
          }
        }
        await tx.insert(miniAppAuditEvents).values({
          botId: input.botId,
          actorTelegramUserId: input.actorTelegramUserId,
          actorRole: input.actorRole,
          capability: "group.config.write",
          action: "group.config.updated",
          resourceType: "chat",
          resourceId: String(input.chatId),
          previousSummary: { revision: input.expectedRevision },
          nextSummary: { revision: revision(bot, summary), changedFields },
          outcome: "succeeded",
          createdAt: changedAt,
        });
        return {
          override,
          runtimeRelevant: input.patch.group !== undefined,
          group: {
            ...publicChat(chat),
            config: projectGroupConfig(bot, input.chatId, summary),
            applyState: "applied" as const,
          },
        };
      });

      let applied = true;
      if (result.runtimeRelevant && result.override) {
        try {
          await this.runtime.applyGroupOverride({
            botId: input.botId,
            chatId: input.chatId,
            override: result.override,
          });
          this.pendingApply.delete(`${input.botId}:${input.chatId}`);
        } catch {
          applied = false;
          this.pendingApply.add(`${input.botId}:${input.chatId}`);
        }
      }
      const applyState = this.pendingApply.has(`${input.botId}:${input.chatId}`)
        ? "pending"
        : "applied";
      return {
        persisted: true,
        applied,
        group: { ...result.group, applyState },
      };
    });
  }

  async retryApply(botId: string, chatId: number) {
    return this.withBotLock(botId, async () => {
      const group = await this.read(botId, chatId);
      if (group.archived) throw new GroupConfigArchivedError();
      const [bot] = await this.db
        .select({ aiConfig: bots.aiConfig })
        .from(bots)
        .where(eq(bots.id, botId));
      const override = bot?.aiConfig
        ? normalizedConfig(bot.aiConfig)?.groupOverrides[String(chatId)]
        : undefined;
      if (!override) throw new GroupConfigNotFoundError();
      await this.runtime.applyGroupOverride({ botId, chatId, override });
      this.pendingApply.delete(`${botId}:${chatId}`);
      return { ...group, applyState: "applied" as const };
    });
  }
}
