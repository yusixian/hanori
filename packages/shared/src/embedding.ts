export interface EmbeddingConfig {
  enabled: boolean;
  encryptedApiKey: string;
  baseURL: string;
  model: string;
  dimensions: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  encryptedApiKey: "",
  baseURL: "https://api.openai.com/v1",
  model: "gemini-embedding-2",
  dimensions: 3072,
};

export interface EmbeddingConfigPublic {
  enabled: boolean;
  hasApiKey: boolean;
  baseURL: string;
  model: string;
  dimensions: number;
}
