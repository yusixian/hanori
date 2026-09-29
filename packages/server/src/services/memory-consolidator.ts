import { randomUUID } from "node:crypto";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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
import { includesUnscopedPersonalMemories } from "@cos-tool-bot/shared";
import { generateText } from "ai";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { countTokens } from "gpt-tokenizer";
import type { Logger } from "pino";
import { toAiConfigRuntime } from "./ai-config-runtime.js";
import { BotMemoryStore } from "./bot-memory-store.js";
import type { BotMemoryWriter } from "./bot-memory-writer.js";
import { createBotEmbeddingService } from "./embedding-service.js";

const INTERVAL_MS = 15 * 60_000;
const LEASE_MS = 90_000;
const MODEL_TIMEOUT_MS = 25_000;
const STABLE_AGE_MS = 5 * 60_000;
const STALE_PENDING_AGE_MS = 24 * 60 * 60_000;
const MAX_MESSAGES = 12;
const MAX_CHARS_PER_MESSAGE = 1_000;
const MAX_INPUT_TOKENS = 4_000;
const MAX_OUTPUT_TOKENS = 700;
const MAX_PROPOSALS = 3;
const MAX_BOTS_PER_TICK = 2;

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

export function parseMemoryProposals(text: string, sources: readonly Source[]): MemoryProposal[] {
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
    // Group conversation can only create chat-scoped continuity, never an individual profile fact.
    if (
      !(participantIds.length === 1 && chatId === participantIds[0]) &&
      !["event", "commitment", "relationship"].includes(proposal.kind as string)
    ) {
      throw new Error("Group profile inference denied");
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
) {
  const first = sources[0];
  if (!first) throw new Error("Missing consolidation source");
  const isPrivate = participantIds.length === 1 && first.chatId === participantIds[0];
  return {
    isPrivate,
    telegramId: isPrivate ? participantIds[0]! : null,
    scopeChatId: isPrivate && includesUnscopedPersonalMemories(privacyMode) ? null : first.chatId,
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

export class MemoryConsolidator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

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
    ) => Promise<ModelResponse> = MemoryConsolidator.generate,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    void this.tick();
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

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const active = await this.db
        .select({ id: bots.id })
        .from(bots)
        .leftJoin(memoryConsolidationState, eq(memoryConsolidationState.botId, bots.id))
        .where(eq(bots.isActive, true))
        .orderBy(sql`coalesce(${memoryConsolidationState.updatedAt}, timestamp 'epoch')`)
        .limit(MAX_BOTS_PER_TICK);
      for (const bot of active) {
        try {
          await this.processBot(bot.id);
        } catch (error) {
          this.logger.error({ error, botId: bot.id }, "Memory consolidation failed");
        }
      }
    } finally {
      this.running = false;
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

  private async privacyModesForSources(
    botId: string,
    sources: readonly Source[],
  ): Promise<Map<number, UserPrivacyMode> | null> {
    const byUser = await this.loadPrivacyModes(botId, sources);
    if (!byUser || sources.some((source) => privacyExcludesSource(byUser, source))) return null;
    return byUser;
  }

  private async readWindow(botId: string, afterId: number, limit: number): Promise<Source[]> {
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
      .where(and(eq(conversationMessages.botId, botId), gt(conversationMessages.id, afterId)))
      .orderBy(asc(conversationMessages.id))
      .limit(limit);
  }

  private async processBot(botId: string): Promise<void> {
    const owner = randomUUID();
    const now = new Date();
    const [lease] = await this.db
      .insert(memoryConsolidationState)
      .values({ botId, leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS) })
      .onConflictDoUpdate({
        target: memoryConsolidationState.botId,
        set: { leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now },
        setWhere: or(
          isNull(memoryConsolidationState.leaseUntil),
          lt(memoryConsolidationState.leaseUntil, now),
        ),
      })
      .returning();
    if (!lease) return;
    try {
      const window = await this.readWindow(botId, lease.cursorMessageId, MAX_MESSAGES);
      if (window.length === 0) return;
      const chatId = window[0]!.chatId;
      const batch = selectStableConsolidationBatch(window, now);
      if (batch.length === 0) return;
      const candidateSources = batch.filter((row) => eligible(row, now));
      if (candidateSources.length === 0) {
        await this.advance(botId, owner, lease.cursorMessageId, batch.at(-1)!.id);
        return;
      }
      const privacyModes = await this.privacyModesForSources(botId, candidateSources);
      if (!privacyModes) {
        await this.advance(botId, owner, lease.cursorMessageId, batch.at(-1)!.id);
        return;
      }
      const [bot] = await this.db
        .select({ aiConfig: bots.aiConfig, isActive: bots.isActive })
        .from(bots)
        .where(eq(bots.id, botId));
      if (!bot?.isActive || !consolidationEnabled(bot.aiConfig)) return;
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
              : and(isNull(botMemories.telegramId), eq(botMemories.scopeChatId, chatId)),
          ),
        )
        .orderBy(desc(botMemories.updatedAt))
        .limit(5);
      const renderPrompt = (sources: readonly Source[]) =>
        JSON.stringify({
          rules:
            "Return only JSON array, at most 3 entries. Actions: add/update/retire/ignore. Each entry: action, kind, content if add/update, targetId if update/retire, sourceMessageIds, participantIds, optional expiresAt ISO. Use only explicit source statements. Use event for a shared episode and commitment for an explicitly unfinished thread or follow-up. Group chats: only shared event/commitment/relationship in this chat, never personal facts. Avoid secrets, sensitive data and speculative facts. Prefer ignore. Do not claim a task was completed unless explicit. Existing targets may only be changed when evidence directly contradicts them.",
          chatId,
          messages: sources.map((row) => ({
            id: row.id,
            userId: row.userId,
            text: row.userAuthoredContent,
          })),
          existing: existing.map((memory) => ({
            id: memory.id,
            kind: memory.kind,
            content: memory.content.slice(0, 250),
          })),
        });
      const fitted = fitConsolidationBatch(candidateSources, renderPrompt, MAX_INPUT_TOKENS);
      if (fitted.accepted.length === 0 && fitted.firstOverflow) {
        const source = fitted.firstOverflow;
        await this.apply(
          botId,
          owner,
          lease.cursorMessageId,
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
        );
        this.logger.info(
          { botId, chatId, sourceMessageId: source.id },
          "Memory consolidation skipped oversized source",
        );
        return;
      }
      const accepted = fitted.accepted;
      const cursor = fitted.firstOverflow ? accepted.at(-1)!.id : batch.at(-1)!.id;
      const prompt = fitted.prompt!;
      const reservation = await this.usage.reserve({
        botId,
        resource: "ai_reply",
        chatKind: chatId > 0 ? "private" : "group",
        chatId,
      });
      if (!reservation.allowed) return;
      let response: ModelResponse;
      try {
        response = await this.callModel(bot.aiConfig, prompt, this.encryptionKey);
      } catch (error) {
        await this.usage.refund({
          botId,
          resource: "ai_reply",
          reservationId: reservation.reservationId,
        });
        throw error;
      }
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
      const proposals = parseMemoryProposals(response.text, accepted);
      await this.apply(
        botId,
        owner,
        lease.cursorMessageId,
        cursor,
        accepted,
        proposals,
        existing,
        privacyModes,
      );
    } finally {
      await this.db
        .update(memoryConsolidationState)
        .set({ leaseOwner: null, leaseUntil: null })
        .where(
          and(
            eq(memoryConsolidationState.botId, botId),
            eq(memoryConsolidationState.leaseOwner, owner),
          ),
        );
    }
  }

  private async advance(
    botId: string,
    owner: string,
    oldCursor: number,
    cursor: number,
  ): Promise<void> {
    const result = await this.db
      .update(memoryConsolidationState)
      .set({ cursorMessageId: cursor, updatedAt: new Date() })
      .where(
        and(
          eq(memoryConsolidationState.botId, botId),
          eq(memoryConsolidationState.leaseOwner, owner),
          eq(memoryConsolidationState.cursorMessageId, oldCursor),
          gt(memoryConsolidationState.leaseUntil, new Date()),
        ),
      )
      .returning({ botId: memoryConsolidationState.botId });
    if (result.length !== 1) throw new Error("Memory consolidation lease lost");
  }

  private async apply(
    botId: string,
    owner: string,
    oldCursor: number,
    cursor: number,
    sources: Source[],
    proposals: MemoryProposal[],
    snapshots: readonly MemorySnapshot[],
    expectedPrivacyModes: ReadonlyMap<number, UserPrivacyMode>,
  ): Promise<void> {
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
            eq(memoryConsolidationState.cursorMessageId, oldCursor),
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
      if (!bot?.isActive || !consolidationEnabled(bot.aiConfig)) {
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
      for (const proposal of proposals) {
        const selected = sources.filter((row) => proposal.sourceMessageIds.includes(row.id));
        const scope = consolidationSourceScope(
          selected,
          proposal.participantIds,
          expectedPrivacyModes.get(selected[0]!.userId!) ?? "normal",
        );
        const chatId = scope.sourceChatId;
        const isPrivate = scope.isPrivate;
        const ownerId = scope.telegramId;
        let memoryId: number | null = null;
        if (proposal.action === "add") {
          const defaultDays =
            proposal.kind === "commitment" ? 30 : proposal.kind === "event" ? 180 : 365;
          const expiresAt = proposal.expiresAt
            ? new Date(proposal.expiresAt)
            : isPrivate && (proposal.kind === "fact" || proposal.kind === "preference")
              ? null
              : new Date(Date.now() + defaultDays * 86_400_000);
          const category =
            proposal.kind === "event"
              ? "shared_episode"
              : proposal.kind === "commitment"
                ? "open_thread"
                : null;
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
            ...(expiresAt === null ? {} : { expiresAt: expiresAt.toISOString() }),
          });
          memoryId = created.id;
          contentWrites.push(created);
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
              ...(proposal.expiresAt ? { expiresAt: proposal.expiresAt } : {}),
            });
            if (!updated) throw new Error("Memory consolidation target changed");
            if (updated.content !== currentTarget.content) contentWrites.push(updated);
          }
          memoryId = currentTarget.id;
        }
        await tx.insert(memoryConsolidationEvidence).values({
          botId,
          chatId,
          action: proposal.action,
          memoryId,
          sourceMessageIds: proposal.sourceMessageIds,
          participantIds: proposal.participantIds,
        });
      }
      await tx
        .update(memoryConsolidationState)
        .set({ cursorMessageId: cursor, updatedAt: new Date() })
        .where(
          and(
            eq(memoryConsolidationState.botId, botId),
            eq(memoryConsolidationState.leaseOwner, owner),
          ),
        );
      return { memories: contentWrites, aiConfig: bot.aiConfig };
    });
    await this.memoryWriter.refreshEmbeddings(botId, committed.memories, {
      embeddingTimeoutMs: MODEL_TIMEOUT_MS,
      fallbackEmbedder: () =>
        createBotEmbeddingService(
          toAiConfigRuntime(committed.aiConfig, this.encryptionKey),
          this.logger,
        ),
    });
  }

  private static async generate(config: AiConfigStored, prompt: string, encryptionKey: string) {
    const runtime = toAiConfigRuntime(config, encryptionKey);
    const provider = runtime?.activeProvider;
    if (!provider) throw new Error("No configured consolidation provider");
    const modelId = provider.defaultModel || runtime!.config.model;
    const factory =
      provider.providerFormat === "gemini"
        ? createGoogleGenerativeAI({ baseURL: provider.baseURL, apiKey: provider.apiKey })
        : createOpenAICompatible({
            name: "custom",
            baseURL: provider.baseURL,
            apiKey: provider.apiKey,
          });
    const result = await generateText({
      model: factory(modelId),
      temperature: 0.2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
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
