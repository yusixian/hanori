import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed, embedMany } from "ai";
import type { Logger } from "pino";

const MAX_TEXT_LENGTH = 8000;

interface EmbeddingServiceConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  dimensions: number;
}

export class EmbeddingService {
  private provider;
  private modelId: string;
  private _dimensions: number;
  private logger?: Logger;

  constructor(config: EmbeddingServiceConfig, logger?: Logger) {
    this.provider = createOpenAICompatible({
      name: "embedding",
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
    return this.provider.textEmbeddingModel(this.modelId, {
      dimensions: this._dimensions,
    });
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    try {
      const truncated = text.slice(0, MAX_TEXT_LENGTH);
      const { embedding } = await embed({
        model: this.model,
        value: truncated,
      });
      return embedding;
    } catch (err) {
      this.logger?.warn(err, "Embedding generation failed, degrading gracefully");
      return null;
    }
  }

  async generateEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    try {
      const truncated = texts.map((t) => t.slice(0, MAX_TEXT_LENGTH));
      const { embeddings } = await embedMany({
        model: this.model,
        values: truncated,
      });
      return embeddings;
    } catch (err) {
      this.logger?.warn(err, "Batch embedding generation failed, degrading gracefully");
      return texts.map(() => null);
    }
  }
}
