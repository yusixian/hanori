import type { BotMemory } from "@cos-tool-bot/shared";
import type { BotMemoryStore } from "./bot-memory-store.js";
import type { EmbeddingService } from "./embedding-service.js";

interface PromptMemorySelectorInput {
  botId: string;
  query?: string;
  telegramId?: number;
  scopeChatId?: number;
  includeUnscopedPersonal?: boolean;
  limit: number;
  store: Pick<BotMemoryStore, "getMemoriesForPrompt" | "recallMemories">;
  embeddingService?: Pick<EmbeddingService, "generateEmbedding">;
}

export const PROMPT_MEMORY_EMBEDDING_TIMEOUT_MS = 10_000;
// Broader than the 0.15 near-duplicate cutoff, while excluding weak semantic noise.
export const PROMPT_MEMORY_MAX_COSINE_DISTANCE = 0.35;

async function generateEmbeddingWithTimeout(
  service: Pick<EmbeddingService, "generateEmbedding">,
  query: string,
): Promise<number[] | null> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, PROMPT_MEMORY_EMBEDDING_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      service.generateEmbedding(query, controller.signal).catch(() => null),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function selectMemoriesForPrompt(
  input: PromptMemorySelectorInput,
): Promise<BotMemory[]> {
  const query = input.query?.trim();
  if (!query) {
    return input.store.getMemoriesForPrompt(input.botId, {
      telegramId: input.telegramId,
      ...(input.scopeChatId === undefined ? {} : { scopeChatId: input.scopeChatId }),
      ...(input.includeUnscopedPersonal === undefined
        ? {}
        : { includeUnscopedPersonal: input.includeUnscopedPersonal }),
      limit: input.limit,
    });
  }

  let queryEmbedding: number[] | undefined;
  if (input.embeddingService) {
    const embedding = await generateEmbeddingWithTimeout(input.embeddingService, query);
    if (embedding?.length) queryEmbedding = embedding;
  }

  const memories = await input.store.recallMemories(input.botId, {
    query,
    telegramId: input.telegramId,
    ...(input.scopeChatId === undefined ? {} : { scopeChatId: input.scopeChatId }),
    ...(input.includeUnscopedPersonal === undefined
      ? {}
      : { includeUnscopedPersonal: input.includeUnscopedPersonal }),
    scope: input.telegramId == null ? "general_only" : "all",
    limit: input.limit,
    queryEmbedding,
    maxDistance: PROMPT_MEMORY_MAX_COSINE_DISTANCE,
  });
  if (memories.length > 0 || queryEmbedding) return memories;

  return input.store.getMemoriesForPrompt(input.botId, {
    telegramId: input.telegramId,
    ...(input.scopeChatId === undefined ? {} : { scopeChatId: input.scopeChatId }),
    ...(input.includeUnscopedPersonal === undefined
      ? {}
      : { includeUnscopedPersonal: input.includeUnscopedPersonal }),
    limit: input.limit,
  });
}
