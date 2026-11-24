import { randomUUID } from "node:crypto";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createModelFetch } from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import {
  botMemories,
  bots,
  conversationMessages,
  memoryConsolidationEvidence,
  memoryConsolidationState,
  tokenUsage,
  userPrivacySettings,
} from "@cos-tool-bot/database";
import type {
  AiConfigStored,
  BotMemory,
  UsageGovernancePort,
  UserPrivacyMode,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  includesUnscopedPersonalMemories,
} from "@cos-tool-bot/shared";
import { APICallError, generateText } from "ai";
import {
  and,
  arrayOverlaps,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { countTokens } from "gpt-tokenizer";
import type { Logger } from "pino";
import { type AiConfigRuntime, toAiConfigRuntime } from "./ai-config-runtime.js";
import { BotMemoryStore } from "./bot-memory-store.js";
import type { BotMemoryWriter } from "./bot-memory-writer.js";
import { createBotEmbeddingService } from "./embedding-service.js";

const INTERVAL_MS = 15 * 60_000;
const LEASE_MS = 90_000;
const EMBEDDING_TIMEOUT_MS = 25_000;
const STABLE_AGE_MS = 5 * 60_000;
const STALE_PENDING_AGE_MS = 24 * 60 * 60_000;
const MAX_MESSAGES = 12;
const MAX_CHARS_PER_MESSAGE = 1_000;
const MAX_INPUT_TOKENS = 4_000;
// Thinking models spend part of this cap on reasoning before the JSON answer.
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_PROPOSALS = 3;
const MAX_BOTS_PER_TICK = 2;

const CONSOLIDATION_RULES = [
  "Return only JSON array, at most 3 entries.",
  "Actions: add/update/retire/ignore.",
  "Each entry: action, kind, content if add/update, targetId if update/retire, sourceMessageIds, participantIds, optional expiresAt ISO.",
  "Use only explicit source statements.",
  "Use event for a shared episode and commitment for an explicitly unfinished thread or follow-up.",
  "Group events, commitments and relationships stay in the group.",
  "A personalCandidate may also yield a fact/preference ONLY for its own author, based on an explicit first-person self-description, with selfQuote copied verbatim from the original.",
  "Ignore jokes, temporary moods, indirect reports and guesses.",
  "Never turn existing private impressions into shared statements.",
  "Previously processed shared evidence (personalOnly) may only produce an explicit personal impression.",
  "Ignore duplicates and historical statements superseded by newer evidence.",
  "Use message dates for deadlines and ignore already expired statements.",
  "Avoid secrets, sensitive data and speculative facts.",
  "Prefer ignore.",
  "Do not claim a task was completed unless explicit.",
  "Existing targets may only be changed when evidence directly contradicts them.",
].join(" ");

type ReviewRange = { chatId: number; start: Date; end: Date; afterMessageId: number };
export type MemoryReviewResult = {
  calls: number;
  changes: number;
  inputTokens: number;
  outputTokens: number;
  nextAfterMessageId: number | null;
};

export class MemoryReviewError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 429 | 503,
  ) {
    super(message);
  }
}

type Source = Pick<
  typeof conversationMessages.$inferSelect,
  | "id"
  | "botId"
  | "chatId"
  | "role"
  | "userId"
  | "userAuthoredContent"
  | "sourceKey"
  | "meta"
  | "createdAt"
>;

/** Match /privacy forget's privacy-row -> source-message lock order. */
export async function lockConsolidationInputs(
  tx: Pick<Database, "select" | "execute">,
  botId: string,
  participantIds: readonly number[],
  sourceIds: readonly number[],
) {
  const orderedParticipants = [...new Set(participantIds)].sort((a, b) => a - b);
  const privacy = await tx
    .select()
    .from(userPrivacySettings)
    .where(
      and(
        eq(userPrivacySettings.botId, botId),
        inArray(userPrivacySettings.userId, orderedParticipants),
      ),
    )
    .orderBy(asc(userPrivacySettings.userId))
    .for("update");

  // Absent privacy rows cannot be row-locked. These locks also serialize with
  // the migration's privacy/evidence triggers before any source row is locked.
  for (const userId of orderedParticipants) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${botId}:${userId}`}, 0))`,
    );
  }

  const current = await tx
    .select({
      id: conversationMessages.id,
      botId: conversationMessages.botId,
      chatId: conversationMessages.chatId,
      role: conversationMessages.role,
      userId: conversationMessages.userId,
      userAuthoredContent: conversationMessages.userAuthoredContent,
      sourceKey: conversationMessages.sourceKey,
      meta: conversationMessages.meta,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.botId, botId), inArray(conversationMessages.id, sourceIds)))
    .orderBy(asc(conversationMessages.id))
    .for("update");
  return { current, privacy };
}

type Action = "add" | "update" | "retire" | "ignore";
type ModelResponse = {
  text: string;
  model: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
};
const memorySnapshotColumns = {
  id: botMemories.id,
  botId: botMemories.botId,
  telegramId: botMemories.telegramId,
  scopeChatId: botMemories.scopeChatId,
  content: botMemories.content,
  category: botMemories.category,
  kind: botMemories.kind,
  origin: botMemories.origin,
  sourceChatId: botMemories.sourceChatId,
  sourceMessageId: botMemories.sourceMessageId,
  sourceUserId: botMemories.sourceUserId,
  expiresAt: botMemories.expiresAt,
  factValidAt: botMemories.factValidAt,
  supersededById: botMemories.supersededById,
  isActive: botMemories.isActive,
  updatedAt: botMemories.updatedAt,
} as const;
type MemorySnapshot = {
  [K in keyof typeof memorySnapshotColumns]: (typeof botMemories.$inferSelect)[K];
};

export function sameMemorySnapshot(left: MemorySnapshot, right: MemorySnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertShownMemoryTarget(
  targetId: number,
  snapshots: readonly MemorySnapshot[],
  current: MemorySnapshot | undefined,
): MemorySnapshot {
  const shown = snapshots.find((snapshot) => snapshot.id === targetId);
  if (!shown) throw new Error("Memory consolidation target was not shown to model");
  if (!current || !sameMemorySnapshot(current, shown)) {
    throw new Error("Memory consolidation target changed");
  }
  return shown;
}

export function fitConsolidationBatch<T>(
  candidates: readonly T[],
  renderPrompt: (sources: readonly T[]) => string,
  tokenBudget: number,
): { accepted: T[]; firstOverflow: T | null; prompt: string | null } {
  const accepted: T[] = [];
  let prompt: string | null = null;
  for (const candidate of candidates) {
    const next = [...accepted, candidate];
    const rendered = renderPrompt(next);
    if (countTokens(rendered) > tokenBudget) return { accepted, firstOverflow: candidate, prompt };
    accepted.push(candidate);
    prompt = rendered;
  }
  return { accepted, firstOverflow: null, prompt };
}

export function consolidationEnabled(
  config: AiConfigStored | null | undefined,
): config is AiConfigStored {
  return config?.enabled === true && config.botMemoryConfig?.enabled === true;
}
export interface MemoryProposal {
  action: Action;
  kind: "fact" | "preference" | "event" | "commitment" | "relationship";
  content?: string;
  targetId?: number;
  sourceMessageIds: number[];
  participantIds: number[];
  expiresAt?: string;
}

export interface HistoricalBatchPreview {
  botId: string;
  cursorMessageId: number;
  processed: boolean;
  chatId: number | null;
  messageIds: number[];
  participantIds: number[];
  excerpts: string[];
}

export interface HistoricalBatchPage {
  data: HistoricalBatchPreview[];
  nextAfterMessageId: number | null;
}

function integerIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null;
  if (!value.every((id) => Number.isSafeInteger(id) && id > 0)) return null;
  return [...new Set(value as number[])];
}

export function parseMemoryProposals(
  text: string,
  sources: readonly Source[],
  personalSourceIds: ReadonlySet<number> = new Set(),
): MemoryProposal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("Invalid consolidation JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PROPOSALS) {
    throw new Error("Invalid consolidation proposal count");
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  const proposals: MemoryProposal[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object") throw new Error("Invalid consolidation proposal");
    const proposal = value as Record<string, unknown>;
    if (!(["add", "update", "retire", "ignore"] as unknown[]).includes(proposal.action)) {
      throw new Error("Invalid consolidation action");
    }
    if (
      !(["fact", "preference", "event", "commitment", "relationship"] as unknown[]).includes(
        proposal.kind,
      )
    ) {
      throw new Error("Invalid consolidation kind");
    }
    const sourceMessageIds = integerIds(proposal.sourceMessageIds);
    const participantIds = integerIds(proposal.participantIds);
    if (!sourceMessageIds || !participantIds) throw new Error("Missing consolidation evidence");
    const selected = sourceMessageIds.map((id) => byId.get(id));
    if (selected.some((source) => !source)) throw new Error("Unknown consolidation source");
    const actualParticipants = [...new Set(selected.map((source) => source!.userId!))].sort(
      (a, b) => a - b,
    );
    if (actualParticipants.join(",") !== [...participantIds].sort((a, b) => a - b).join(",")) {
      throw new Error("Consolidation participant mismatch");
    }
    const chatId = selected[0]!.chatId;
    if (selected.some((source) => source!.chatId !== chatId)) {
      throw new Error("Cross-chat consolidation source");
    }
    if (
      chatId !== participantIds[0] &&
      (proposal.kind === "fact" || proposal.kind === "preference")
    ) {
      const quote = typeof proposal.selfQuote === "string" ? proposal.selfQuote.trim() : "";
      if (
        chatId >= 0 ||
        participantIds.length !== 1 ||
        !quote ||
        !selected.every((source) => personalSourceIds.has(source!.id)) ||
        !selected.some((source) => source!.userAuthoredContent?.includes(quote))
      ) {
        throw new Error("Group profile inference denied");
      }
    }
    const content = typeof proposal.content === "string" ? proposal.content.trim() : undefined;
    if (
      (proposal.action === "add" || proposal.action === "update") &&
      (!content || content.length > 500)
    ) {
      throw new Error("Invalid consolidation content");
    }
    const targetId = proposal.targetId;
    if (
      (proposal.action === "update" || proposal.action === "retire") &&
      (!Number.isSafeInteger(targetId) || Number(targetId) <= 0)
    ) {
      throw new Error("Missing consolidation target");
    }
    let expiresAt: string | undefined;
    if (proposal.expiresAt !== undefined) {
      if (
        typeof proposal.expiresAt !== "string" ||
        Number.isNaN(Date.parse(proposal.expiresAt)) ||
        Date.parse(proposal.expiresAt) <= Date.now() ||
        Date.parse(proposal.expiresAt) > Date.now() + 365 * 86_400_000
      ) {
        throw new Error("Invalid consolidation expiry");
      }
      expiresAt = proposal.expiresAt;
    }
    proposals.push({
      action: proposal.action as Action,
      kind: proposal.kind as MemoryProposal["kind"],
      ...(content ? { content } : {}),
      ...(typeof targetId === "number" ? { targetId } : {}),
      sourceMessageIds,
      participantIds,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  return proposals;
}

export function eligible(source: Source, now: Date): boolean {
  return (
    source.role === "user" &&
    Number.isSafeInteger(source.userId) &&
    source.userId! > 0 &&
    /^telegram:[1-9][0-9]*:user$/.test(source.sourceKey ?? "") &&
    Number.isSafeInteger(Number(source.sourceKey?.split(":")[1])) &&
    (source.meta?.["turnState"] === "complete" ||
      (source.chatId === source.userId && source.meta?.["turnState"] == null)) &&
    !source.meta?.["forwardOrigin"] &&
    typeof source.userAuthoredContent === "string" &&
    source.userAuthoredContent.trim().length > 0 &&
    source.userAuthoredContent.length <= MAX_CHARS_PER_MESSAGE &&
    source.createdAt.getTime() <= now.getTime() - STABLE_AGE_MS
  );
}

export function selectStableConsolidationBatch(window: readonly Source[], now: Date): Source[] {
  const chatId = window[0]?.chatId;
  if (chatId === undefined) return [];
  const stop = window.findIndex(
    (row) =>
      row.chatId !== chatId ||
      row.createdAt.getTime() > now.getTime() - STABLE_AGE_MS ||
      (row.meta?.["turnState"] === "pending" &&
        row.createdAt.getTime() > now.getTime() - STALE_PENDING_AGE_MS),
  );
  // Stale pending rows are included only to let the cursor pass them. eligible()
  // still excludes them from model input, even when later rows are complete.
  return stop === -1 ? [...window] : window.slice(0, stop);
}

export function consolidationSourceScope(
  sources: readonly Source[],
  participantIds: readonly number[],
  privacyMode: UserPrivacyMode = "normal",
  kind?: MemoryProposal["kind"],
) {
  const first = sources[0];
  if (!first) throw new Error("Missing consolidation source");
  const isPrivate = participantIds.length === 1 && first.chatId === participantIds[0];
  const personal =
    isPrivate ||
    (first.chatId < 0 &&
      privacyMode === "normal" &&
      participantIds.length === 1 &&
      (kind === "fact" || kind === "preference"));
  return {
    isPrivate,
    telegramId: personal ? participantIds[0]! : null,
    scopeChatId: personal && includesUnscopedPersonalMemories(privacyMode) ? null : first.chatId,
    sourceChatId: first.chatId,
    sourceMessageId: Number(first.sourceKey!.split(":")[1]),
    sourceUserId: first.userId!,
  };
}

/** Opted-out authors, and isolated authors outside their private chat, never feed consolidation. */
function privacyExcludesSource(
  modes: ReadonlyMap<number, UserPrivacyMode>,
  source: Source,
): boolean {
  const mode = modes.get(source.userId!);
  return mode === "off" || (mode === "isolated" && source.chatId !== source.userId);
}

export function resolveConsolidationModel(config: AiConfigStored, runtime: AiConfigRuntime | null) {
  const override = config.botMemoryConfig?.consolidation;
  const provider = override?.providerId
    ? runtime?.providers.find((item) => item.id === override.providerId)
    : runtime?.activeProvider;
  if (!provider) throw new MemoryReviewError("Configured consolidation provider unavailable", 503);
  const modelId = override?.providerId
    ? override.modelId || provider.defaultModel
    : (runtime?.config.activeProviderId === provider.id && runtime.config.activeModelId) ||
      provider.defaultModel ||
      runtime?.config.model;
  if (
    !modelId ||
    (override?.modelId &&
      (!override.providerId ||
        (provider.defaultModel !== modelId &&
          !provider.models?.some((model) => model.id === modelId))))
  ) {
    throw new MemoryReviewError("Configured consolidation model unavailable", 503);
  }
  return { provider, modelId };
}

export class MemoryConsolidator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentTick: Promise<void> | null = null;
  private closing = false;
  private readonly reviews = new Set<Promise<MemoryReviewResult>>();
  private closeTask?: Promise<void>;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly encryptionKey: string,
    private readonly usage: UsageGovernancePort,
    private readonly memoryWriter: Pick<BotMemoryWriter, "refreshEmbeddings">,
    private readonly callModel: (
      config: AiConfigStored,
      prompt: string,
      encryptionKey: string,
      signal: AbortSignal,
    ) => Promise<ModelResponse> = MemoryConsolidator.generate,
  ) {}

  start(): void {
    if (this.closing || this.timer) return;
    const run = () => {
      void this.tick().catch((error) => {
        this.logger.error({ error }, "Memory consolidation tick failed");
      });
    };
    this.timer = setInterval(run, INTERVAL_MS);
    this.timer.unref();
    run();
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.stop();
    this.closeTask = Promise.all([
      this.currentTick,
      ...Array.from(this.reviews, (task) => task.catch(() => undefined)),
    ]).then(() => undefined);
    return this.closeTask;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getHandle() {
    return this.timer;
  }
  getIntervalMs() {
    return INTERVAL_MS;
  }

  tick(): Promise<void> {
    if (this.closing || this.currentTick) return Promise.resolve();
    const task = this.runTick().finally(() => {
      if (this.currentTick === task) this.currentTick = null;
    });
    this.currentTick = task;
    return task;
  }

  private async runTick(): Promise<void> {
    const interval = sql`make_interval(hours => coalesce((${bots.aiConfig} #>> '{botMemoryConfig,consolidation,intervalHours}')::int, 12))`;
    const active = await this.db
      .select({ id: bots.id, config: bots.aiConfig })
      .from(bots)
      .leftJoin(memoryConsolidationState, eq(memoryConsolidationState.botId, bots.id))
      .where(
        and(
          eq(bots.isActive, true),
          eq(bots.platform, "telegram"),
          sql`${bots.aiConfig}::jsonb @> '{"enabled":true,"botMemoryConfig":{"enabled":true}}'::jsonb`,
          sql`coalesce(${bots.aiConfig} #>> '{botMemoryConfig,consolidation,enabled}', 'true') = 'true'`,
          or(
            isNull(memoryConsolidationState.lastScheduledAt),
            sql`${memoryConsolidationState.lastScheduledAt} <= timezone('UTC', now()) - ${interval}`,
          ),
          or(
            isNull(memoryConsolidationState.leaseUntil),
            lt(memoryConsolidationState.leaseUntil, new Date()),
          ),
        ),
      )
      .orderBy(sql`coalesce(${memoryConsolidationState.lastScheduledAt}, timestamp 'epoch')`)
      .limit(MAX_BOTS_PER_TICK);
    for (const bot of active) {
      if (this.closing) break;
      try {
        await this.processBot(bot.id, bot.config);
      } catch (error) {
        this.logger.error({ error, botId: bot.id }, "Memory consolidation failed");
      }
    }
  }

  /** Read-only inventory of old, eligible source batches. It never invokes the model or mutates data. */
  async previewHistoricalBatches(
    botId: string,
    options: { afterMessageId?: number; limit?: number } = {},
  ): Promise<HistoricalBatchPage> {
    const [state] = await this.db
      .select()
      .from(memoryConsolidationState)
      .where(eq(memoryConsolidationState.botId, botId));
    const cursor = state?.cursorMessageId ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 3, 1), 5);
    const scanLimit = limit * MAX_MESSAGES;
    const lookahead = await this.readWindow(
      botId,
      Math.max(options.afterMessageId ?? 0, 0),
      scanLimit + 1,
    );
    const scanned = lookahead.slice(0, scanLimit);
    const now = new Date();
    const eligibleRows = scanned.filter((row) => eligible(row, now));
    const privacyModes = await this.loadPrivacyModes(botId, eligibleRows);
    const rawBatches: Source[][] = [];
    for (const row of scanned) {
      const last = rawBatches.at(-1);
      if (!last || last[0]!.chatId !== row.chatId || last.length >= MAX_MESSAGES) {
        rawBatches.push([row]);
      } else {
        last.push(row);
      }
    }
    const previews: { batch: HistoricalBatchPreview; lastRawId: number }[] = [];
    for (const rawBatch of rawBatches) {
      const candidates = rawBatch.filter((row) => eligible(row, now));
      if (
        !privacyModes ||
        candidates.length === 0 ||
        candidates.some((row) => privacyExcludesSource(privacyModes, row))
      )
        continue;
      const preview: HistoricalBatchPreview = {
        botId,
        cursorMessageId: cursor,
        processed: false,
        chatId: rawBatch[0]!.chatId,
        messageIds: [],
        participantIds: [],
        excerpts: [],
      };
      for (const row of candidates) {
        preview.messageIds.push(row.id);
        if (row.userId && !preview.participantIds.includes(row.userId))
          preview.participantIds.push(row.userId);
        preview.excerpts.push((row.userAuthoredContent ?? "").slice(0, 160));
      }
      previews.push({ batch: preview, lastRawId: rawBatch.at(-1)!.id });
    }
    const visible = previews.slice(0, limit).map(({ batch }) => ({
      ...batch,
      processed: batch.messageIds.every((id) => id <= cursor),
    }));
    const lastVisibleRawId = previews[Math.min(previews.length, limit) - 1]?.lastRawId;
    return {
      data: visible,
      nextAfterMessageId:
        previews.length > limit ||
        lookahead.length > scanLimit ||
        (lastVisibleRawId !== undefined && scanned.at(-1)!.id > lastVisibleRawId)
          ? (lastVisibleRawId ?? scanned.at(-1)?.id ?? null)
          : null,
    };
  }

  private async loadPrivacyModes(
    botId: string,
    sources: readonly Source[],
  ): Promise<Map<number, UserPrivacyMode> | null> {
    const ids = [
      ...new Set(sources.map((row) => row.userId).filter((id): id is number => id != null)),
    ];
    if (ids.length === 0) return new Map();
    const modes = await this.db
      .select({ userId: userPrivacySettings.userId, mode: userPrivacySettings.mode })
      .from(userPrivacySettings)
      .where(and(eq(userPrivacySettings.botId, botId), inArray(userPrivacySettings.userId, ids)));
    const byUser = new Map<number, UserPrivacyMode>(
      ids.map((id) => [id, "normal" as UserPrivacyMode]),
    );
    for (const row of modes) {
      if (row.mode !== "normal" && row.mode !== "isolated" && row.mode !== "off") return null;
      byUser.set(row.userId, row.mode);
    }
    return byUser;
  }

  private async readWindow(
    botId: string,
    afterId: number,
    limit: number,
    range?: ReviewRange,
  ): Promise<Source[]> {
    return this.db
      .select({
        id: conversationMessages.id,
        botId: conversationMessages.botId,
        chatId: conversationMessages.chatId,
        role: conversationMessages.role,
        userId: conversationMessages.userId,
        userAuthoredContent: conversationMessages.userAuthoredContent,
        sourceKey: conversationMessages.sourceKey,
        meta: conversationMessages.meta,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          gt(conversationMessages.id, afterId),
          range && eq(conversationMessages.chatId, range.chatId),
          range && gte(conversationMessages.createdAt, range.start),
          range && lt(conversationMessages.createdAt, range.end),
        ),
      )
      .orderBy(asc(conversationMessages.id))
      .limit(limit);
  }

  review(botId: string, chatId: number, start: Date, end: Date, afterMessageId = 0) {
    if (this.closing) throw new MemoryReviewError("Memory review unavailable", 503);
    const task = this.reviewRange(botId, { chatId, start, end, afterMessageId });
    this.reviews.add(task);
    void task.then(
      () => this.reviews.delete(task),
      () => this.reviews.delete(task),
    );
    return task;
  }

  private async reviewRange(botId: string, range: ReviewRange) {
    const [bot] = await this.db
      .select({ config: bots.aiConfig, isActive: bots.isActive })
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.platform, "telegram")));
    if (!bot?.isActive || !consolidationEnabled(bot.config))
      throw new MemoryReviewError("Memory consolidation disabled", 409);
    return this.processBot(botId, bot.config, range);
  }

  private async processBot(
    botId: string,
    config: AiConfigStored | null,
    range?: ReviewRange,
  ): Promise<MemoryReviewResult> {
    const owner = randomUUID();
    const now = new Date();
    const settings = config?.botMemoryConfig?.consolidation;
    const intervalHours =
      settings?.intervalHours ?? DEFAULT_MEMORY_CONSOLIDATION_CONFIG.intervalHours;
    const maxCalls = settings?.maxCallsPerRun ?? DEFAULT_MEMORY_CONSOLIDATION_CONFIG.maxCallsPerRun;
    const stats: MemoryReviewResult = {
      calls: 0,
      changes: 0,
      inputTokens: 0,
      outputTokens: 0,
      nextAfterMessageId: null,
    };
    const leaseTime = { leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS) };
    const [lease] = await this.db
      .insert(memoryConsolidationState)
      .values({ botId, ...leaseTime, ...(range ? {} : { lastScheduledAt: now }) })
      .onConflictDoUpdate({
        target: memoryConsolidationState.botId,
        set: { ...leaseTime, ...(range ? {} : { lastScheduledAt: now }) },
        setWhere: and(
          or(
            isNull(memoryConsolidationState.leaseUntil),
            lt(memoryConsolidationState.leaseUntil, now),
          ),
          range
            ? undefined
            : or(
                isNull(memoryConsolidationState.lastScheduledAt),
                lt(
                  memoryConsolidationState.lastScheduledAt,
                  new Date(now.getTime() - intervalHours * 3600000),
                ),
              ),
        ),
      })
      .returning();
    if (!lease) {
      if (range) throw new MemoryReviewError("Memory review already running", 409);
      return stats;
    }
    let failure: string | undefined;
    try {
      let after = range?.afterMessageId ?? lease.cursorMessageId;
      // Bound scans even when every window contains only previously processed or ineligible rows.
      for (let i = 0; i < 16 * maxCalls && !this.closing && stats.calls < maxCalls; i++) {
        const next = await this.processBatch(
          botId,
          owner,
          after,
          range,
          lease.groupImpressionsSince,
          stats,
        );
        if (next === null || next <= after) {
          stats.nextAfterMessageId = null;
          break;
        }
        after = next;
        if (range) stats.nextAfterMessageId = after;
      }
      if (
        range &&
        stats.nextAfterMessageId !== null &&
        (await this.readWindow(botId, stats.nextAfterMessageId, 1, range)).length === 0
      )
        stats.nextAfterMessageId = null;
      return stats;
    } catch (error) {
      failure = error instanceof MemoryReviewError ? error.message : "Memory consolidation failed";
      throw error;
    } finally {
      await this.db
        .update(memoryConsolidationState)
        .set({
          leaseOwner: null,
          leaseUntil: null,
          lastRun: {
            ...stats,
            finishedAt: new Date().toISOString(),
            ...(failure ? { error: failure } : {}),
          },
        })
        .where(
          and(
            eq(memoryConsolidationState.botId, botId),
            eq(memoryConsolidationState.leaseOwner, owner),
          ),
        );
    }
  }

  private async processBatch(
    botId: string,
    owner: string,
    after: number,
    range: ReviewRange | undefined,
    groupSince: Date,
    stats: MemoryReviewResult,
  ) {
    const now = new Date();
    const window = await this.readWindow(botId, after, MAX_MESSAGES, range);
    if (window.length === 0) return null;
    const chatId = window[0]!.chatId;
    const stable = range ? window : selectStableConsolidationBatch(window, now);
    const cutoffIndex =
      !range && chatId < 0 && stable[0] && stable[0].createdAt < groupSince
        ? stable.findIndex((row) => row.createdAt >= groupSince)
        : -1;
    const batch = cutoffIndex === -1 ? stable : stable.slice(0, cutoffIndex);
    if (batch.length === 0) return null;
    const candidates = batch.filter((row) => eligible(row, now));
    const privacyModes = await this.loadPrivacyModes(botId, candidates);
    const permitted = privacyModes
      ? candidates.filter((row) => !privacyExcludesSource(privacyModes, row))
      : [];
    const evidence = permitted.length
      ? await this.db
          .select({
            ids: memoryConsolidationEvidence.sourceMessageIds,
            version: memoryConsolidationEvidence.reviewVersion,
          })
          .from(memoryConsolidationEvidence)
          .where(
            and(
              eq(memoryConsolidationEvidence.botId, botId),
              eq(memoryConsolidationEvidence.chatId, chatId),
              arrayOverlaps(
                memoryConsolidationEvidence.sourceMessageIds,
                permitted.map((row) => row.id),
              ),
            ),
          )
      : [];
    const [bot] = await this.db
      .select({ aiConfig: bots.aiConfig, isActive: bots.isActive })
      .from(bots)
      .where(eq(bots.id, botId));
    if (
      !bot?.isActive ||
      !consolidationEnabled(bot.aiConfig) ||
      (!range && bot.aiConfig.botMemoryConfig?.consolidation?.enabled === false)
    )
      throw new MemoryReviewError("Memory consolidation disabled", 409);
    const reviewVersion =
      chatId > 0 ||
      (bot.aiConfig.botMemoryConfig?.consolidation?.groupImpressions !== false &&
        (range || batch[0]!.createdAt >= groupSince))
        ? 2
        : 1;
    const processed = new Set(
      evidence.filter((row) => row.version >= reviewVersion).flatMap((row) => row.ids),
    );
    const legacy = new Set(evidence.filter((row) => row.version < 2).flatMap((row) => row.ids));
    const candidateSources = permitted.filter((row) => !processed.has(row.id));
    if (!privacyModes || !candidateSources.length) {
      const cursor = batch.at(-1)!.id;
      await this.renewLease(botId, owner, range ? null : { after, cursor });
      return cursor;
    }
    const personalSourceIds = new Set(
      reviewVersion === 2 && chatId < 0 ? candidateSources.map((row) => row.id) : [],
    );
    const privateMode = privacyModes.get(chatId) ?? "normal";
    const privateChat = chatId === candidateSources[0]!.userId;
    const existing = await this.db
      .select(memorySnapshotColumns)
      .from(botMemories)
      .where(
        and(
          eq(botMemories.botId, botId),
          eq(botMemories.isActive, true),
          eq(botMemories.origin, "consolidation"),
          or(isNull(botMemories.expiresAt), gt(botMemories.expiresAt, now)),
          privateChat
            ? and(
                eq(botMemories.telegramId, chatId),
                includesUnscopedPersonalMemories(privateMode)
                  ? or(isNull(botMemories.scopeChatId), eq(botMemories.scopeChatId, chatId))
                  : eq(botMemories.scopeChatId, chatId),
              )
            : or(
                and(isNull(botMemories.telegramId), eq(botMemories.scopeChatId, chatId)),
                personalSourceIds.size
                  ? and(
                      isNull(botMemories.scopeChatId),
                      eq(botMemories.sourceChatId, chatId),
                      inArray(
                        botMemories.telegramId,
                        candidateSources
                          .filter((row) => personalSourceIds.has(row.id))
                          .map((row) => row.userId!),
                      ),
                    )
                  : undefined,
              ),
        ),
      )
      .orderBy(desc(botMemories.updatedAt))
      .limit(5);
    const renderPrompt = (sources: readonly Source[]) =>
      JSON.stringify({
        rules: CONSOLIDATION_RULES,
        chatId,
        today: now.toISOString(),
        messages: sources.map((row) => ({
          id: row.id,
          userId: row.userId,
          text: row.userAuthoredContent,
          date: row.createdAt.toISOString(),
          personalCandidate: personalSourceIds.has(row.id),
          personalOnly: legacy.has(row.id),
        })),
        existing: existing.map((memory) => ({
          id: memory.id,
          kind: memory.kind,
          ownerId: memory.telegramId,
          validAt: (memory.factValidAt ?? memory.updatedAt)?.toISOString(),
          content: memory.content.slice(0, 250),
        })),
      });
    const fitted = fitConsolidationBatch(candidateSources, renderPrompt, MAX_INPUT_TOKENS);
    if (fitted.accepted.length === 0 && fitted.firstOverflow) {
      const source = fitted.firstOverflow;
      await this.apply(
        botId,
        owner,
        range ? null : after,
        source.id,
        [source],
        [
          {
            action: "ignore",
            kind: "event",
            sourceMessageIds: [source.id],
            participantIds: [source.userId!],
          },
        ],
        existing,
        privacyModes,
        reviewVersion,
      );
      this.logger.info(
        { botId, chatId, sourceMessageId: source.id },
        "Memory consolidation skipped oversized source",
      );
      return source.id;
    }
    const accepted = fitted.accepted;
    const cursor = fitted.firstOverflow ? accepted.at(-1)!.id : batch.at(-1)!.id;
    const prompt = fitted.prompt!;
    const timeoutMs =
      1000 *
      (bot.aiConfig.botMemoryConfig?.consolidation?.modelTimeoutSeconds ??
        DEFAULT_MEMORY_CONSOLIDATION_CONFIG.modelTimeoutSeconds);
    // Hold ownership through the model deadline without advancing the message cursor.
    await this.renewLease(botId, owner, null, timeoutMs + LEASE_MS);
    const reservation = await this.usage.reserve({
      botId,
      resource: "ai_reply",
      chatKind: chatId > 0 ? "private" : "group",
      chatId,
    });
    if (!reservation.allowed)
      throw new MemoryReviewError("Memory consolidation quota exhausted", 429);
    let response: ModelResponse;
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      stats.calls++;
      response = await this.callModel(bot.aiConfig, prompt, this.encryptionKey, signal);
    } catch (error) {
      const timedOut = signal.aborted;
      this.logger.warn(
        {
          botId,
          timedOut,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : undefined,
          statusCode: APICallError.isInstance(error) ? error.statusCode : undefined,
        },
        "Memory consolidation model call failed",
      );
      await this.usage.refund({
        botId,
        resource: "ai_reply",
        reservationId: reservation.reservationId,
      });
      if (timedOut) throw new MemoryReviewError("Consolidation model request timed out", 503);
      if (error instanceof MemoryReviewError) throw error;
      throw new MemoryReviewError("Consolidation model request failed", 503);
    }
    stats.inputTokens += response.inputTokens;
    stats.outputTokens += response.outputTokens;
    try {
      await this.db.insert(tokenUsage).values({
        botId,
        chatId,
        model: response.model,
        providerId: response.providerId,
        promptTokens: response.inputTokens,
        completionTokens: response.outputTokens,
        totalTokens: response.inputTokens + response.outputTokens,
        trigger: "memory_consolidation",
      });
    } finally {
      await this.usage.settle({
        botId,
        resource: "ai_reply",
        reservationId: reservation.reservationId,
      });
    }
    const proposals = parseMemoryProposals(response.text, accepted, personalSourceIds).filter(
      (p) =>
        p.kind === "fact" ||
        p.kind === "preference" ||
        !p.sourceMessageIds.some((id) => legacy.has(id)),
    );
    const changes = await this.apply(
      botId,
      owner,
      range ? null : after,
      cursor,
      accepted,
      proposals,
      existing,
      privacyModes,
      reviewVersion,
    );
    stats.changes += changes;
    return cursor;
  }

  private async renewLease(
    botId: string,
    owner: string,
    progress: { after: number; cursor: number } | null,
    durationMs = LEASE_MS,
  ): Promise<void> {
    const result = await this.db
      .update(memoryConsolidationState)
      .set({
        ...(progress && { cursorMessageId: progress.cursor }),
        updatedAt: new Date(),
        leaseUntil: new Date(Date.now() + durationMs),
      })
      .where(
        and(
          eq(memoryConsolidationState.botId, botId),
          eq(memoryConsolidationState.leaseOwner, owner),
          progress ? eq(memoryConsolidationState.cursorMessageId, progress.after) : undefined,
          gt(memoryConsolidationState.leaseUntil, new Date()),
        ),
      )
      .returning({ botId: memoryConsolidationState.botId });
    if (result.length !== 1) throw new Error("Memory consolidation lease lost");
  }

  private async apply(
    botId: string,
    owner: string,
    oldCursor: number | null,
    cursor: number,
    sources: Source[],
    proposals: MemoryProposal[],
    snapshots: readonly MemorySnapshot[],
    expectedPrivacyModes: ReadonlyMap<number, UserPrivacyMode>,
    reviewVersion: number,
  ): Promise<number> {
    const committed = await this.db.transaction(async (tx) => {
      const memoryStore = new BotMemoryStore(tx);
      const contentWrites: BotMemory[] = [];
      const [lease] = await tx
        .select()
        .from(memoryConsolidationState)
        .where(
          and(
            eq(memoryConsolidationState.botId, botId),
            eq(memoryConsolidationState.leaseOwner, owner),
            oldCursor === null
              ? undefined
              : eq(memoryConsolidationState.cursorMessageId, oldCursor),
            gt(memoryConsolidationState.leaseUntil, new Date()),
          ),
        )
        .for("update");
      if (!lease) throw new Error("Memory consolidation lease lost");
      const participantIds = [...new Set(sources.map((row) => row.userId!))];
      const { current, privacy } = await lockConsolidationInputs(
        tx,
        botId,
        participantIds,
        sources.map((row) => row.id),
      );
      if (
        current.length !== sources.length ||
        current.some((row) => {
          const source = sources.find((item) => item.id === row.id)!;
          return (
            !eligible(row, new Date()) ||
            row.userId !== source.userId ||
            row.chatId !== source.chatId ||
            row.userAuthoredContent !== source.userAuthoredContent
          );
        })
      )
        throw new Error("Memory consolidation source changed");
      const [bot] = await tx
        .select({ aiConfig: bots.aiConfig, isActive: bots.isActive })
        .from(bots)
        .where(eq(bots.id, botId))
        .for("update");
      if (
        !bot?.isActive ||
        !consolidationEnabled(bot.aiConfig) ||
        (oldCursor !== null && bot.aiConfig.botMemoryConfig?.consolidation?.enabled === false)
      ) {
        throw new Error("Memory consolidation disabled");
      }
      const currentModes = new Map(privacy.map((row) => [row.userId, row.mode]));
      if (
        participantIds.some(
          (id) => (currentModes.get(id) ?? "normal") !== expectedPrivacyModes.get(id),
        )
      ) {
        throw new Error("Memory consolidation privacy changed");
      }
      const covered = new Set<number>();
      let changes = 0;
      for (const proposal of proposals) {
        const selected = sources.filter((row) => proposal.sourceMessageIds.includes(row.id));
        const scope = consolidationSourceScope(
          selected,
          proposal.participantIds,
          expectedPrivacyModes.get(selected[0]!.userId!) ?? "normal",
          proposal.kind,
        );
        const chatId = scope.sourceChatId;
        const personal = proposal.kind === "fact" || proposal.kind === "preference";
        if (
          personal &&
          !scope.isPrivate &&
          (bot.aiConfig.botMemoryConfig?.consolidation?.groupImpressions === false ||
            (oldCursor !== null &&
              selected.some((row) => row.createdAt < lease.groupImpressionsSince)))
        )
          throw new MemoryReviewError("Group impressions disabled", 409);
        const factDate = new Date(Math.max(...selected.map((row) => row.createdAt.getTime())));
        const retentionDays = personal
          ? bot.aiConfig.botMemoryConfig?.consolidation?.retentionDays
          : undefined;
        const expiry = proposal.expiresAt ? new Date(proposal.expiresAt) : null;
        const deadline = retentionDays
          ? new Date(factDate.getTime() + retentionDays * 86400000)
          : null;
        const expiresAt =
          expiry && deadline
            ? new Date(Math.min(expiry.getTime(), deadline.getTime()))
            : (expiry ?? deadline);
        if (expiresAt && expiresAt <= new Date()) continue;
        const ownerId = scope.telegramId;
        let memoryId: number | null = null;
        let evidenceAction = proposal.action;
        if (proposal.action === "add") {
          const defaultDays =
            proposal.kind === "commitment" ? 30 : proposal.kind === "event" ? 180 : 365;
          const effectiveExpiry =
            expiresAt ??
            (personal ? null : new Date(factDate.getTime() + defaultDays * 86_400_000));
          if (effectiveExpiry && effectiveExpiry <= new Date()) continue;
          const category =
            proposal.kind === "event"
              ? "shared_episode"
              : proposal.kind === "commitment"
                ? "open_thread"
                : null;
          // A new statement may confirm an existing impression even after it falls out of the prompt.
          const [duplicate] = await tx
            .select({
              id: botMemories.id,
              lastEvidenceAt:
                sql<Date>`coalesce(${botMemories.factValidAt}, ${botMemories.updatedAt})`.mapWith(
                  botMemories.factValidAt,
                ),
            })
            .from(botMemories)
            .where(
              and(
                eq(botMemories.botId, botId),
                eq(botMemories.origin, "consolidation"),
                eq(botMemories.isActive, true),
                eq(botMemories.kind, proposal.kind),
                eq(botMemories.content, proposal.content!),
                ownerId === null
                  ? isNull(botMemories.telegramId)
                  : eq(botMemories.telegramId, ownerId),
                scope.scopeChatId === null
                  ? isNull(botMemories.scopeChatId)
                  : eq(botMemories.scopeChatId, scope.scopeChatId),
                or(isNull(botMemories.expiresAt), gt(botMemories.expiresAt, new Date())),
              ),
            )
            .limit(1)
            .for("update");
          if (duplicate) {
            if (personal && (!duplicate.lastEvidenceAt || duplicate.lastEvidenceAt < factDate)) {
              await memoryStore.updateMemory(botId, duplicate.id, {
                factValidAt: factDate.toISOString(),
                sourceChatId: scope.sourceChatId,
                sourceMessageId: scope.sourceMessageId,
                sourceUserId: scope.sourceUserId,
                ...(effectiveExpiry ? { expiresAt: effectiveExpiry.toISOString() } : {}),
              });
            }
            memoryId = duplicate.id;
            evidenceAction = "ignore";
          } else {
            const created = await memoryStore.saveMemory(botId, {
              content: proposal.content!,
              ...(category ? { category } : {}),
              kind: proposal.kind,
              ...(ownerId === null ? {} : { telegramId: ownerId }),
              ...(scope.scopeChatId === null ? {} : { scopeChatId: scope.scopeChatId }),
              origin: "consolidation",
              sourceChatId: scope.sourceChatId,
              sourceMessageId: scope.sourceMessageId,
              sourceUserId: scope.sourceUserId,
              factValidAt: factDate.toISOString(),
              ...(effectiveExpiry === null ? {} : { expiresAt: effectiveExpiry.toISOString() }),
            });
            memoryId = created.id;
            contentWrites.push(created);
          }
        } else if (proposal.action === "update" || proposal.action === "retire") {
          const shown = snapshots.find((snapshot) => snapshot.id === proposal.targetId);
          if (!shown) throw new Error("Memory consolidation target was not shown to model");
          const [target] = await tx
            .select(memorySnapshotColumns)
            .from(botMemories)
            .where(
              and(
                eq(botMemories.botId, botId),
                eq(botMemories.id, proposal.targetId!),
                eq(botMemories.isActive, true),
                eq(botMemories.origin, "consolidation"),
                ownerId === null
                  ? isNull(botMemories.telegramId)
                  : eq(botMemories.telegramId, ownerId),
                shown.scopeChatId === null
                  ? isNull(botMemories.scopeChatId)
                  : eq(botMemories.scopeChatId, shown.scopeChatId),
              ),
            )
            .for("update");
          const currentTarget = assertShownMemoryTarget(proposal.targetId!, snapshots, target);
          const lastEvidenceDate = currentTarget.factValidAt ?? currentTarget.updatedAt;
          if (lastEvidenceDate && lastEvidenceDate > factDate) continue;
          if (proposal.action === "retire") {
            if (!(await memoryStore.retireMemory(botId, currentTarget.id))) {
              throw new Error("Memory consolidation target changed");
            }
          } else {
            const updated = await memoryStore.updateMemory(botId, currentTarget.id, {
              content: proposal.content!,
              sourceChatId: scope.sourceChatId,
              sourceMessageId: scope.sourceMessageId,
              sourceUserId: scope.sourceUserId,
              category:
                proposal.kind === "event"
                  ? "shared_episode"
                  : proposal.kind === "commitment"
                    ? "open_thread"
                    : null,
              kind: proposal.kind,
              factValidAt: factDate.toISOString(),
              ...(personal || expiresAt ? { expiresAt: expiresAt?.toISOString() ?? null } : {}),
            });
            if (!updated) throw new Error("Memory consolidation target changed");
            if (updated.content !== currentTarget.content) contentWrites.push(updated);
          }
          memoryId = currentTarget.id;
        }
        for (const id of proposal.sourceMessageIds) covered.add(id);
        if (evidenceAction !== "ignore") changes++;
        await tx.insert(memoryConsolidationEvidence).values({
          reviewVersion,
          botId,
          chatId,
          action: evidenceAction,
          memoryId,
          sourceMessageIds: proposal.sourceMessageIds,
          participantIds: proposal.participantIds,
        });
      }
      const uncovered = sources.filter((row) => !covered.has(row.id));
      if (uncovered.length)
        await tx.insert(memoryConsolidationEvidence).values({
          reviewVersion,
          botId,
          chatId: uncovered[0]!.chatId,
          action: "ignore",
          sourceMessageIds: uncovered.map((row) => row.id),
          participantIds: [...new Set(uncovered.map((row) => row.userId!))],
        });
      await tx
        .update(memoryConsolidationState)
        .set({
          ...(oldCursor === null ? {} : { cursorMessageId: cursor }),
          updatedAt: new Date(),
          leaseUntil: new Date(Date.now() + LEASE_MS),
        })
        .where(
          and(
            eq(memoryConsolidationState.botId, botId),
            eq(memoryConsolidationState.leaseOwner, owner),
          ),
        );
      return { memories: contentWrites, aiConfig: bot.aiConfig, changes };
    });
    await this.memoryWriter.refreshEmbeddings(botId, committed.memories, {
      embeddingTimeoutMs: EMBEDDING_TIMEOUT_MS,
      fallbackEmbedder: () =>
        createBotEmbeddingService(
          toAiConfigRuntime(committed.aiConfig, this.encryptionKey),
          this.logger,
        ),
    });
    return committed.changes;
  }

  private static async generate(
    config: AiConfigStored,
    prompt: string,
    encryptionKey: string,
    signal: AbortSignal,
  ) {
    const { provider, modelId } = resolveConsolidationModel(
      config,
      toAiConfigRuntime(config, encryptionKey),
    );
    const settings = {
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      fetch: createModelFetch(),
    };
    const factory =
      provider.providerFormat === "gemini"
        ? createGoogleGenerativeAI(settings)
        : createOpenAICompatible({ ...settings, name: "custom" });
    const result = await generateText({
      model: factory(modelId),
      maxRetries: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: signal,
      messages: [{ role: "user", content: prompt }],
    });
    return {
      text: result.text,
      model: modelId,
      providerId: provider.id,
      inputTokens: result.usage?.inputTokens ?? countTokens(prompt),
      outputTokens: result.usage?.outputTokens ?? countTokens(result.text),
    };
  }
}
