import type { AiConfigStored, AiGroupOverride } from "@cos-tool-bot/shared";
import type { Database } from "@cos-tool-bot/database";
import {
  bots,
  chatAiSelections,
  chatModelOverrides,
  chatProviderOverrides,
  miniAppAuditEvents,
  miniAppChatGrants,
  rssCollections,
  summaryConfigs,
  telegramChats,
  timers,
} from "@cos-tool-bot/database";
import { and, eq, inArray, sql } from "drizzle-orm";

const MIN_TELEGRAM_CHAT_ID = -9_007_199_254_740_991;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Content/history tables deliberately remain keyed to the original Telegram chat. */
export const CHAT_IDENTITY_MIGRATION_EXCLUDED_RESOURCES = Object.freeze([
  "conversation_messages",
  "conversation_summaries",
  "conversation_compaction_state",
  "chat_summaries",
  "pixai_generations",
] as const);

export type ChatMigrationSingletonAction = "none" | "move" | "drop-old";

export type ChatMigrationResourceKind =
  | "chat_lineage"
  | "chat_grant"
  | "group_override"
  | "summary_config"
  | "ai_selection"
  | "model_override"
  | "provider_override"
  | "rss_collection"
  | "timer";

export interface ChatIdentityMigrationInput {
  botId: string;
  oldChatId: number;
  newChatId: number;
  /** Telegram update timestamp, in seconds since Unix epoch. */
  observedAt: number;
}

export interface ChatIdentityMigrationSnapshot {
  lineageApplied: boolean;
  oldChatGrant: boolean;
  newChatGrant: boolean;
  oldSummaryConfig: boolean;
  newSummaryConfig: boolean;
  oldAiSelection: boolean;
  newAiSelection: boolean;
  oldModelOverride: boolean;
  newModelOverride: boolean;
  oldProviderOverride: boolean;
  newProviderOverride: boolean;
  groupOverrides: Readonly<Record<string, AiGroupOverride>>;
  rssCollectionIds: readonly number[];
  timerIds: readonly string[];
}

export interface ChatIdentityMigrationPlan {
  lineage: boolean;
  chatGrant: ChatMigrationSingletonAction;
  groupOverride: ChatMigrationSingletonAction;
  summaryConfig: ChatMigrationSingletonAction;
  aiSelection: ChatMigrationSingletonAction;
  modelOverride: ChatMigrationSingletonAction;
  providerOverride: ChatMigrationSingletonAction;
  nextGroupOverrides: Record<string, AiGroupOverride> | null;
  rssCollectionIds: readonly number[];
  timerIds: readonly string[];
  moved: Partial<Record<ChatMigrationResourceKind, number>>;
  conflicts: Partial<Record<ChatMigrationResourceKind, number>>;
  resourceKinds: readonly ChatMigrationResourceKind[];
  changed: boolean;
}

export interface ChatIdentityMigrationResult {
  changed: boolean;
  moved: Partial<Record<ChatMigrationResourceKind, number>>;
  conflicts: Partial<Record<ChatMigrationResourceKind, number>>;
  resourceKinds: readonly ChatMigrationResourceKind[];
}

export type ChatIdentityMigrationErrorCode =
  | "INVALID_BOT_ID"
  | "INVALID_CHAT_ID"
  | "INVALID_OBSERVED_AT"
  | "BOT_NOT_FOUND"
  | "CHAT_ALREADY_MIGRATED";

export class ChatIdentityMigrationError extends Error {
  constructor(readonly code: ChatIdentityMigrationErrorCode) {
    super(code);
    this.name = "ChatIdentityMigrationError";
  }
}

interface LockedBot {
  aiConfig: AiConfigStored | null;
}

interface ChatLineage {
  migratedToChatId: number | null;
  leftAt: Date | null;
}

export interface ChatIdentityMigrationTransaction {
  lockBot(botId: string): Promise<LockedBot | null>;
  ensureChat(input: {
    botId: string;
    chatId: number;
    type: "group" | "supergroup";
    observedAt: Date;
  }): Promise<void>;
  getChatLineage(botId: string, chatId: number): Promise<ChatLineage | null>;
  readSnapshot(
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId">,
    groupOverrides: Readonly<Record<string, AiGroupOverride>>,
  ): Promise<ChatIdentityMigrationSnapshot>;
  applySingleton(
    kind: "chat_grant" | "summary_config" | "ai_selection" | "model_override" | "provider_override",
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId">,
    action: Exclude<ChatMigrationSingletonAction, "none">,
  ): Promise<void>;
  updateGroupOverrides(
    botId: string,
    aiConfig: AiConfigStored,
    overrides: Record<string, AiGroupOverride>,
  ): Promise<void>;
  moveRssCollections(
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId"> & {
      ids: readonly number[];
    },
  ): Promise<void>;
  moveTimers(
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId"> & {
      ids: readonly string[];
    },
  ): Promise<void>;
  markLineage(input: {
    botId: string;
    oldChatId: number;
    newChatId: number;
    observedAt: Date;
  }): Promise<void>;
  writeAudit(input: {
    botId: string;
    oldChatId: number;
    newChatId: number;
    moved: Partial<Record<ChatMigrationResourceKind, number>>;
    conflicts: Partial<Record<ChatMigrationResourceKind, number>>;
    resourceKinds: readonly ChatMigrationResourceKind[];
    rssCollectionIds: readonly number[];
    timerIds: readonly string[];
  }): Promise<void>;
}

export interface ChatIdentityMigrationRepository {
  transaction<T>(operation: (tx: ChatIdentityMigrationTransaction) => Promise<T>): Promise<T>;
}

function singletonAction(oldExists: boolean, targetExists: boolean): ChatMigrationSingletonAction {
  if (!oldExists) return "none";
  return targetExists ? "drop-old" : "move";
}

function increment(
  counts: Partial<Record<ChatMigrationResourceKind, number>>,
  kind: ChatMigrationResourceKind,
  count = 1,
): void {
  if (count > 0) counts[kind] = (counts[kind] ?? 0) + count;
}

export function buildChatIdentityMigrationPlan(
  oldChatId: number,
  newChatId: number,
  snapshot: ChatIdentityMigrationSnapshot,
): ChatIdentityMigrationPlan {
  const chatGrant = singletonAction(snapshot.oldChatGrant, snapshot.newChatGrant);
  const summaryConfig = singletonAction(snapshot.oldSummaryConfig, snapshot.newSummaryConfig);
  const aiSelection = singletonAction(snapshot.oldAiSelection, snapshot.newAiSelection);
  const modelOverride = singletonAction(snapshot.oldModelOverride, snapshot.newModelOverride);
  const providerOverride = singletonAction(
    snapshot.oldProviderOverride,
    snapshot.newProviderOverride,
  );

  const oldKey = String(oldChatId);
  const newKey = String(newChatId);
  const oldGroupOverride = snapshot.groupOverrides[oldKey];
  const targetGroupOverride = snapshot.groupOverrides[newKey];
  const groupOverride = singletonAction(
    oldGroupOverride !== undefined,
    targetGroupOverride !== undefined,
  );
  let nextGroupOverrides: Record<string, AiGroupOverride> | null = null;
  if (groupOverride !== "none") {
    nextGroupOverrides = { ...snapshot.groupOverrides };
    delete nextGroupOverrides[oldKey];
    if (groupOverride === "move") {
      nextGroupOverrides[newKey] = { ...oldGroupOverride!, chatId: newChatId };
    }
  }

  const moved: Partial<Record<ChatMigrationResourceKind, number>> = {};
  const conflicts: Partial<Record<ChatMigrationResourceKind, number>> = {};
  if (!snapshot.lineageApplied) increment(moved, "chat_lineage");
  for (const [kind, action] of [
    ["chat_grant", chatGrant],
    ["group_override", groupOverride],
    ["summary_config", summaryConfig],
    ["ai_selection", aiSelection],
    ["model_override", modelOverride],
    ["provider_override", providerOverride],
  ] as const) {
    if (action === "move") increment(moved, kind);
    if (action === "drop-old") increment(conflicts, kind);
  }
  increment(moved, "rss_collection", snapshot.rssCollectionIds.length);
  increment(moved, "timer", snapshot.timerIds.length);

  const resourceKinds = [
    ...new Set([...Object.keys(moved), ...Object.keys(conflicts)]),
  ].sort() as ChatMigrationResourceKind[];
  return {
    lineage: !snapshot.lineageApplied,
    chatGrant,
    groupOverride,
    summaryConfig,
    aiSelection,
    modelOverride,
    providerOverride,
    nextGroupOverrides,
    rssCollectionIds: snapshot.rssCollectionIds,
    timerIds: snapshot.timerIds,
    moved,
    conflicts,
    resourceKinds,
    changed: resourceKinds.length > 0,
  };
}

function assertInput(input: ChatIdentityMigrationInput): void {
  if (!UUID_PATTERN.test(input.botId)) throw new ChatIdentityMigrationError("INVALID_BOT_ID");
  const validChatId = (value: number) =>
    Number.isSafeInteger(value) && value < 0 && value >= MIN_TELEGRAM_CHAT_ID;
  if (
    !validChatId(input.oldChatId) ||
    !validChatId(input.newChatId) ||
    input.oldChatId === input.newChatId
  ) {
    throw new ChatIdentityMigrationError("INVALID_CHAT_ID");
  }
  if (
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt <= 0 ||
    !Number.isFinite(new Date(input.observedAt * 1000).getTime())
  ) {
    throw new ChatIdentityMigrationError("INVALID_OBSERVED_AT");
  }
}

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

class DrizzleChatIdentityMigrationTransaction implements ChatIdentityMigrationTransaction {
  constructor(private readonly tx: DatabaseTransaction) {}

  async lockBot(botId: string): Promise<LockedBot | null> {
    const [bot] = await this.tx
      .select({ aiConfig: bots.aiConfig })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1)
      .for("update");
    return bot ?? null;
  }

  async ensureChat(input: {
    botId: string;
    chatId: number;
    type: "group" | "supergroup";
    observedAt: Date;
  }): Promise<void> {
    await this.tx
      .insert(telegramChats)
      .values({
        botId: input.botId,
        chatId: input.chatId,
        type: input.type,
        lastObservedAt: input.observedAt,
      })
      .onConflictDoNothing({ target: [telegramChats.botId, telegramChats.chatId] });
  }

  async getChatLineage(botId: string, chatId: number): Promise<ChatLineage | null> {
    const [chat] = await this.tx
      .select({
        migratedToChatId: telegramChats.migratedToChatId,
        leftAt: telegramChats.leftAt,
      })
      .from(telegramChats)
      .where(and(eq(telegramChats.botId, botId), eq(telegramChats.chatId, chatId)))
      .limit(1)
      .for("update");
    return chat ?? null;
  }

  async readSnapshot(
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId">,
    groupOverrides: Readonly<Record<string, AiGroupOverride>>,
  ): Promise<ChatIdentityMigrationSnapshot> {
    const chatIds = [input.oldChatId, input.newChatId];
    const grantRows = await this.tx
      .select({ chatId: miniAppChatGrants.chatId })
      .from(miniAppChatGrants)
      .where(
        and(eq(miniAppChatGrants.botId, input.botId), inArray(miniAppChatGrants.chatId, chatIds)),
      );
    const summaryRows = await this.tx
      .select({ chatId: summaryConfigs.chatId })
      .from(summaryConfigs)
      .where(and(eq(summaryConfigs.botId, input.botId), inArray(summaryConfigs.chatId, chatIds)));
    const selectionRows = await this.tx
      .select({ chatId: chatAiSelections.chatId })
      .from(chatAiSelections)
      .where(
        and(eq(chatAiSelections.botId, input.botId), inArray(chatAiSelections.chatId, chatIds)),
      );
    const modelRows = await this.tx
      .select({ chatId: chatModelOverrides.chatId })
      .from(chatModelOverrides)
      .where(
        and(eq(chatModelOverrides.botId, input.botId), inArray(chatModelOverrides.chatId, chatIds)),
      );
    const providerRows = await this.tx
      .select({ chatId: chatProviderOverrides.chatId })
      .from(chatProviderOverrides)
      .where(
        and(
          eq(chatProviderOverrides.botId, input.botId),
          inArray(chatProviderOverrides.chatId, chatIds),
        ),
      );
    const rssRows = await this.tx
      .select({ id: rssCollections.id })
      .from(rssCollections)
      .where(
        and(eq(rssCollections.botId, input.botId), eq(rssCollections.chatId, input.oldChatId)),
      );
    const timerRows = await this.tx
      .select({ id: timers.id })
      .from(timers)
      .where(and(eq(timers.botId, input.botId), eq(timers.chatId, input.oldChatId)));
    const hasChat = (rows: readonly { chatId: number }[], chatId: number) =>
      rows.some((row) => row.chatId === chatId);

    return {
      lineageApplied: false,
      oldChatGrant: hasChat(grantRows, input.oldChatId),
      newChatGrant: hasChat(grantRows, input.newChatId),
      oldSummaryConfig: hasChat(summaryRows, input.oldChatId),
      newSummaryConfig: hasChat(summaryRows, input.newChatId),
      oldAiSelection: hasChat(selectionRows, input.oldChatId),
      newAiSelection: hasChat(selectionRows, input.newChatId),
      oldModelOverride: hasChat(modelRows, input.oldChatId),
      newModelOverride: hasChat(modelRows, input.newChatId),
      oldProviderOverride: hasChat(providerRows, input.oldChatId),
      newProviderOverride: hasChat(providerRows, input.newChatId),
      groupOverrides,
      rssCollectionIds: rssRows.map((row) => row.id),
      timerIds: timerRows.map((row) => row.id),
    };
  }

  async applySingleton(
    kind: "chat_grant" | "summary_config" | "ai_selection" | "model_override" | "provider_override",
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId">,
    action: Exclude<ChatMigrationSingletonAction, "none">,
  ): Promise<void> {
    if (kind === "ai_selection") {
      const condition = and(
        eq(chatAiSelections.botId, input.botId),
        eq(chatAiSelections.chatId, input.oldChatId),
      );
      if (action === "move") {
        await this.tx
          .update(chatAiSelections)
          .set({
            chatId: input.newChatId,
            revision: sql`${chatAiSelections.revision} + 1`,
            updatedByKind: null,
            updatedById: null,
            updatedAt: sql`now()`,
          })
          .where(condition);
      } else {
        await this.tx.delete(chatAiSelections).where(condition);
      }
      return;
    }

    const table = {
      chat_grant: miniAppChatGrants,
      summary_config: summaryConfigs,
      model_override: chatModelOverrides,
      provider_override: chatProviderOverrides,
    }[kind];
    const condition = and(eq(table.botId, input.botId), eq(table.chatId, input.oldChatId));
    if (action === "move") {
      await this.tx.update(table).set({ chatId: input.newChatId }).where(condition);
    } else {
      await this.tx.delete(table).where(condition);
    }
  }

  async updateGroupOverrides(
    botId: string,
    aiConfig: AiConfigStored,
    overrides: Record<string, AiGroupOverride>,
  ): Promise<void> {
    await this.tx
      .update(bots)
      .set({ aiConfig: { ...aiConfig, groupOverrides: overrides } })
      .where(eq(bots.id, botId));
  }

  async moveRssCollections(
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId"> & {
      ids: readonly number[];
    },
  ): Promise<void> {
    await this.tx
      .update(rssCollections)
      .set({ chatId: input.newChatId })
      .where(
        and(
          eq(rssCollections.botId, input.botId),
          eq(rssCollections.chatId, input.oldChatId),
          inArray(rssCollections.id, input.ids),
        ),
      );
  }

  async moveTimers(
    input: Pick<ChatIdentityMigrationInput, "botId" | "oldChatId" | "newChatId"> & {
      ids: readonly string[];
    },
  ): Promise<void> {
    await this.tx
      .update(timers)
      .set({ chatId: input.newChatId })
      .where(
        and(
          eq(timers.botId, input.botId),
          eq(timers.chatId, input.oldChatId),
          inArray(timers.id, input.ids),
        ),
      );
  }

  async markLineage(input: {
    botId: string;
    oldChatId: number;
    newChatId: number;
    observedAt: Date;
  }): Promise<void> {
    await this.tx
      .update(telegramChats)
      .set({ migratedToChatId: input.newChatId, leftAt: input.observedAt })
      .where(and(eq(telegramChats.botId, input.botId), eq(telegramChats.chatId, input.oldChatId)));
  }

  async writeAudit(input: {
    botId: string;
    oldChatId: number;
    newChatId: number;
    moved: Partial<Record<ChatMigrationResourceKind, number>>;
    conflicts: Partial<Record<ChatMigrationResourceKind, number>>;
    resourceKinds: readonly ChatMigrationResourceKind[];
    rssCollectionIds: readonly number[];
    timerIds: readonly string[];
  }): Promise<void> {
    await this.tx.insert(miniAppAuditEvents).values({
      botId: input.botId,
      actorTelegramUserId: null,
      actorRole: "system",
      capability: "group.config.write",
      action: "telegram.chat_identity.migrate",
      resourceType: "telegram_chat",
      resourceId: `${input.oldChatId}->${input.newChatId}`,
      previousSummary: { ids: { oldChatId: input.oldChatId } },
      nextSummary: {
        ids: {
          newChatId: input.newChatId,
          rssCollectionIds: input.rssCollectionIds,
          timerIds: input.timerIds,
        },
        resourceKinds: input.resourceKinds,
        moved: input.moved,
        conflicts: input.conflicts,
      },
      outcome: "succeeded",
    });
  }
}

class DrizzleChatIdentityMigrationRepository implements ChatIdentityMigrationRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(operation: (tx: ChatIdentityMigrationTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => operation(new DrizzleChatIdentityMigrationTransaction(tx)));
  }
}

function isRepository(
  source: Database | ChatIdentityMigrationRepository,
): source is ChatIdentityMigrationRepository {
  return !("select" in source);
}

export class ChatIdentityMigrationService {
  private readonly repository: ChatIdentityMigrationRepository;

  constructor(source: Database | ChatIdentityMigrationRepository) {
    this.repository = isRepository(source)
      ? source
      : new DrizzleChatIdentityMigrationRepository(source);
  }

  async migrate(input: ChatIdentityMigrationInput): Promise<ChatIdentityMigrationResult> {
    assertInput(input);
    const observedAt = new Date(input.observedAt * 1000);
    const scope = {
      botId: input.botId,
      oldChatId: input.oldChatId,
      newChatId: input.newChatId,
    };

    return this.repository.transaction(async (tx) => {
      // Locking the Bot row serializes duplicate or competing migration updates
      // before any catalog/resource mutation is attempted.
      const bot = await tx.lockBot(input.botId);
      if (!bot) throw new ChatIdentityMigrationError("BOT_NOT_FOUND");

      // The target must exist before grants with a composite catalog FK move.
      await tx.ensureChat({
        botId: input.botId,
        chatId: input.newChatId,
        type: "supergroup",
        observedAt,
      });
      // A migration update can be the first update observed for the old group.
      await tx.ensureChat({
        botId: input.botId,
        chatId: input.oldChatId,
        type: "group",
        observedAt,
      });

      const lineage = await tx.getChatLineage(input.botId, input.oldChatId);
      if (lineage?.migratedToChatId != null && lineage.migratedToChatId !== input.newChatId) {
        throw new ChatIdentityMigrationError("CHAT_ALREADY_MIGRATED");
      }

      const snapshot = await tx.readSnapshot(scope, bot.aiConfig?.groupOverrides ?? {});
      snapshot.lineageApplied =
        lineage?.migratedToChatId === input.newChatId && lineage.leftAt !== null;
      const plan = buildChatIdentityMigrationPlan(input.oldChatId, input.newChatId, snapshot);
      if (!plan.changed) {
        return {
          changed: false,
          moved: {},
          conflicts: {},
          resourceKinds: [],
        };
      }

      for (const [kind, action] of [
        ["chat_grant", plan.chatGrant],
        ["summary_config", plan.summaryConfig],
        ["ai_selection", plan.aiSelection],
        ["model_override", plan.modelOverride],
        ["provider_override", plan.providerOverride],
      ] as const) {
        if (action !== "none") await tx.applySingleton(kind, scope, action);
      }
      if (plan.nextGroupOverrides && bot.aiConfig) {
        await tx.updateGroupOverrides(input.botId, bot.aiConfig, plan.nextGroupOverrides);
      }
      if (plan.rssCollectionIds.length > 0) {
        await tx.moveRssCollections({ ...scope, ids: plan.rssCollectionIds });
      }
      if (plan.timerIds.length > 0) {
        await tx.moveTimers({ ...scope, ids: plan.timerIds });
      }
      if (plan.lineage) await tx.markLineage({ ...scope, observedAt });

      // This is intentionally last: a successful audit cannot outlive a failed
      // resource mutation, and rollback removes both resources and audit.
      await tx.writeAudit({
        ...scope,
        moved: plan.moved,
        conflicts: plan.conflicts,
        resourceKinds: plan.resourceKinds,
        rssCollectionIds: plan.rssCollectionIds,
        timerIds: plan.timerIds,
      });
      return {
        changed: true,
        moved: plan.moved,
        conflicts: plan.conflicts,
        resourceKinds: plan.resourceKinds,
      };
    });
  }
}
