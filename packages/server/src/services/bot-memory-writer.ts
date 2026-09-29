import type { BotMemory, BotMemoryAccess } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import type { BotMemoryStore } from "./bot-memory-store.js";
import type { EmbeddingService } from "./embedding-service.js";

// Cosine distances: candidates come from DEDUP_SIMILAR; a duplicate is closer than DEDUP_EXACT
// and has the same text.
const DEDUP_EXACT = 0.05;
const DEDUP_SIMILAR = 0.15;

/** Resolves to null (never rejects) when a vector cannot be produced. */
export type MemoryEmbedder = Pick<EmbeddingService, "generateEmbedding" | "generateEmbeddings">;

/** Looked up on every write; undefined means the Bot currently has no embedder. */
export type MemoryEmbedderResolver = (botId: string) => MemoryEmbedder | undefined;

export type NewBotMemory = Omit<Parameters<BotMemoryStore["saveMemory"]>[1], "embedding">;
export type BotMemoryChanges = Parameters<BotMemoryStore["updateMemory"]>[2];

type WriterStore = Pick<
  BotMemoryStore,
  | "findSimilar"
  | "getMemory"
  | "saveMemory"
  | "touchMemory"
  | "updateEmbeddingIfContentMatches"
  | "updateMemory"
>;

interface EmbeddingOptions {
  /** Bounds each embedding request; database writes are not bounded by it. */
  embeddingTimeoutMs: number;
}

interface EmbeddedContent {
  content: string;
  embedding: number[];
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/** Database errors carry query parameters, which include memory content; log only a code. */
function loggableErrorCode(error: unknown): string {
  const source = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const code =
    typeof source === "object" && source !== null && "code" in source ? source.code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return error instanceof Error && /^[A-Za-z]\w{0,63}$/.test(error.name) ? error.name : "Unknown";
}

/**
 * The write path for memory content: a stored vector always describes the memory's current
 * content. Vectors are best-effort. Without an embedder, or when embedding yields nothing, the
 * text is still written without a vector, so vector recall and dedup skip the memory until a
 * later content write or the backfill script embeds it. A failed vector write never fails the
 * text write; it is logged by memory id and error code.
 */
export class BotMemoryWriter {
  constructor(
    private readonly store: WriterStore,
    private readonly resolveEmbedder: MemoryEmbedderResolver,
    private readonly logger: Pick<Logger, "info" | "warn">,
  ) {}

  /**
   * Inserts a memory together with its vector. With `dedup`, an active memory with the same
   * text in exactly the same owner and chat scope is touched and returned instead. Dedup needs
   * a vector, so without one the memory is always inserted.
   */
  async create(
    botId: string,
    memory: NewBotMemory,
    options: EmbeddingOptions & { dedup?: boolean },
  ): Promise<BotMemory> {
    const embedding =
      (await this.resolveEmbedder(botId)?.generateEmbedding(
        memory.content,
        AbortSignal.timeout(options.embeddingTimeoutMs),
      )) ?? undefined;
    if (embedding && options.dedup) {
      const similar = await this.store.findSimilar(botId, embedding, DEDUP_SIMILAR, {
        telegramId: memory.telegramId,
        scopeChatId: memory.scopeChatId,
      });
      const duplicate = similar.find(
        (candidate) =>
          candidate.distance < DEDUP_EXACT && sameText(candidate.content, memory.content),
      );
      if (duplicate) {
        await this.store.touchMemory(duplicate.id);
        return duplicate;
      }
    }
    return this.store.saveMemory(botId, { ...memory, embedding });
  }

  /**
   * Applies `changes`. When they replace the stored content, the new content is embedded before
   * the update and its vector stored right after it, so the memory is vectorless only between
   * the two writes; a rejected update may therefore spend one embedding. Returns null when the
   * memory is missing, inactive, outside `access`, or fails an `expected*` guard.
   */
  async update(
    botId: string,
    memoryId: number,
    changes: BotMemoryChanges,
    options: EmbeddingOptions & { access?: BotMemoryAccess },
  ): Promise<BotMemory | null> {
    const replacement = await this.embedReplacedContent(botId, memoryId, changes, options);
    const updated = await this.store.updateMemory(botId, memoryId, changes, options.access);
    if (updated && replacement) {
      await this.storeEmbeddings(botId, [{ id: memoryId, ...replacement }]);
    }
    return updated;
  }

  /**
   * For batch writers, after their transaction commits: embeds each memory's content and stores
   * the vector only while that memory is active and still holds exactly this content, so a
   * concurrent edit never receives a stale vector. Uses the resolver's embedder, else
   * `fallbackEmbedder`; with neither, logs one info line for the batch. Never throws.
   */
  async refreshEmbeddings(
    botId: string,
    memories: readonly Pick<BotMemory, "id" | "content">[],
    options: EmbeddingOptions & { fallbackEmbedder?: () => MemoryEmbedder | undefined },
  ): Promise<void> {
    if (memories.length === 0) return;
    let embeddings: (number[] | null)[];
    try {
      const embedder = this.resolveEmbedder(botId) ?? options.fallbackEmbedder?.();
      if (!embedder) {
        this.logger.info(
          { botId, count: memories.length },
          "No embedder for this Bot; memories kept without vectors",
        );
        return;
      }
      embeddings = await embedder.generateEmbeddings(
        memories.map((memory) => memory.content),
        AbortSignal.timeout(options.embeddingTimeoutMs),
      );
    } catch (error) {
      this.warnVectorsMissing(
        botId,
        memories.map((memory) => memory.id),
        [error],
      );
      return;
    }
    await this.storeEmbeddings(
      botId,
      memories.flatMap((memory, index) => {
        const embedding = embeddings[index];
        return embedding ? [{ id: memory.id, content: memory.content, embedding }] : [];
      }),
    );
  }

  /**
   * Embeds `changes.content` only when it replaces the stored content. An update that passes its
   * `expectedContent` guard proves the prior content, so only unguarded edits read the row first.
   */
  private async embedReplacedContent(
    botId: string,
    memoryId: number,
    changes: BotMemoryChanges,
    options: EmbeddingOptions,
  ): Promise<EmbeddedContent | undefined> {
    const content = changes.content;
    const embedder = content === undefined ? undefined : this.resolveEmbedder(botId);
    if (content === undefined || !embedder) return undefined;
    const previous =
      changes.expectedContent ?? (await this.store.getMemory(botId, memoryId))?.content;
    if (previous === undefined || previous === content) return undefined;
    const embedding = await embedder.generateEmbedding(
      content,
      AbortSignal.timeout(options.embeddingTimeoutMs),
    );
    return embedding ? { content, embedding } : undefined;
  }

  /** Each write is independent, so one failure does not discard the other vectors. */
  private async storeEmbeddings(
    botId: string,
    memories: readonly (EmbeddedContent & { id: number })[],
  ): Promise<void> {
    const failedIds: number[] = [];
    const errors: unknown[] = [];
    for (const memory of memories) {
      try {
        await this.store.updateEmbeddingIfContentMatches(
          botId,
          memory.id,
          memory.content,
          memory.embedding,
        );
      } catch (error) {
        failedIds.push(memory.id);
        errors.push(error);
      }
    }
    if (failedIds.length > 0) this.warnVectorsMissing(botId, failedIds, errors);
  }

  private warnVectorsMissing(botId: string, memoryIds: number[], errors: unknown[]): void {
    this.logger.warn(
      { botId, memoryIds, errorCodes: [...new Set(errors.map(loggableErrorCode))] },
      "Memory embedding refresh failed; text kept without a vector",
    );
  }
}
