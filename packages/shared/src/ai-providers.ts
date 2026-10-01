export type ModelCapability =
  | "vision"
  | "tool_calling"
  | "web_search"
  | "reasoning"
  | "long_context"
  | "code";

export interface ModelEntry {
  id: string;
  label?: string;
  capabilities?: ModelCapability[];
  temperature?: number;
  maxTokens?: number;
  thinking?: "enabled" | "disabled";
  thinkingBudget?: number;
}

export interface AiProviderEntry {
  id: string;
  label: string;
  encryptedApiKey: string | null;
  baseURL: string;
  /** Relative model discovery path. Undefined preserves the legacy `/models` behavior. */
  modelDiscoveryPath?: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  models?: ModelEntry[];
  /** Model IDs explicitly removed by the owner; discovery must not add them back. */
  excludedModelIds?: string[];
}

export interface AiProviderEntryPublic {
  id: string;
  label: string;
  hasApiKey: boolean;
  baseURL: string;
  /** Relative model discovery path. Undefined preserves the legacy `/models` behavior. */
  modelDiscoveryPath?: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  models?: ModelEntry[];
  excludedModelIds?: string[];
}
