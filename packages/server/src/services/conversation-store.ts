import type { Database } from "@cos-tool-bot/database";
import {
  conversationCompactionState,
  conversationMessages,
  conversationSummaries,
} from "@cos-tool-bot/database";
import {
  formatConversationForwardOrigin,
  formatConversationRelayOrigin,
  parseConversationRelayOrigin,
  type ConversationRelayOrigin,
  parseConversationForwardOrigin,
  type ConversationForwardOrigin,
  type ConversationHistoryBudgetTrace,
  type ConversationRole,
} from "@cos-tool-bot/shared";
import { countTokens } from "gpt-tokenizer";
import {
  and,
  asc,
  cosineDistance,
  count,
  desc,
  eq,
  gte,
  gt,
  ilike,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { escapeLike, rrfMerge } from "../utils/search.js";

class CompactionConflictError extends Error {}

type ConversationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const CONVERSATION_SUMMARY_RECENT_VERSIONS = 3;
export const CONVERSATION_SUMMARY_CLEANUP_BATCH_MAX = 100;

export function retainedConversationSummaryIds(
  recentIds: readonly number[],
  activeSummaryId: number | null,
): number[] {
  const ids = recentIds
    .filter((id) => id !== activeSummaryId)
    .slice(0, CONVERSATION_SUMMARY_RECENT_VERSIONS);
  if (activeSummaryId !== null) ids.push(activeSummaryId);
  return ids;
}

export const COMPACTION_MAX_BATCH_MESSAGES = 200;
export const COMPACTION_MAX_BATCH_JSON_CHARS = 120_000;
const COMPACTION_MAX_SOURCE_MESSAGE_CHARS = 20_000;
const JSON_ESCAPE_EXPANSION_FACTOR = 6;
const TRUNCATION_MARKER = "\n…[truncated for compaction]…\n";
const HISTORY_TOOL_TRACE_MAX_CHARS = 2_000;
const HISTORY_TOOL_TRUNCATION_MARKER = "…[truncated]";
const HISTORY_PRUNE_BATCH_SIZE = 10_000;
const HISTORY_MESSAGE_TOKEN_OVERHEAD = 6;
const HISTORY_PROMPT_SCAN_BATCH_SIZE = 200;
const DISPLAY_ONLY_HISTORY_TOOLS = new Set([
  "multi_message",
  "react_to_message",
  "send_dice",
  "send_sticker",
]);

interface ConversationMessageInput {
  botId: string;
  chatId: number;
  role: ConversationRole;
  content: string;
  userAuthoredContent?: string | null;
  userId?: number;
  userName?: string;
  sourceKey?: string;
  meta?: Record<string, unknown>;
}

export interface CompactionCandidate {
  activeSummaryId: number | null;
  oldCursorId: number;
  existingSummary: string | null;
  messages: Array<{
    id: number;
    role: string;
    content: string;
    userName: string | null;
    forwardOrigin?: ConversationForwardOrigin;
    relayOrigin?: ConversationRelayOrigin;
  }>;
  sourceMessageIds: number[];
  newCursorId: number;
}

export interface HistoryLimitResult {
  countBefore: number;
  countAfter: number;
  limit: number;
  warningThreshold: number;
  prunedCount: number;
  warning: boolean;
}

export function conversationMessageOrderId() {
  return sql<number>`case
    when ${conversationMessages.meta}->>'turnOrderId' ~ '^[1-9][0-9]*$'
      then (${conversationMessages.meta}->>'turnOrderId')::integer
    else ${conversationMessages.id}
  end`;
}

function orderConversationMessagesByTurn<T extends { id: number; historyOrderId?: number }>(
  messages: readonly T[],
): T[] {
  return [...messages].sort(
    (left, right) =>
      (left.historyOrderId ?? left.id) - (right.historyOrderId ?? right.id) || left.id - right.id,
  );
}

function storedMessageOrderId(
  id: number,
  meta: Record<string, unknown> | null | undefined,
): number {
  const value = meta?.["turnOrderId"];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : id;
}

function truncateCompactionContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  if (maxChars <= TRUNCATION_MARKER.length) return content.slice(0, maxChars);
  const available = maxChars - TRUNCATION_MARKER.length;
  const headLength = Math.ceil(available / 2);
  return `${content.slice(0, headLength)}${TRUNCATION_MARKER}${content.slice(-Math.floor(available / 2))}`;
}

function compactHistoryToolValue(value: string): string {
  if (value.length <= HISTORY_TOOL_TRACE_MAX_CHARS) return value;
  return `${value.slice(0, HISTORY_TOOL_TRACE_MAX_CHARS - HISTORY_TOOL_TRUNCATION_MARKER.length)}${HISTORY_TOOL_TRUNCATION_MARKER}`;
}

function normalizeConversationMessage(
  message: ConversationMessageInput,
): ConversationMessageInput | null {
  if (
    (message.role === "user" || message.role === "assistant" || message.role === "context") &&
    message.content.trim().length === 0
  ) {
    return null;
  }

  if (message.role !== "tool_call" && message.role !== "tool_result") return message;

  const toolName =
    typeof message.meta?.["toolName"] === "string"
      ? message.meta["toolName"]
      : message.role === "tool_call"
        ? message.content
        : undefined;
  if (toolName && DISPLAY_ONLY_HISTORY_TOOLS.has(toolName)) return null;

  const meta = message.meta ? { ...message.meta } : undefined;
  if (typeof meta?.["args"] === "string") {
    meta["args"] = compactHistoryToolValue(meta["args"]);
  }
  return {
    ...message,
    content: compactHistoryToolValue(message.content),
    meta,
  };
}

export function buildConversationHistoryBoundary(
  beforeId: number | undefined,
  beforeTelegramMessageId: number | undefined,
) {
  if (beforeTelegramMessageId === undefined) {
    return beforeId === undefined ? undefined : lt(conversationMessages.id, beforeId);
  }

  const fallback =
    beforeId === undefined ? sql<boolean>`true` : lt(conversationMessages.id, beforeId);
  return sql<boolean>`case
    when ${conversationMessages.sourceKey} ~ '^telegram:[0-9]+:'
      then split_part(${conversationMessages.sourceKey}, ':', 2)::bigint < ${beforeTelegramMessageId}
    else ${fallback}
  end`;
}

function estimateHistoryMessageTokens(message: {
  role: string;
  content: string;
  userName: string | null;
  forwardOrigin?: ConversationForwardOrigin;
  relayOrigin?: ConversationRelayOrigin;
}): number {
  const attribution = [
    formatConversationForwardOrigin(message.forwardOrigin),
    formatConversationRelayOrigin(message.relayOrigin),
  ]
    .filter(Boolean)
    .join("\n");
  const content = attribution ? `${attribution}\n${message.content}` : message.content;
  return (
    countTokens(`${message.role === "assistant" ? "AI" : message.userName || "User"}: ${content}`) +
    HISTORY_MESSAGE_TOKEN_OVERHEAD
  );
}

function projectForwardOrigin(meta: Record<string, unknown> | null | undefined): {
  forwardOrigin?: ConversationForwardOrigin;
} {
  const forwardOrigin = parseConversationForwardOrigin(meta?.["forwardOrigin"]);
  return forwardOrigin ? { forwardOrigin } : {};
}

function projectRelayOrigin(meta: Record<string, unknown> | null | undefined): {
  relayOrigin?: ConversationRelayOrigin;
} {
  const relayOrigin = parseConversationRelayOrigin(meta);
  return relayOrigin ? { relayOrigin } : {};
}

function projectTgMessageId(meta: Record<string, unknown> | null | undefined): {
  tgMessageId?: number;
} {
  const tgMessageId = meta?.["tgMessageId"];
  return typeof tgMessageId === "number" && Number.isInteger(tgMessageId) ? { tgMessageId } : {};
}

function truncateToTokenBudget(content: string, budget: number): string {
  if (budget <= 0) return "";
  if (countTokens(content) <= budget) return content;

  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(content.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return content.slice(0, low);
}

export function selectHistoryWithinTokenBudget(
  rows: Array<{
    id: number;
    role: string;
    content: string;
    userName: string | null;
    createdAt: Date;
    historyOrderId?: number;
    forwardOrigin?: ConversationForwardOrigin;
    relayOrigin?: ConversationRelayOrigin;
    tgMessageId?: number;
  }>,
  active:
    | {
        cursorId: number;
        content: string;
        rawHistoryIntact?: boolean;
      }
    | undefined,
  configuredTokens: number,
  scanState: {
    scannedAllHistory: boolean;
    scannedThroughActiveCursor: boolean;
  } = {
    scannedAllHistory: true,
    scannedThroughActiveCursor: true,
  },
) {
  const completeTokens = rows.reduce(
    (total, message) => total + estimateHistoryMessageTokens(message),
    0,
  );
  if (
    completeTokens <= configuredTokens &&
    scanState.scannedAllHistory &&
    (active?.rawHistoryIntact ?? true)
  ) {
    const trace: ConversationHistoryBudgetTrace = {
      configuredTokens,
      usedTokens: completeTokens,
      completeRawHistory: true,
      usedSummary: false,
      rawMessageCount: rows.length,
      earliestMessageId: rows[0]?.id ?? null,
      latestMessageId: rows.at(-1)?.id ?? null,
      degraded: false,
    };
    return { summary: null, messages: rows, trace };
  }

  const summaryLimit = Math.floor(configuredTokens / 3);
  const summary = active?.content ? truncateToTokenBudget(active.content, summaryLimit) : null;
  const summaryTokens = summary ? countTokens(summary) : 0;
  const tailBudget = Math.max(0, configuredTokens - summaryTokens);
  const tailCandidates = active
    ? rows.filter((message) => (message.historyOrderId ?? message.id) > active.cursorId)
    : rows;
  const reversed: typeof rows = [];
  let tailTokens = 0;
  for (let index = tailCandidates.length - 1; index >= 0; index--) {
    const message = tailCandidates[index]!;
    const messageTokens = estimateHistoryMessageTokens(message);
    if (reversed.length > 0 && tailTokens + messageTokens > tailBudget) break;
    if (messageTokens > tailBudget) {
      const attribution = [
        formatConversationForwardOrigin(message.forwardOrigin),
        formatConversationRelayOrigin(message.relayOrigin),
      ]
        .filter(Boolean)
        .join("\n");
      const attributionTokens = attribution ? countTokens(`${attribution}\n`) : 0;
      const contentBudget = Math.max(
        1,
        tailBudget - HISTORY_MESSAGE_TOKEN_OVERHEAD - attributionTokens,
      );
      reversed.push({
        ...message,
        content: truncateToTokenBudget(message.content, contentBudget),
      });
      tailTokens = tailBudget;
      break;
    }
    reversed.push(message);
    tailTokens += messageTokens;
  }
  const messages = reversed.reverse();
  const hasRecoverableGap = active
    ? !scanState.scannedThroughActiveCursor || messages.length < tailCandidates.length
    : true;
  const hasPrunedGap = active?.rawHistoryIntact === false;
  const trace: ConversationHistoryBudgetTrace = {
    configuredTokens,
    usedTokens: summaryTokens + tailTokens,
    completeRawHistory: false,
    usedSummary: !!summary,
    rawMessageCount: messages.length,
    earliestMessageId: messages[0]?.id ?? null,
    latestMessageId: messages.at(-1)?.id ?? null,
    degraded: !summary || hasRecoverableGap || hasPrunedGap,
    compressionRecommended: !summary || hasRecoverableGap,
  };
  return { summary, messages, trace };
}

export class ConversationStore {
  constructor(private db: Database) {}

  private summaryScope(botId: string, chatId: number) {
    return and(eq(conversationSummaries.botId, botId), eq(conversationSummaries.chatId, chatId));
  }

  private async retainedSummaryIds(
    db: Pick<Database, "select">,
    botId: string,
    chatId: number,
    activeSummaryId: number | null,
  ): Promise<number[]> {
    const recent = await db
      .select({ id: conversationSummaries.id })
      .from(conversationSummaries)
      .where(this.summaryScope(botId, chatId))
      .orderBy(desc(conversationSummaries.id))
      .limit(CONVERSATION_SUMMARY_RECENT_VERSIONS + 1);
    return retainedConversationSummaryIds(
      recent.map((row) => row.id),
      activeSummaryId,
    );
  }

  private async pruneSummaryVersions(
    tx: ConversationTransaction,
    botId: string,
    chatId: number,
    activeSummaryId: number | null,
    batchSize: number,
  ): Promise<number> {
    const retainedIds = await this.retainedSummaryIds(tx, botId, chatId, activeSummaryId);
    const candidates = await tx
      .select({ id: conversationSummaries.id })
      .from(conversationSummaries)
      .where(
        and(
          this.summaryScope(botId, chatId),
          retainedIds.length ? notInArray(conversationSummaries.id, retainedIds) : undefined,
        ),
      )
      .orderBy(asc(conversationSummaries.id))
      .limit(batchSize);
    if (candidates.length === 0) return 0;
    const deleted = await tx
      .delete(conversationSummaries)
      .where(
        and(
          this.summaryScope(botId, chatId),
          inArray(
            conversationSummaries.id,
            candidates.map((row) => row.id),
          ),
          activeSummaryId === null ? undefined : ne(conversationSummaries.id, activeSummaryId),
        ),
      )
      .returning({ id: conversationSummaries.id });
    return deleted.length;
  }

  async findOwnMessage(botId: string, chatId: number, messageId: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          eq(conversationMessages.role, "assistant"),
          sql`${conversationMessages.meta}->>'tgMessageId' = ${String(messageId)}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async updateOwnMessage(
    botId: string,
    chatId: number,
    messageId: number,
    content: string,
  ): Promise<void> {
    const rows = await this.db
      .update(conversationMessages)
      .set({ content, embedding: null })
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          eq(conversationMessages.role, "assistant"),
          sql`${conversationMessages.meta}->>'tgMessageId' = ${String(messageId)}`,
        ),
      )
      .returning({ id: conversationMessages.id });
    if (!rows.length) throw new Error("Editable message history no longer exists");
  }

  async addMessage(params: ConversationMessageInput) {
    await this.addMessages([params]);
  }

  async addMessages(messages: ConversationMessageInput[]) {
    const normalized = messages
      .map(normalizeConversationMessage)
      .filter((message): message is ConversationMessageInput => message !== null);
    if (normalized.length === 0) return [];
    const rows = await this.db
      .insert(conversationMessages)
      .values(
        normalized.map((m) => ({
          botId: m.botId,
          chatId: m.chatId,
          role: m.role,
          content: m.content,
          userAuthoredContent: m.userAuthoredContent ?? null,
          userId: m.userId,
          userName: m.userName,
          sourceKey: m.sourceKey,
          meta: m.meta,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
      });
    return rows;
  }

  async upsertUserMessage(params: Omit<ConversationMessageInput, "role">) {
    const normalized = normalizeConversationMessage({ ...params, role: "user" });
    if (!normalized) return null;
    const [row] = await this.db
      .insert(conversationMessages)
      .values({
        botId: normalized.botId,
        chatId: normalized.chatId,
        role: "user",
        content: normalized.content,
        userAuthoredContent: normalized.userAuthoredContent ?? null,
        userId: normalized.userId,
        userName: normalized.userName,
        sourceKey: normalized.sourceKey,
        meta: normalized.meta,
      })
      .onConflictDoUpdate({
        target: [
          conversationMessages.botId,
          conversationMessages.chatId,
          conversationMessages.sourceKey,
        ],
        set: {
          embedding: sql`CASE WHEN ${conversationMessages.content} = ${normalized.content} THEN ${conversationMessages.embedding} ELSE NULL END`,
          content: normalized.content,
          userAuthoredContent: normalized.userAuthoredContent ?? null,
          userId: normalized.userId,
          userName: normalized.userName,
          meta: normalized.meta,
        },
      })
      .returning({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
      });
    return row ?? null;
  }

  async completeTurn(
    botId: string,
    chatId: number,
    sourceKey: string,
    turnOrderId?: number,
  ): Promise<boolean> {
    return this.completeTurns(botId, chatId, [sourceKey], turnOrderId);
  }

  async completeTurns(
    botId: string,
    chatId: number,
    sourceKeys: readonly string[],
    turnOrderId?: number,
  ): Promise<boolean> {
    const uniqueSourceKeys = [...new Set(sourceKeys)];
    if (uniqueSourceKeys.length === 0) return true;

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: conversationMessages.id,
          sourceKey: conversationMessages.sourceKey,
          meta: conversationMessages.meta,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            eq(conversationMessages.chatId, chatId),
            inArray(conversationMessages.sourceKey, uniqueSourceKeys),
          ),
        )
        .orderBy(asc(conversationMessages.id))
        .for("update");

      // Complete found rows even when some are missing (e.g. pruned by retention),
      // so surviving rows never stay pending forever; the caller still sees false.
      for (const row of rows) {
        if (
          row.meta?.["turnState"] === "complete" &&
          (turnOrderId === undefined || row.meta["turnOrderId"] === turnOrderId)
        ) {
          continue;
        }
        await tx
          .update(conversationMessages)
          .set({
            meta: {
              ...row.meta,
              turnState: "complete",
              ...(turnOrderId === undefined ? {} : { turnOrderId }),
            },
          })
          .where(eq(conversationMessages.id, row.id));
      }
      return rows.length === uniqueSourceKeys.length;
    });
  }

  async recoverPendingTurns(botId: string): Promise<number> {
    const recovered = await this.db
      .update(conversationMessages)
      .set({
        meta: sql<Record<string, unknown>>`jsonb_set(
          coalesce(${conversationMessages.meta}::jsonb, '{}'::jsonb),
          '{turnState}',
          '"complete"'::jsonb,
          true
        )::json`,
      })
      .where(
        and(
          eq(conversationMessages.botId, botId),
          sql`${conversationMessages.meta}->>'turnState' = 'pending'`,
        ),
      )
      .returning({ id: conversationMessages.id });
    return recovered.length;
  }

  async getHistory(
    botId: string,
    chatId: number,
    limit: number,
    tokenBudget?: number,
    options?: {
      excludeSourceKey?: string;
      beforeId?: number;
      beforeTelegramMessageId?: number;
      threadId?: number | null;
    },
  ) {
    const historyBeforeId = options?.beforeId;
    const historyBoundary = buildConversationHistoryBoundary(
      historyBeforeId,
      options?.beforeTelegramMessageId,
    );
    // Compactions mix all topics; only raw, scoped rows are safe for a topic request.
    const activeCompaction =
      options?.threadId === undefined ? await this.getActiveCompaction(botId, chatId) : undefined;
    const threadCondition =
      options?.threadId === undefined
        ? undefined
        : options.threadId === null
          ? sql`${conversationMessages.meta}::jsonb ? 'threadId' AND ${conversationMessages.meta}->>'threadId' IS NULL`
          : sql`${conversationMessages.meta}->>'threadId' = ${String(options.threadId)}`;
    const active =
      historyBeforeId === undefined || (activeCompaction?.cursorId ?? 0) < historyBeforeId
        ? activeCompaction
        : undefined;
    const cursorId = active?.cursorId ?? 0;
    const excludeSourceKey = options?.excludeSourceKey;
    const historyOrderId = conversationMessageOrderId();

    if (tokenBudget !== undefined) {
      const newestFirst: Array<{
        id: number;
        role: string;
        content: string;
        userName: string | null;
        createdAt: Date;
        historyOrderId: number;
        forwardOrigin?: ConversationForwardOrigin;
        relayOrigin?: ConversationRelayOrigin;
        tgMessageId?: number;
      }> = [];
      let pageBeforeOrderId: number | undefined;
      let pageBeforeId: number | undefined;
      let scannedTokens = 0;
      let scannedAllHistory = false;
      while (scannedTokens <= tokenBudget) {
        const conditions = [
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          inArray(conversationMessages.role, ["user", "assistant", "context"]),
        ];
        if (excludeSourceKey) {
          conditions.push(
            or(
              isNull(conversationMessages.sourceKey),
              ne(conversationMessages.sourceKey, excludeSourceKey),
            )!,
          );
        }
        if (historyBoundary) conditions.push(historyBoundary);
        if (threadCondition) conditions.push(threadCondition);
        if (pageBeforeOrderId !== undefined && pageBeforeId !== undefined) {
          conditions.push(
            or(
              lt(historyOrderId, pageBeforeOrderId),
              and(eq(historyOrderId, pageBeforeOrderId), lt(conversationMessages.id, pageBeforeId)),
            )!,
          );
        }
        const batch = await this.db
          .select({
            id: conversationMessages.id,
            role: conversationMessages.role,
            content: conversationMessages.content,
            userName: conversationMessages.userName,
            createdAt: conversationMessages.createdAt,
            historyOrderId,
            meta: conversationMessages.meta,
          })
          .from(conversationMessages)
          .where(and(...conditions))
          .orderBy(desc(historyOrderId), desc(conversationMessages.id))
          .limit(HISTORY_PROMPT_SCAN_BATCH_SIZE);
        if (batch.length === 0) {
          scannedAllHistory = true;
          break;
        }
        const projectedBatch = batch.map(({ meta, ...message }) => ({
          ...message,
          ...projectForwardOrigin(meta),
          ...projectRelayOrigin(meta),
          ...projectTgMessageId(meta),
        }));
        newestFirst.push(...projectedBatch);
        scannedTokens += projectedBatch.reduce(
          (total, message) => total + estimateHistoryMessageTokens(message),
          0,
        );
        if (batch.length < HISTORY_PROMPT_SCAN_BATCH_SIZE) {
          scannedAllHistory = true;
          break;
        }
        pageBeforeOrderId = batch.at(-1)!.historyOrderId;
        pageBeforeId = batch.at(-1)!.id;
      }
      const rows = newestFirst.reverse();
      const scannedThroughActiveCursor =
        !active ||
        scannedAllHistory ||
        rows.some((message) => message.historyOrderId <= active.cursorId);
      const selected = selectHistoryWithinTokenBudget(
        rows,
        active
          ? {
              cursorId: active.cursorId,
              content: active.content,
              rawHistoryIntact: active.rawHistoryIntact,
            }
          : undefined,
        tokenBudget,
        { scannedAllHistory, scannedThroughActiveCursor },
      );
      return {
        summary: selected.summary,
        messages: selected.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          userName: message.userName,
          createdAt: message.createdAt.toISOString(),
          ...(message.forwardOrigin ? { forwardOrigin: message.forwardOrigin } : {}),
          ...(message.relayOrigin ? { relayOrigin: message.relayOrigin } : {}),
          ...(message.tgMessageId === undefined ? {} : { tgMessageId: message.tgMessageId }),
        })),
        budgetTrace: selected.trace,
      };
    }

    const messages = await this.db
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
        userName: conversationMessages.userName,
        createdAt: conversationMessages.createdAt,
        historyOrderId,
        meta: conversationMessages.meta,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          gt(historyOrderId, cursorId),
          inArray(conversationMessages.role, ["user", "assistant", "context"]),
          historyBoundary,
          threadCondition,
          excludeSourceKey
            ? or(
                isNull(conversationMessages.sourceKey),
                ne(conversationMessages.sourceKey, excludeSourceKey),
              )
            : undefined,
        ),
      )
      .orderBy(desc(historyOrderId), desc(conversationMessages.id))
      .limit(limit);

    return {
      summary: active?.content ?? null,
      messages: messages.reverse().map(({ meta, ...message }) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        userName: message.userName,
        createdAt: message.createdAt.toISOString(),
        ...projectForwardOrigin(meta),
        ...projectRelayOrigin(meta),
        ...projectTgMessageId(meta),
      })),
    };
  }

  async getRecentUserMessagesAcrossChats(
    botId: string,
    userId: number,
    excludeChatId: number,
    limit: number,
    beforeId?: number,
  ) {
    const rows = await this.db
      .select({
        id: conversationMessages.id,
        content: conversationMessages.userAuthoredContent,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.userId, userId),
          eq(conversationMessages.role, "user"),
          ne(conversationMessages.chatId, excludeChatId),
          isNotNull(conversationMessages.userAuthoredContent),
          beforeId === undefined ? undefined : lte(conversationMessages.id, beforeId),
        ),
      )
      .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
      .limit(limit);
    return rows.reverse().map((row) => ({
      id: row.id,
      content: row.content!,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Admission-time upper bound so a queued turn never reads messages persisted after it. */
  async getHistoryWatermark(botId: string): Promise<number | undefined> {
    const [row] = await this.db
      .select({ maxId: sql<number | null>`max(${conversationMessages.id})` })
      .from(conversationMessages)
      .where(eq(conversationMessages.botId, botId));
    return row?.maxId == null ? undefined : Number(row.maxId);
  }

  private async getActiveCompaction(botId: string, chatId: number) {
    const [active] = await this.db
      .select({
        summaryId: conversationSummaries.id,
        cursorId: conversationSummaries.summarizedUpToId,
        content: conversationSummaries.content,
        rawHistoryIntact: conversationCompactionState.rawHistoryIntact,
      })
      .from(conversationCompactionState)
      .innerJoin(
        conversationSummaries,
        eq(conversationCompactionState.activeSummaryId, conversationSummaries.id),
      )
      .where(
        and(
          eq(conversationCompactionState.botId, botId),
          eq(conversationCompactionState.chatId, chatId),
        ),
      )
      .limit(1);
    return active;
  }

  async getMessageCount(botId: string, chatId: number): Promise<number> {
    const [result] = await this.db
      .select({ total: count() })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)));
    return Number(result?.total ?? 0);
  }

  async listChatsAtOrAboveMessageCount(botId: string, minimumCount: number) {
    const total = count();
    const rows = await this.db
      .select({ chatId: conversationMessages.chatId, total })
      .from(conversationMessages)
      .where(eq(conversationMessages.botId, botId))
      .groupBy(conversationMessages.chatId)
      .having(gte(total, minimumCount));
    return rows.map((row) => ({ chatId: row.chatId, count: Number(row.total) }));
  }

  async getUncompactedMessageCount(botId: string, chatId: number): Promise<number> {
    const active = await this.getActiveCompaction(botId, chatId);
    const historyOrderId = conversationMessageOrderId();
    const [result] = await this.db
      .select({ total: count() })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          gt(historyOrderId, active?.cursorId ?? 0),
        ),
      );
    return Number(result?.total ?? 0);
  }

  async getCompactionCandidate(
    botId: string,
    chatId: number,
    keepRecent: number,
  ): Promise<CompactionCandidate | null> {
    const active = await this.getActiveCompaction(botId, chatId);
    const oldCursorId = active?.cursorId ?? 0;
    const historyOrderId = conversationMessageOrderId();
    let retainedOrderId: number | undefined;
    if (keepRecent > 0) {
      const retained = await this.db
        .select({ historyOrderId })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            eq(conversationMessages.chatId, chatId),
            gt(historyOrderId, oldCursorId),
          ),
        )
        .orderBy(desc(historyOrderId), desc(conversationMessages.id))
        .limit(1)
        .offset(keepRecent - 1);
      if (retained.length === 0) return null;
      retainedOrderId = retained[0]!.historyOrderId;
    }

    const [pending] = await this.db
      .select({ historyOrderId })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          gt(historyOrderId, oldCursorId),
          sql`${conversationMessages.meta}->>'turnState' = 'pending'`,
        ),
      )
      .orderBy(asc(historyOrderId), asc(conversationMessages.id))
      .limit(1);
    const upperOrderId =
      retainedOrderId === undefined
        ? pending?.historyOrderId
        : pending === undefined
          ? retainedOrderId
          : Math.min(retainedOrderId, pending.historyOrderId);

    const storedMessages = await this.db
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: sql<string>`case
          when char_length(${conversationMessages.content}) > ${COMPACTION_MAX_SOURCE_MESSAGE_CHARS}
          then left(${conversationMessages.content}, ${Math.ceil((COMPACTION_MAX_SOURCE_MESSAGE_CHARS - TRUNCATION_MARKER.length) / 2)})
            || ${TRUNCATION_MARKER}
            || right(${conversationMessages.content}, ${Math.floor((COMPACTION_MAX_SOURCE_MESSAGE_CHARS - TRUNCATION_MARKER.length) / 2)})
          else ${conversationMessages.content}
        end`,
        userName: conversationMessages.userName,
        historyOrderId,
        meta: conversationMessages.meta,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          gt(historyOrderId, oldCursorId),
          upperOrderId === undefined ? undefined : lt(historyOrderId, upperOrderId),
        ),
      )
      .orderBy(asc(historyOrderId), asc(conversationMessages.id))
      .limit(COMPACTION_MAX_BATCH_MESSAGES + 1);
    const messages = storedMessages.map(({ meta, ...message }) => ({
      ...message,
      ...projectForwardOrigin(meta),
      ...projectRelayOrigin(meta),
    }));

    if (messages.length === 0) return null;
    let completeMessages = messages.slice(0, COMPACTION_MAX_BATCH_MESSAGES);
    const overflowMessage = messages[COMPACTION_MAX_BATCH_MESSAGES];
    if (
      overflowMessage &&
      completeMessages.at(-1)?.historyOrderId === overflowMessage.historyOrderId
    ) {
      const partialOrderId = overflowMessage.historyOrderId;
      completeMessages = completeMessages.filter(
        (message) => message.historyOrderId !== partialOrderId,
      );
    }
    if (completeMessages.length === 0) return null;

    const sourceBatch: typeof messages = [];
    let jsonChars = 0;
    for (let index = 0; index < completeMessages.length; ) {
      const orderId = completeMessages[index]!.historyOrderId;
      let turnEnd = index + 1;
      while (
        turnEnd < completeMessages.length &&
        completeMessages[turnEnd]!.historyOrderId === orderId
      ) {
        turnEnd++;
      }
      const turn = completeMessages.slice(index, turnEnd);
      const overhead = turn.reduce(
        (total, message) =>
          total +
          JSON.stringify({
            id: message.id,
            role: message.role,
            userName: message.userName,
            forwardOrigin: message.forwardOrigin,
            relayOrigin: message.relayOrigin,
            content: "",
          }).length +
          1,
        0,
      );
      const preferredChars = turn.reduce(
        (total, message) => total + message.content.length * JSON_ESCAPE_EXPANSION_FACTOR,
        overhead,
      );
      const remainingJsonChars = COMPACTION_MAX_BATCH_JSON_CHARS - jsonChars;
      if (sourceBatch.length > 0 && preferredChars > remainingJsonChars) break;
      if (overhead + turn.length * JSON_ESCAPE_EXPANSION_FACTOR > remainingJsonChars) return null;

      let remainingContentChars = Math.floor(
        (remainingJsonChars - overhead) / JSON_ESCAPE_EXPANSION_FACTOR,
      );
      let turnContentChars = 0;
      for (let turnIndex = 0; turnIndex < turn.length; turnIndex++) {
        const message = turn[turnIndex]!;
        const remainingMessages = turn.length - turnIndex;
        const contentBudget =
          preferredChars <= remainingJsonChars
            ? message.content.length
            : Math.max(1, Math.floor(remainingContentChars / remainingMessages));
        const content = truncateCompactionContent(message.content, contentBudget);
        sourceBatch.push({ ...message, content });
        remainingContentChars -= content.length;
        turnContentChars += content.length;
      }
      jsonChars += overhead + turnContentChars * JSON_ESCAPE_EXPANSION_FACTOR;
      index = turnEnd;
    }

    const lastMessage = sourceBatch.at(-1);
    if (!lastMessage) return null;
    const sourceMessageIds = sourceBatch.map((message) => message.id).sort((a, b) => a - b);
    const orderedBatch = orderConversationMessagesByTurn(sourceBatch).map(
      ({ id, role, content, userName, forwardOrigin, relayOrigin }) => ({
        id,
        role,
        content,
        userName,
        ...(forwardOrigin ? { forwardOrigin } : {}),
        ...(relayOrigin ? { relayOrigin } : {}),
      }),
    );
    return {
      activeSummaryId: active?.summaryId ?? null,
      oldCursorId,
      existingSummary: active?.content ?? null,
      messages: orderedBatch,
      sourceMessageIds,
      newCursorId: lastMessage.historyOrderId,
    };
  }

  async commitCompaction(params: {
    botId: string;
    chatId: number;
    expectedActiveSummaryId: number | null;
    oldCursorId: number;
    newCursorId: number;
    summaryText: string;
    messageCount: number;
    sourceMessageIds: number[];
  }): Promise<boolean> {
    if (
      params.newCursorId <= params.oldCursorId ||
      params.messageCount <= 0 ||
      params.sourceMessageIds.length !== params.messageCount
    ) {
      return false;
    }

    try {
      await this.db.transaction(async (tx) => {
        const historyOrderId = conversationMessageOrderId();
        const sourceRows = await tx
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.botId, params.botId),
              eq(conversationMessages.chatId, params.chatId),
              gt(historyOrderId, params.oldCursorId),
              lte(historyOrderId, params.newCursorId),
            ),
          )
          .orderBy(asc(conversationMessages.id))
          .for("update");
        if (
          sourceRows.length !== params.sourceMessageIds.length ||
          sourceRows.some((row, index) => row.id !== params.sourceMessageIds[index])
        ) {
          throw new CompactionConflictError();
        }

        if (params.expectedActiveSummaryId !== null) {
          const [current] = await tx
            .select({ cursorId: conversationSummaries.summarizedUpToId })
            .from(conversationCompactionState)
            .innerJoin(
              conversationSummaries,
              eq(conversationCompactionState.activeSummaryId, conversationSummaries.id),
            )
            .where(
              and(
                eq(conversationCompactionState.botId, params.botId),
                eq(conversationCompactionState.chatId, params.chatId),
                eq(conversationCompactionState.activeSummaryId, params.expectedActiveSummaryId),
              ),
            )
            .limit(1);
          if (!current || current.cursorId > params.newCursorId) {
            throw new CompactionConflictError();
          }
        }

        const [summary] = await tx
          .insert(conversationSummaries)
          .values({
            botId: params.botId,
            chatId: params.chatId,
            content: params.summaryText,
            previousSummarizedUpToId: params.oldCursorId,
            summarizedUpToId: params.newCursorId,
            messageCount: params.messageCount,
          })
          .returning({ id: conversationSummaries.id });
        if (!summary) throw new Error("Failed to persist conversation summary");

        const activated =
          params.expectedActiveSummaryId === null
            ? await tx
                .insert(conversationCompactionState)
                .values({
                  botId: params.botId,
                  chatId: params.chatId,
                  activeSummaryId: summary.id,
                })
                .onConflictDoNothing()
                .returning({ activeSummaryId: conversationCompactionState.activeSummaryId })
            : await tx
                .update(conversationCompactionState)
                .set({ activeSummaryId: summary.id, updatedAt: new Date() })
                .where(
                  and(
                    eq(conversationCompactionState.botId, params.botId),
                    eq(conversationCompactionState.chatId, params.chatId),
                    eq(conversationCompactionState.activeSummaryId, params.expectedActiveSummaryId),
                  ),
                )
                .returning({ activeSummaryId: conversationCompactionState.activeSummaryId });

        if (activated.length === 0) throw new CompactionConflictError();
        await this.pruneSummaryVersions(
          tx,
          params.botId,
          params.chatId,
          summary.id,
          CONVERSATION_SUMMARY_CLEANUP_BATCH_MAX,
        );
      });
      return true;
    } catch (error) {
      if (error instanceof CompactionConflictError) return false;
      throw error;
    }
  }

  async deleteMessage(botId: string, chatId: number, messageId: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx
        .delete(conversationMessages)
        .where(
          and(
            eq(conversationMessages.id, messageId),
            eq(conversationMessages.botId, botId),
            eq(conversationMessages.chatId, chatId),
          ),
        )
        .returning({ id: conversationMessages.id, meta: conversationMessages.meta });
      if (result.length === 0) return false;

      const [active] = await tx
        .select({
          summaryId: conversationCompactionState.activeSummaryId,
          cursorId: conversationSummaries.summarizedUpToId,
        })
        .from(conversationCompactionState)
        .innerJoin(
          conversationSummaries,
          eq(conversationCompactionState.activeSummaryId, conversationSummaries.id),
        )
        .where(
          and(
            eq(conversationCompactionState.botId, botId),
            eq(conversationCompactionState.chatId, chatId),
          ),
        )
        .limit(1)
        .for("update");

      if (active && storedMessageOrderId(messageId, result[0]?.meta) <= active.cursorId) {
        await tx
          .delete(conversationCompactionState)
          .where(
            and(
              eq(conversationCompactionState.botId, botId),
              eq(conversationCompactionState.chatId, chatId),
              eq(conversationCompactionState.activeSummaryId, active.summaryId),
            ),
          );
      }
      return true;
    });
  }

  async clearHistory(botId: string, chatId: number) {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(conversationMessages)
        .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)));
      await tx
        .delete(conversationCompactionState)
        .where(
          and(
            eq(conversationCompactionState.botId, botId),
            eq(conversationCompactionState.chatId, chatId),
          ),
        );
      await tx
        .delete(conversationSummaries)
        .where(
          and(eq(conversationSummaries.botId, botId), eq(conversationSummaries.chatId, chatId)),
        );
    });
  }

  async clearAllForBot(botId: string) {
    await this.db.transaction(async (tx) => {
      await tx.delete(conversationMessages).where(eq(conversationMessages.botId, botId));
      await tx
        .delete(conversationCompactionState)
        .where(eq(conversationCompactionState.botId, botId));
      await tx.delete(conversationSummaries).where(eq(conversationSummaries.botId, botId));
    });
  }

  async getConversationList(botId: string, page: number, limit: number, search?: string) {
    const offset = (page - 1) * limit;
    const normalizedSearch = search?.trim() || undefined;
    const numericSearch =
      normalizedSearch && /^-?\d+$/.test(normalizedSearch) ? Number(normalizedSearch) : undefined;
    const searchChatId = Number.isSafeInteger(numericSearch) ? numericSearch : undefined;
    const matchingChatIds = normalizedSearch
      ? this.db
          .selectDistinct({ chatId: conversationMessages.chatId })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.botId, botId),
              or(
                ilike(conversationMessages.userName, `%${escapeLike(normalizedSearch)}%`),
                searchChatId === undefined
                  ? undefined
                  : eq(conversationMessages.chatId, searchChatId),
              ),
            ),
          )
      : null;
    const conversationScope = and(
      eq(conversationMessages.botId, botId),
      matchingChatIds === null ? undefined : inArray(conversationMessages.chatId, matchingChatIds),
    );

    // 1a. Main aggregate query with role counts and user info
    const rows = await this.db
      .select({
        chatId: conversationMessages.chatId,
        messageCount: count(),
        lastActive: sql<string>`max(${conversationMessages.createdAt})`.as("last_active"),
        firstActive: sql<string>`min(${conversationMessages.createdAt})`.as("first_active"),
        distinctUserCount: sql<number>`count(distinct ${conversationMessages.userId})
          filter (where ${conversationMessages.userId} is not null)`.as("distinct_user_count"),
        userNames: sql<string[]>`array_remove(array_agg(distinct ${conversationMessages.userName})
          filter (where ${conversationMessages.userName} is not null), null)`.as("user_names"),
        roleUser: sql<number>`count(*) filter (where ${conversationMessages.role} = 'user')`.as(
          "role_user",
        ),
        roleAssistant:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'assistant')`.as(
            "role_assistant",
          ),
        roleToolCall:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'tool_call')`.as(
            "role_tool_call",
          ),
        roleToolResult:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'tool_result')`.as(
            "role_tool_result",
          ),
        roleSystem: sql<number>`count(*) filter (where ${conversationMessages.role} = 'system')`.as(
          "role_system",
        ),
        roleContext:
          sql<number>`count(*) filter (where ${conversationMessages.role} = 'context')`.as(
            "role_context",
          ),
      })
      .from(conversationMessages)
      .where(conversationScope)
      .groupBy(conversationMessages.chatId)
      .orderBy(desc(sql`max(${conversationMessages.createdAt})`), asc(conversationMessages.chatId))
      .limit(limit)
      .offset(offset);

    const [totalResult] = await this.db
      .select({
        total: sql<number>`count(distinct ${conversationMessages.chatId})`,
      })
      .from(conversationMessages)
      .where(conversationScope);

    if (rows.length === 0) {
      return { data: [], total: Number(totalResult?.total ?? 0) };
    }

    const chatIds = rows.map((r) => r.chatId);

    // 1b. Latest message preview per chat (DISTINCT ON)
    const lastMessages = await this.db.execute<{
      chat_id: number;
      content: string;
      role: string;
      user_name: string | null;
    }>(
      sql`select distinct on (chat_id) chat_id, left(content, 200) as content, role, user_name
          from ${conversationMessages}
          where ${and(eq(conversationMessages.botId, botId), inArray(conversationMessages.chatId, chatIds))}
          order by chat_id, id desc`,
    );
    const lastMessageMap = new Map(lastMessages.map((m) => [Number(m.chat_id), m]));

    // 1c. Summary counts per chat
    const summaryCounts = await this.db
      .select({
        chatId: conversationSummaries.chatId,
        summaryCount: count(),
      })
      .from(conversationSummaries)
      .where(
        and(eq(conversationSummaries.botId, botId), inArray(conversationSummaries.chatId, chatIds)),
      )
      .groupBy(conversationSummaries.chatId);
    const summaryMap = new Map(summaryCounts.map((s) => [s.chatId, Number(s.summaryCount)]));

    return {
      data: rows.map((r) => {
        const lm = lastMessageMap.get(r.chatId);
        const sc = summaryMap.get(r.chatId) ?? 0;
        return {
          chatId: r.chatId,
          messageCount: Number(r.messageCount),
          lastActive: r.lastActive,
          firstActive: r.firstActive,
          chatType: (r.chatId > 0 ? "private" : "group") as "private" | "group",
          roleCounts: {
            user: Number(r.roleUser),
            assistant: Number(r.roleAssistant),
            tool_call: Number(r.roleToolCall),
            tool_result: Number(r.roleToolResult),
            system: Number(r.roleSystem),
            context: Number(r.roleContext),
          },
          distinctUserCount: Number(r.distinctUserCount),
          userNames: r.userNames?.length ? r.userNames : null,
          lastMessage: lm ? { content: lm.content, role: lm.role, userName: lm.user_name } : null,
          hasSummaries: sc > 0,
          summaryCount: sc,
        };
      }),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async getConversationSummaries(botId: string, chatId: number, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [rows, [totalResult], active] = await Promise.all([
      this.db
        .select()
        .from(conversationSummaries)
        .where(
          and(eq(conversationSummaries.botId, botId), eq(conversationSummaries.chatId, chatId)),
        )
        .orderBy(desc(conversationSummaries.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(conversationSummaries)
        .where(
          and(eq(conversationSummaries.botId, botId), eq(conversationSummaries.chatId, chatId)),
        ),
      this.getActiveCompaction(botId, chatId),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        content: r.content,
        previousSummarizedUpToId: r.previousSummarizedUpToId,
        summarizedUpToId: r.summarizedUpToId,
        messageCount: r.messageCount,
        createdAt: r.createdAt.toISOString(),
        isActive: r.id === active?.summaryId,
      })),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async editActiveConversationSummary(params: {
    botId: string;
    chatId: number;
    expectedActiveSummaryId: number;
    content: string;
  }): Promise<{ id: number; createdAt: string } | null> {
    if (!params.content.trim() || params.content.length > 40_000) {
      throw new RangeError("Summary content must contain 1 to 40000 characters");
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [active] = await tx
          .select({
            id: conversationSummaries.id,
            previousSummarizedUpToId: conversationSummaries.previousSummarizedUpToId,
            summarizedUpToId: conversationSummaries.summarizedUpToId,
            messageCount: conversationSummaries.messageCount,
          })
          .from(conversationCompactionState)
          .innerJoin(
            conversationSummaries,
            eq(conversationCompactionState.activeSummaryId, conversationSummaries.id),
          )
          .where(
            and(
              eq(conversationCompactionState.botId, params.botId),
              eq(conversationCompactionState.chatId, params.chatId),
            ),
          )
          .limit(1)
          .for("update");
        if (active?.id !== params.expectedActiveSummaryId) throw new CompactionConflictError();

        const [version] = await tx
          .insert(conversationSummaries)
          .values({
            botId: params.botId,
            chatId: params.chatId,
            content: params.content,
            previousSummarizedUpToId: active.previousSummarizedUpToId,
            summarizedUpToId: active.summarizedUpToId,
            messageCount: active.messageCount,
          })
          .returning({ id: conversationSummaries.id, createdAt: conversationSummaries.createdAt });
        if (!version) throw new Error("Failed to persist conversation summary edit");

        const activated = await tx
          .update(conversationCompactionState)
          .set({ activeSummaryId: version.id, updatedAt: new Date() })
          .where(
            and(
              eq(conversationCompactionState.botId, params.botId),
              eq(conversationCompactionState.chatId, params.chatId),
              eq(conversationCompactionState.activeSummaryId, params.expectedActiveSummaryId),
            ),
          )
          .returning({ activeSummaryId: conversationCompactionState.activeSummaryId });
        if (activated.length === 0) throw new CompactionConflictError();
        await this.pruneSummaryVersions(
          tx,
          params.botId,
          params.chatId,
          version.id,
          CONVERSATION_SUMMARY_CLEANUP_BATCH_MAX,
        );
        return { id: version.id, createdAt: version.createdAt.toISOString() };
      });
    } catch (error) {
      if (error instanceof CompactionConflictError) return null;
      throw error;
    }
  }

  async previewConversationSummaryCleanup(botId: string, chatId: number) {
    const [active, [total]] = await Promise.all([
      this.getActiveCompaction(botId, chatId),
      this.db
        .select({ count: count() })
        .from(conversationSummaries)
        .where(this.summaryScope(botId, chatId)),
    ]);
    const activeSummaryId = active?.summaryId ?? null;
    const retainedIds = await this.retainedSummaryIds(this.db, botId, chatId, activeSummaryId);
    const totalCount = Number(total?.count ?? 0);
    return {
      activeSummaryId,
      totalCount,
      retainedIds,
      eligibleCount: Math.max(0, totalCount - retainedIds.length),
      batchMax: CONVERSATION_SUMMARY_CLEANUP_BATCH_MAX,
    };
  }

  async cleanupConversationSummaryBatch(params: {
    botId: string;
    chatId: number;
    expectedActiveSummaryId: number | null;
    limit: number;
  }): Promise<{ deletedCount: number; remainingCount: number } | null> {
    if (
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > CONVERSATION_SUMMARY_CLEANUP_BATCH_MAX
    ) {
      throw new RangeError("Invalid summary cleanup batch limit");
    }
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select({ activeSummaryId: conversationCompactionState.activeSummaryId })
        .from(conversationCompactionState)
        .where(
          and(
            eq(conversationCompactionState.botId, params.botId),
            eq(conversationCompactionState.chatId, params.chatId),
          ),
        )
        .limit(1)
        .for("update");
      const activeSummaryId = state?.activeSummaryId ?? null;
      if (activeSummaryId !== params.expectedActiveSummaryId) return null;
      const deletedCount = await this.pruneSummaryVersions(
        tx,
        params.botId,
        params.chatId,
        activeSummaryId,
        params.limit,
      );
      const [remaining] = await tx
        .select({ count: count() })
        .from(conversationSummaries)
        .where(this.summaryScope(params.botId, params.chatId));
      return { deletedCount, remainingCount: Number(remaining?.count ?? 0) };
    });
  }

  async deleteConversationSummary(
    botId: string,
    chatId: number,
    id: number,
  ): Promise<"deleted" | "active" | "not_found"> {
    return this.db.transaction(async (tx) => {
      const [active] = await tx
        .select({ activeSummaryId: conversationCompactionState.activeSummaryId })
        .from(conversationCompactionState)
        .where(
          and(
            eq(conversationCompactionState.botId, botId),
            eq(conversationCompactionState.chatId, chatId),
          ),
        )
        .limit(1)
        .for("update");
      if (active?.activeSummaryId === id) return "active";

      const result = await tx
        .delete(conversationSummaries)
        .where(
          and(
            eq(conversationSummaries.id, id),
            eq(conversationSummaries.botId, botId),
            eq(conversationSummaries.chatId, chatId),
          ),
        )
        .returning({ id: conversationSummaries.id });
      return result.length > 0 ? "deleted" : "not_found";
    });
  }

  async getConversationMessages(botId: string, chatId: number, page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [messages, [totalResult]] = await Promise.all([
      this.db
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)))
        .orderBy(desc(conversationMessages.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId))),
    ]);

    return {
      data: messages.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        userId: m.userId,
        userName: m.userName,
        meta: m.meta,
        createdAt: m.createdAt.toISOString(),
      })),
      total: Number(totalResult?.total ?? 0),
    };
  }

  async updateEmbeddingIfContentMatches(
    botId: string,
    messageId: number,
    content: string,
    embedding: number[],
  ): Promise<boolean> {
    const updated = await this.db
      .update(conversationMessages)
      .set({ embedding })
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.id, messageId),
          eq(conversationMessages.content, content),
        ),
      )
      .returning({ id: conversationMessages.id });
    return updated.length > 0;
  }

  async searchMessages(
    botId: string,
    params: {
      query: string;
      chatId?: number;
      userId?: number;
      limit?: number;
      queryEmbedding?: number[];
    },
  ) {
    const limit = params.limit ?? 20;

    const buildBaseConditions = () => {
      const conditions = [eq(conversationMessages.botId, botId)];
      if (params.chatId !== undefined) {
        conditions.push(eq(conversationMessages.chatId, params.chatId));
      }
      if (params.userId !== undefined) {
        conditions.push(eq(conversationMessages.userId, params.userId));
      }
      return conditions;
    };

    const selectFields = {
      id: conversationMessages.id,
      role: conversationMessages.role,
      content: conversationMessages.content,
      userName: conversationMessages.userName,
      chatId: conversationMessages.chatId,
      createdAt: conversationMessages.createdAt,
      meta: conversationMessages.meta,
    };

    type Row = {
      id: number;
      role: string;
      content: string;
      userName: string | null;
      chatId: number;
      createdAt: Date;
      meta?: Record<string, unknown> | null;
    };
    const toResult = (r: Row) => {
      const attribution = formatConversationRelayOrigin(parseConversationRelayOrigin(r.meta));
      return {
        role: r.role,
        content: attribution ? `${attribution}\n${r.content}` : r.content,
        userName: r.userName,
        chatId: r.chatId,
        createdAt: r.createdAt.toISOString(),
      };
    };

    // Hybrid search when embedding is available
    if (params.queryEmbedding) {
      const baseConditions = buildBaseConditions();

      // Keyword search (fix: use escapeLike)
      const keywordResults = await this.db
        .select(selectFields)
        .from(conversationMessages)
        .where(
          and(
            ...baseConditions,
            ilike(conversationMessages.content, `%${escapeLike(params.query)}%`),
          ),
        )
        .orderBy(desc(conversationMessages.createdAt))
        .limit(30);

      // Vector search
      const vectorResults = await this.db
        .select(selectFields)
        .from(conversationMessages)
        .where(and(...baseConditions, isNotNull(conversationMessages.embedding)))
        .orderBy(cosineDistance(conversationMessages.embedding, params.queryEmbedding))
        .limit(30);

      const merged = rrfMerge(keywordResults, vectorResults, 0.7, 0.3, 60, limit);
      return merged.map(toResult);
    }

    // Keyword-only fallback (fix: use escapeLike)
    const conditions = [
      ...buildBaseConditions(),
      ilike(conversationMessages.content, `%${escapeLike(params.query)}%`),
    ];
    const rows = await this.db
      .select(selectFields)
      .from(conversationMessages)
      .where(and(...conditions))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);
    return rows.map(toResult);
  }

  async enforceHistoryLimit(
    botId: string,
    chatId: number,
    maxRawMessagesPerChat: number,
  ): Promise<HistoryLimitResult> {
    const limit = Math.max(0, Math.floor(maxRawMessagesPerChat));
    const warningThreshold = limit > 0 ? Math.floor(limit * 0.8) : 0;
    if (limit === 0) {
      return {
        countBefore: 0,
        countAfter: 0,
        limit,
        warningThreshold,
        prunedCount: 0,
        warning: false,
      };
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${botId}:${chatId}`}, 0))`,
      );

      const [countRow] = await tx
        .select({ total: count() })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.botId, botId), eq(conversationMessages.chatId, chatId)));
      const countBefore = Number(countRow?.total ?? 0);
      let prunedCount = 0;

      if (countBefore >= limit) {
        const historyOrderId = conversationMessageOrderId();
        // Queued turns still write rows under their own order id, so pruning must stop
        // before the oldest pending turn instead of orphaning its later rows.
        const [pending] = await tx
          .select({ historyOrderId })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.botId, botId),
              eq(conversationMessages.chatId, chatId),
              sql`${conversationMessages.meta}->>'turnState' = 'pending'`,
            ),
          )
          .orderBy(asc(historyOrderId), asc(conversationMessages.id))
          .limit(1);
        const pendingOrderId = pending?.historyOrderId;

        let remaining = countBefore - warningThreshold;
        while (remaining > 0) {
          const turns = await tx
            .select({ historyOrderId, total: count() })
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.botId, botId),
                eq(conversationMessages.chatId, chatId),
                pendingOrderId === undefined ? undefined : lt(historyOrderId, pendingOrderId),
              ),
            )
            .groupBy(historyOrderId)
            .orderBy(asc(historyOrderId))
            .limit(HISTORY_PRUNE_BATCH_SIZE);
          if (turns.length === 0) break;

          let cutoffOrderId: number | undefined;
          let plannedRows = 0;
          for (const turn of turns) {
            cutoffOrderId = turn.historyOrderId;
            plannedRows += Number(turn.total);
            if (plannedRows >= remaining) break;
          }
          if (cutoffOrderId === undefined) break;

          const deleted = await tx
            .delete(conversationMessages)
            .where(
              and(
                eq(conversationMessages.botId, botId),
                eq(conversationMessages.chatId, chatId),
                lte(historyOrderId, cutoffOrderId),
              ),
            )
            .returning({ id: conversationMessages.id });
          prunedCount += deleted.length;
          if (deleted.length > 0) {
            await tx
              .update(conversationCompactionState)
              .set({ rawHistoryIntact: false, updatedAt: new Date() })
              .where(
                and(
                  eq(conversationCompactionState.botId, botId),
                  eq(conversationCompactionState.chatId, chatId),
                ),
              );
          }
          remaining -= deleted.length;
          if (deleted.length === 0) break;
        }
      }

      return {
        countBefore,
        countAfter: countBefore - prunedCount,
        limit,
        warningThreshold,
        prunedCount,
        warning: countBefore >= warningThreshold,
      };
    });
  }

  async cleanup(botId: string, retentionDays: number) {
    if (retentionDays <= 0) return;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await this.db.transaction(async (tx) => {
      const affectedChats = await tx
        .selectDistinct({ chatId: conversationMessages.chatId })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            lt(conversationMessages.createdAt, cutoffDate),
          ),
        );
      await tx
        .delete(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            lt(conversationMessages.createdAt, cutoffDate),
          ),
        );
      if (affectedChats.length > 0) {
        await tx
          .update(conversationCompactionState)
          .set({ rawHistoryIntact: false, updatedAt: new Date() })
          .where(
            and(
              eq(conversationCompactionState.botId, botId),
              inArray(
                conversationCompactionState.chatId,
                affectedChats.map((row) => row.chatId),
              ),
            ),
          );
      }

      const expiredActiveStates = await tx
        .select({ summaryId: conversationCompactionState.activeSummaryId })
        .from(conversationCompactionState)
        .innerJoin(
          conversationSummaries,
          eq(conversationCompactionState.activeSummaryId, conversationSummaries.id),
        )
        .where(
          and(
            eq(conversationCompactionState.botId, botId),
            lt(conversationSummaries.createdAt, cutoffDate),
          ),
        )
        .for("update");
      if (expiredActiveStates.length > 0) {
        await tx.delete(conversationCompactionState).where(
          and(
            eq(conversationCompactionState.botId, botId),
            inArray(
              conversationCompactionState.activeSummaryId,
              expiredActiveStates.map((state) => state.summaryId),
            ),
          ),
        );
      }

      await tx
        .delete(conversationSummaries)
        .where(
          and(
            eq(conversationSummaries.botId, botId),
            lt(conversationSummaries.createdAt, cutoffDate),
          ),
        );
    });
  }
}
