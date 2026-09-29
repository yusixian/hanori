import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { EMBEDDING_DIMENSIONS } from "@cos-tool-bot/database";
import { embed, embedMany } from "ai";
import type { Logger } from "pino";
import type { AiConfigRuntime } from "./ai-config-runtime.js";

const MAX_TEXT_LENGTH = 8000;

interface EmbeddingServiceConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  dimensions: number;
}

// providerOptions key must match the `name` passed to createOpenAICompatible
const EMBEDDING_PROVIDER_NAME = "embedding";

export class EmbeddingService {
  private provider;
  private modelId: string;
  private _dimensions: number;
  private logger?: Logger;

  constructor(config: EmbeddingServiceConfig, logger?: Logger) {
    this.provider = createOpenAICompatible({
      name: EMBEDDING_PROVIDER_NAME,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    this.modelId = config.model;
    this._dimensions = config.dimensions;
    this.logger = logger;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  private get model() {
    return this.provider.embeddingModel(this.modelId);
  }

  private get embeddingProviderOptions() {
    return { [EMBEDDING_PROVIDER_NAME]: { dimensions: this._dimensions } };
  }

  async generateEmbedding(text: string, abortSignal?: AbortSignal): Promise<number[] | null> {
    try {
      const truncated = text.slice(0, MAX_TEXT_LENGTH);
      const { embedding } = await embed({
        model: this.model,
        value: truncated,
        providerOptions: this.embeddingProviderOptions,
        abortSignal,
      });
      return embedding;
    } catch {
      this.logger?.warn("Embedding generation failed, degrading gracefully");
      return null;
    }
  }

  async generateEmbeddings(
    texts: string[],
    abortSignal?: AbortSignal,
  ): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    try {
      const truncated = texts.map((t) => t.slice(0, MAX_TEXT_LENGTH));
      const { embeddings } = await embedMany({
        model: this.model,
        values: truncated,
        providerOptions: this.embeddingProviderOptions,
        abortSignal,
      });
      return embeddings;
    } catch {
      this.logger?.warn("Batch embedding generation failed, degrading gracefully");
      return texts.map(() => null);
    }
  }
}

/** The Bot's embedder, or undefined when embeddings are off or the stored key is unusable. */
export function createBotEmbeddingService(
  runtime: Pick<AiConfigRuntime, "config" | "embeddingApiKey"> | null,
  logger?: Logger,
): EmbeddingService | undefined {
  const config = runtime?.config.embeddingConfig;
  const apiKey = runtime?.embeddingApiKey;
  if (!config || !apiKey) return undefined;
  return new EmbeddingService(
    { apiKey, baseURL: config.baseURL, model: config.model, dimensions: EMBEDDING_DIMENSIONS },
    logger,
  );
}
