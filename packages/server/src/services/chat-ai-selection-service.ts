import type { Database } from "@cos-tool-bot/database";
import { bots, chatAiSelections, miniAppAuditEvents, telegramChats } from "@cos-tool-bot/database";
import type {
  AiConfigStored,
  AiGroupOverride,
  AiProviderEntry,
  ModelEntry,
} from "@cos-tool-bot/shared";
import { and, eq } from "drizzle-orm";
import { migrateAiConfig } from "../utils/ai-config-migrate.js";
import { tryDecrypt } from "../utils/crypto.js";
import type {
  ChatAiSelectionPair,
  ChatAiSelectionRuntimeSnapshot,
} from "./chat-ai-selection-runtime-registry.js";
import { ChatAiSelectionRuntimeRegistry } from "./chat-ai-selection-runtime-registry.js";

export type AiSelectionDisplayPolicy = "inherit" | "show" | "hide";
export type AiSelectionActor = {
  kind: "telegram_user" | "better_auth_user";
  id: string;
};

export interface AiSelectionOptionModel {
  id: string;
  label: string;
}

export interface AiSelectionOptionProvider {
  id: string;
  label: string;
  defaultModelId: string;
  models: AiSelectionOptionModel[];
}

export class ChatAiSelectionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "archived"
      | "ai_not_configured"
      | "provider_unavailable"
      | "model_unavailable"
      | "stale_revision",
    message: string,
  ) {
    super(message);
    this.name = "ChatAiSelectionError";
  }
}

type BotRow = Pick<typeof bots.$inferSelect, "aiConfig" | "updatedAt">;
type ConfiguredBotRow = BotRow & { aiConfig: AiConfigStored };
type SelectionRow = typeof chatAiSelections.$inferSelect;

function nextUpdatedAt(now: Date, previous: Date | null): Date {
  return new Date(Math.max(now.getTime(), (previous?.getTime() ?? 0) + 1));
}

function botRevision(bot: BotRow): string {
  return bot.updatedAt?.toISOString() ?? "0";
}

function chatRevision(bot: BotRow, selection?: Pick<SelectionRow, "revision">): string {
  return `${botRevision(bot)}:${selection?.revision ?? 0}`;
}

function snapshotRevision(bot: BotRow, rows: readonly Pick<SelectionRow, "chatId" | "revision">[]) {
  return `${botRevision(bot)}:${[...rows]
    .sort((left, right) => left.chatId - right.chatId)
    .map((row) => `${row.chatId}@${row.revision}`)
    .join(",")}`;
}

function modelLabel(model: ModelEntry | undefined, modelId: string): string {
  return model?.label?.trim() || modelId;
}

function providerModels(provider: AiProviderEntry): AiSelectionOptionModel[] {
  const seen = new Set<string>();
  const result: AiSelectionOptionModel[] = [];
  for (const model of [{ id: provider.defaultModel }, ...(provider.models ?? [])]) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: modelLabel(model, id) });
  }
  return result;
}

export function listUsableAiSelectionOptions(
  config: AiConfigStored | null,
  encryptionKey: string,
): AiSelectionOptionProvider[] {
  if (!config) return [];
  const migrated = migrateAiConfig(config);
  return (migrated.providers ?? []).flatMap((provider) => {
    if (
      !provider.id.trim() ||
      !provider.encryptedApiKey ||
      !tryDecrypt(provider.encryptedApiKey, encryptionKey)
    )
      return [];
    const models = providerModels(provider);
    if (models.length === 0) return [];
    return [
      {
        id: provider.id,
        label: provider.label.trim() || provider.id,
        defaultModelId: provider.defaultModel,
        models,
      },
    ];
  });
}

export function validateAiSelectionPair(
  options: readonly AiSelectionOptionProvider[],
  pair: ChatAiSelectionPair,
): ChatAiSelectionPair {
  const provider = options.find((candidate) => candidate.id === pair.providerId);
  if (!provider) {
    throw new ChatAiSelectionError("provider_unavailable", "Provider is unavailable");
  }
  if (pair.modelId !== null && !provider.models.some((model) => model.id === pair.modelId)) {
    throw new ChatAiSelectionError("model_unavailable", "Model is unavailable for this Provider");
  }
  return { providerId: provider.id, modelId: pair.modelId };
}

function globalPair(config: AiConfigStored, options: readonly AiSelectionOptionProvider[]) {
  const migrated = migrateAiConfig(config);
  const provider =
    options.find((candidate) => candidate.id === migrated.activeProviderId) ?? options[0];
  if (!provider) throw new ChatAiSelectionError("ai_not_configured", "AI is not configured");
  const selectedModel = migrated.activeModelId ?? provider.defaultModelId;
  return {
    providerId: provider.id,
    modelId: provider.models.some((model) => model.id === selectedModel)
      ? selectedModel
      : provider.defaultModelId,
  };
}

function effectivePair(
  global: ChatAiSelectionPair,
  row: Pick<SelectionRow, "providerId" | "modelId"> | undefined,
): ChatAiSelectionPair {
  return row ? { providerId: row.providerId, modelId: row.modelId } : global;
}

function displayPolicy(
  config: AiConfigStored,
  chatId: number,
): {
  defaultPolicy: "show" | "hide";
  overridePolicy: AiSelectionDisplayPolicy;
  visible: boolean;
} {
  const migrated = migrateAiConfig(config);
  const defaultPolicy = migrated.aiSelectionDisplayDefault ?? "show";
  const overridePolicy = migrated.groupOverrides[String(chatId)]?.aiSelectionDisplay ?? "inherit";
  return {
    defaultPolicy,
    overridePolicy,
    visible: overridePolicy === "inherit" ? defaultPolicy === "show" : overridePolicy === "show",
  };
}

function safeSelection(pair: ChatAiSelectionPair, options: readonly AiSelectionOptionProvider[]) {
  const provider = options.find((candidate) => candidate.id === pair.providerId);
  if (!provider) throw new ChatAiSelectionError("provider_unavailable", "Provider is unavailable");
  const modelId = pair.modelId ?? provider.defaultModelId;
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new ChatAiSelectionError("model_unavailable", "Model is unavailable");
  return { providerLabel: provider.label, modelLabel: model.label };
}

export class ChatAiSelectionService {
  constructor(
    private readonly db: Database,
    private readonly encryptionKey: string,
    private readonly runtime: ChatAiSelectionRuntimeRegistry,
    private readonly withBotLock: <T>(botId: string, operation: () => Promise<T>) => Promise<T>,
    private readonly now = () => new Date(),
  ) {}

  private async readBot(
    botId: string,
    executor: Pick<Database, "select"> = this.db,
  ): Promise<ConfiguredBotRow> {
    const [bot] = await executor
      .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
      .from(bots)
      .where(eq(bots.id, botId));
    if (!bot) throw new ChatAiSelectionError("not_found", "Bot was not found");
    if (!bot.aiConfig) {
      throw new ChatAiSelectionError("ai_not_configured", "AI is not configured");
    }
    return bot as ConfiguredBotRow;
  }

  private options(bot: BotRow): AiSelectionOptionProvider[] {
    const options = listUsableAiSelectionOptions(bot.aiConfig, this.encryptionKey);
    if (options.length === 0) {
      throw new ChatAiSelectionError("ai_not_configured", "No usable AI Provider is configured");
    }
    return options;
  }

  async listOptions(botId: string) {
    return this.options(await this.readBot(botId));
  }

  async loadRuntimeSnapshot(botId: string): Promise<ChatAiSelectionRuntimeSnapshot> {
    const bot = await this.readBot(botId);
    const options = this.options(bot);
    const rows = await this.db
      .select()
      .from(chatAiSelections)
      .where(eq(chatAiSelections.botId, botId));
    const chats = new Map<number, Readonly<ChatAiSelectionPair>>();
    for (const row of rows) {
      try {
        chats.set(row.chatId, Object.freeze(validateAiSelectionPair(options, row)));
      } catch {
        // Invalid durable rows are fail-closed and reconciled by catalog mutation paths.
      }
    }
    return Object.freeze({
      revision: snapshotRevision(bot, rows),
      global: Object.freeze(globalPair(bot.aiConfig, options)),
      chats,
    });
  }

  async readGlobal(botId: string) {
    const bot = await this.readBot(botId);
    const options = this.options(bot);
    const pair = globalPair(bot.aiConfig, options);
    const snapshot = await this.loadRuntimeSnapshot(botId);
    return {
      revision: botRevision(bot),
      applyState:
        this.runtime.getAppliedRevision(botId) === snapshot.revision ? "applied" : "pending",
      displayDefault: migrateAiConfig(bot.aiConfig).aiSelectionDisplayDefault ?? "show",
      selection: { ...pair, ...safeSelection(pair, options) },
      options,
    } as const;
  }

  async readChat(botId: string, chatId: number, admin: boolean) {
    const [[chat], bot, [row]] = await Promise.all([
      this.db
        .select({ leftAt: telegramChats.leftAt })
        .from(telegramChats)
        .where(and(eq(telegramChats.botId, botId), eq(telegramChats.chatId, chatId))),
      this.readBot(botId),
      this.db
        .select()
        .from(chatAiSelections)
        .where(and(eq(chatAiSelections.botId, botId), eq(chatAiSelections.chatId, chatId))),
    ]);
    if (!chat) throw new ChatAiSelectionError("not_found", "Chat was not found");
    const options = this.options(bot);
    const global = globalPair(bot.aiConfig, options);
    const pair = validateAiSelectionPair(options, effectivePair(global, row));
    const policy = displayPolicy(bot.aiConfig, chatId);
    const snapshot = await this.loadRuntimeSnapshot(botId);
    const base = {
      revision: chatRevision(bot, row),
      source: row ? ("chat" as const) : ("global" as const),
      archived: chat.leftAt !== null,
      applyState:
        this.runtime.getAppliedRevision(botId) === snapshot.revision ? "applied" : "pending",
    };
    if (admin) {
      return {
        ...base,
        display: policy,
        selection: { ...pair, ...safeSelection(pair, options) },
        options,
      } as const;
    }
    return policy.visible ? { ...base, selection: safeSelection(pair, options) } : base;
  }

  private async publish(botId: string) {
    const result = await this.runtime.publish(botId, await this.loadRuntimeSnapshot(botId));
    return {
      persisted: true as const,
      applied: result.status === "applied",
      applyState: result.status,
    };
  }

  async setGlobal(input: {
    botId: string;
    expectedRevision: string;
    pair: ChatAiSelectionPair;
    displayDefault?: "show" | "hide";
    actor: AiSelectionActor;
  }) {
    return this.withBotLock(input.botId, async () => {
      await this.db.transaction(async (tx) => {
        const [bot] = await tx
          .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
          .from(bots)
          .where(eq(bots.id, input.botId))
          .for("update");
        if (!bot) throw new ChatAiSelectionError("not_found", "Bot was not found");
        if (!bot.aiConfig)
          throw new ChatAiSelectionError("ai_not_configured", "AI is not configured");
        if (botRevision(bot) !== input.expectedRevision) {
          throw new ChatAiSelectionError("stale_revision", "Stale AI selection revision");
        }
        const pair = validateAiSelectionPair(this.options(bot), input.pair);
        const migrated = migrateAiConfig(bot.aiConfig);
        const changedAt = nextUpdatedAt(this.now(), bot.updatedAt);
        const nextConfig: AiConfigStored = {
          ...migrated,
          activeProviderId: pair.providerId,
          activeModelId:
            pair.modelId ??
            this.options(bot).find((provider) => provider.id === pair.providerId)!.defaultModelId,
          ...(input.displayDefault ? { aiSelectionDisplayDefault: input.displayDefault } : {}),
        };
        await tx
          .update(bots)
          .set({ aiConfig: nextConfig, updatedAt: changedAt })
          .where(eq(bots.id, input.botId));
        await tx.insert(miniAppAuditEvents).values({
          botId: input.botId,
          actorTelegramUserId: input.actor.kind === "telegram_user" ? Number(input.actor.id) : null,
          actorRole: "admin",
          capability: "chat.ai-selection.write",
          action: "ai-selection.global.updated",
          resourceType: "bot",
          resourceId: input.botId,
          previousSummary: { revision: input.expectedRevision },
          nextSummary: { providerId: pair.providerId, modelId: pair.modelId },
          outcome: "succeeded",
          createdAt: changedAt,
        });
      });
      const published = await this.publish(input.botId);
      return { ...published, global: await this.readGlobal(input.botId) };
    });
  }

  async setChat(input: {
    botId: string;
    chatId: number;
    expectedRevision: string;
    pair: ChatAiSelectionPair;
    actor: AiSelectionActor;
  }) {
    return this.withBotLock(input.botId, async () => {
      await this.db.transaction(async (tx) => {
        const [bot] = await tx
          .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
          .from(bots)
          .where(eq(bots.id, input.botId))
          .for("update");
        const [chat] = await tx
          .select({ leftAt: telegramChats.leftAt })
          .from(telegramChats)
          .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.chatId)));
        const [row] = await tx
          .select()
          .from(chatAiSelections)
          .where(
            and(eq(chatAiSelections.botId, input.botId), eq(chatAiSelections.chatId, input.chatId)),
          )
          .for("update");
        if (!bot || !chat) throw new ChatAiSelectionError("not_found", "Chat was not found");
        if (chat.leftAt) throw new ChatAiSelectionError("archived", "Archived chats are read-only");
        if (!bot.aiConfig)
          throw new ChatAiSelectionError("ai_not_configured", "AI is not configured");
        if (chatRevision(bot, row) !== input.expectedRevision) {
          throw new ChatAiSelectionError("stale_revision", "Stale AI selection revision");
        }
        const pair = validateAiSelectionPair(this.options(bot), input.pair);
        const changedAt = this.now();
        await tx
          .insert(chatAiSelections)
          .values({
            botId: input.botId,
            chatId: input.chatId,
            ...pair,
            revision: row ? row.revision + 1 : 1,
            updatedByKind: input.actor.kind,
            updatedById: input.actor.id,
            updatedAt: changedAt,
          })
          .onConflictDoUpdate({
            target: [chatAiSelections.botId, chatAiSelections.chatId],
            set: {
              ...pair,
              revision: row ? row.revision + 1 : 1,
              updatedByKind: input.actor.kind,
              updatedById: input.actor.id,
              updatedAt: changedAt,
            },
          });
        await tx.insert(miniAppAuditEvents).values({
          botId: input.botId,
          actorTelegramUserId: input.actor.kind === "telegram_user" ? Number(input.actor.id) : null,
          actorRole: "admin",
          capability: "chat.ai-selection.write",
          action: "ai-selection.chat.updated",
          resourceType: "chat",
          resourceId: String(input.chatId),
          previousSummary: { revision: input.expectedRevision },
          nextSummary: { providerId: pair.providerId, modelId: pair.modelId },
          outcome: "succeeded",
          createdAt: changedAt,
        });
      });
      const published = await this.publish(input.botId);
      return { ...published, chat: await this.readChat(input.botId, input.chatId, true) };
    });
  }

  async resetChat(input: {
    botId: string;
    chatId: number;
    expectedRevision: string;
    actor: AiSelectionActor;
  }) {
    return this.withBotLock(input.botId, async () => {
      await this.db.transaction(async (tx) => {
        const [bot] = await tx
          .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
          .from(bots)
          .where(eq(bots.id, input.botId))
          .for("update");
        const [chat] = await tx
          .select({ leftAt: telegramChats.leftAt })
          .from(telegramChats)
          .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.chatId)));
        const [row] = await tx
          .select()
          .from(chatAiSelections)
          .where(
            and(eq(chatAiSelections.botId, input.botId), eq(chatAiSelections.chatId, input.chatId)),
          )
          .for("update");
        if (!bot || !chat) throw new ChatAiSelectionError("not_found", "Chat was not found");
        if (chat.leftAt) throw new ChatAiSelectionError("archived", "Archived chats are read-only");
        if (chatRevision(bot, row) !== input.expectedRevision) {
          throw new ChatAiSelectionError("stale_revision", "Stale AI selection revision");
        }
        await tx
          .delete(chatAiSelections)
          .where(
            and(eq(chatAiSelections.botId, input.botId), eq(chatAiSelections.chatId, input.chatId)),
          );
        await tx.insert(miniAppAuditEvents).values({
          botId: input.botId,
          actorTelegramUserId: input.actor.kind === "telegram_user" ? Number(input.actor.id) : null,
          actorRole: "admin",
          capability: "chat.ai-selection.write",
          action: "ai-selection.chat.reset",
          resourceType: "chat",
          resourceId: String(input.chatId),
          previousSummary: { revision: input.expectedRevision },
          nextSummary: { source: "global" },
          outcome: "succeeded",
          createdAt: this.now(),
        });
      });
      const published = await this.publish(input.botId);
      return { ...published, chat: await this.readChat(input.botId, input.chatId, true) };
    });
  }

  async setDisplayPolicy(input: {
    botId: string;
    chatId: number;
    expectedRevision: string;
    policy: AiSelectionDisplayPolicy;
    actor: AiSelectionActor;
  }) {
    return this.withBotLock(input.botId, async () => {
      await this.db.transaction(async (tx) => {
        const [bot] = await tx
          .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
          .from(bots)
          .where(eq(bots.id, input.botId))
          .for("update");
        const [chat] = await tx
          .select({ leftAt: telegramChats.leftAt })
          .from(telegramChats)
          .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.chatId)));
        const [row] = await tx
          .select({ revision: chatAiSelections.revision })
          .from(chatAiSelections)
          .where(
            and(eq(chatAiSelections.botId, input.botId), eq(chatAiSelections.chatId, input.chatId)),
          );
        if (!bot || !chat) throw new ChatAiSelectionError("not_found", "Chat was not found");
        if (chat.leftAt) throw new ChatAiSelectionError("archived", "Archived chats are read-only");
        if (!bot.aiConfig)
          throw new ChatAiSelectionError("ai_not_configured", "AI is not configured");
        if (chatRevision(bot, row) !== input.expectedRevision) {
          throw new ChatAiSelectionError("stale_revision", "Stale AI selection revision");
        }
        const migrated = migrateAiConfig(bot.aiConfig);
        const existing = migrated.groupOverrides[String(input.chatId)];
        const override: AiGroupOverride = {
          ...(existing ?? { chatId: input.chatId, whitelisted: false }),
          chatId: input.chatId,
          aiSelectionDisplay: input.policy,
        };
        const changedAt = nextUpdatedAt(this.now(), bot.updatedAt);
        await tx
          .update(bots)
          .set({
            aiConfig: {
              ...migrated,
              groupOverrides: { ...migrated.groupOverrides, [String(input.chatId)]: override },
            },
            updatedAt: changedAt,
          })
          .where(eq(bots.id, input.botId));
        await tx.insert(miniAppAuditEvents).values({
          botId: input.botId,
          actorTelegramUserId: input.actor.kind === "telegram_user" ? Number(input.actor.id) : null,
          actorRole: "admin",
          capability: "chat.ai-selection.write",
          action: "ai-selection.display.updated",
          resourceType: "chat",
          resourceId: String(input.chatId),
          previousSummary: { revision: input.expectedRevision },
          nextSummary: { policy: input.policy },
          outcome: "succeeded",
          createdAt: changedAt,
        });
      });
      const published = await this.publish(input.botId);
      return { ...published, chat: await this.readChat(input.botId, input.chatId, true) };
    });
  }

  async retryPublish(botId: string) {
    return this.withBotLock(botId, async () => this.publish(botId));
  }

  /**
   * Reconciles durable chat selections after the Provider catalog changes.
   * Missing Providers inherit global; missing models fall back to that Provider default.
   */
  async reconcileCatalog(botId: string) {
    return this.withBotLock(botId, async () => {
      const result = await this.db.transaction(async (tx) => {
        const [bot] = await tx
          .select({ aiConfig: bots.aiConfig, updatedAt: bots.updatedAt })
          .from(bots)
          .where(eq(bots.id, botId))
          .for("update");
        if (!bot) throw new ChatAiSelectionError("not_found", "Bot was not found");
        if (!bot.aiConfig)
          throw new ChatAiSelectionError("ai_not_configured", "AI is not configured");
        const options = this.options(bot);
        const rows = await tx
          .select()
          .from(chatAiSelections)
          .where(eq(chatAiSelections.botId, botId))
          .for("update");
        let reset = 0;
        let defaulted = 0;
        for (const row of rows) {
          const provider = options.find((candidate) => candidate.id === row.providerId);
          if (!provider) {
            await tx
              .delete(chatAiSelections)
              .where(
                and(eq(chatAiSelections.botId, botId), eq(chatAiSelections.chatId, row.chatId)),
              );
            reset += 1;
            continue;
          }
          if (row.modelId && !provider.models.some((model) => model.id === row.modelId)) {
            await tx
              .update(chatAiSelections)
              .set({
                modelId: null,
                revision: row.revision + 1,
                updatedByKind: null,
                updatedById: null,
                updatedAt: this.now(),
              })
              .where(
                and(eq(chatAiSelections.botId, botId), eq(chatAiSelections.chatId, row.chatId)),
              );
            defaulted += 1;
          }
        }
        if (reset || defaulted) {
          await tx.insert(miniAppAuditEvents).values({
            botId,
            actorTelegramUserId: null,
            actorRole: "system",
            capability: "chat.ai-selection.write",
            action: "ai-selection.catalog.reconciled",
            resourceType: "bot",
            resourceId: botId,
            previousSummary: { examined: rows.length },
            nextSummary: { reset, defaulted },
            outcome: "succeeded",
            createdAt: this.now(),
          });
        }
        return { reset, defaulted };
      });
      const published = await this.publish(botId);
      return { ...published, ...result };
    });
  }
}
