import type { AgentExecutionConfig } from "./scheduled-tasks.js";
import type { AiExecutionConfig, TimeoutConfig } from "./ai-execution.js";
import type { AiProviderEntry, AiProviderEntryPublic, ModelEntry } from "./ai-providers.js";
import type {
  AgentToolsConfig,
  ArtworkToolsConfig,
  WebToolsConfig,
  WebToolsConfigPublic,
} from "./ai-tools.js";
import type { ConversationConfig } from "./conversation.js";
import type { EmbeddingConfig, EmbeddingConfigPublic } from "./embedding.js";
import type {
  EngagementConfigStored,
  EngagementConfigPublic,
  EngagementPolicy,
} from "./engagement.js";
import type { GitHubToolsConfigPublic, GitHubToolsConfigStored } from "./github.js";
import type { ImageOcrConfig } from "./image-ocr.js";
import type { ImageGenerationReceiptConfig } from "./image-receipt.js";
import type { BotMemoryConfig, MemoryConfig } from "./memory.js";
import type { MessageConfig } from "./message-config.js";
import type { BotSkillConfigStored } from "./skills.js";
import type { SummaryConfigStored } from "./summary.js";

export interface DataFilesInjectionConfig {
  injectableFiles: string[];
  maxTotalSize: number;
}

export const DEFAULT_INJECTABLE_FILES = ["IDENTITY.md", "SOUL.md"];
export const DEFAULT_MAX_INJECTION_SIZE = 256 * 1024;

export interface AiTriggerConfig {
  replyToBot: boolean;
  mentionBot: boolean;
  triggerWords: string[];
  randomReplyPercent: number;
  randomReplyCooldown: number;
}

export interface ModelRecoveryConfig {
  /** Shared additional same-model attempts across one conversational turn (0–2). */
  maxRetries: number;
  fallback: { providerId: string; modelId: string } | null;
}

export const DEFAULT_MODEL_RECOVERY: ModelRecoveryConfig = { maxRetries: 1, fallback: null };

export interface AiGroupOverride {
  /** Missing means inherit the global policy. */
  modelRecovery?: ModelRecoveryConfig;
  engagement?: Partial<EngagementPolicy>;
  chatId: number;
  chatTitle?: string;
  enabled?: boolean;
  whitelisted: boolean;
  systemPrompt?: string;
  triggerConfig?: Partial<AiTriggerConfig>;
  conversationEnabled?: boolean;
  maxContextMessages?: number;
  groupHistoryMaxTokens?: number;
  imageGenerationEnabled?: boolean;
  imageGenerationConfirmation?: "always" | "never";
  /** Controls whether safe Provider/model labels are exposed in the Mini App. */
  aiSelectionDisplay?: "inherit" | "show" | "hide";
}

export interface AiConfigStored {
  modelRecovery?: ModelRecoveryConfig;
  engagement?: EngagementConfigStored;
  enabled: boolean;
  /** @deprecated migrated into providers[0].encryptedApiKey — kept for rollback compat */
  encryptedApiKey: string | null;
  /** @deprecated migrated into providers[0].baseURL */
  baseURL: string;
  /** @deprecated migrated into providers[0].defaultModel */
  model: string;
  /** @deprecated migrated into providers[0].providerFormat */
  providerFormat?: "openai" | "gemini";
  providers?: AiProviderEntry[];
  activeProviderId?: string;
  /** Selected global model. Missing values inherit the active Provider default. */
  activeModelId?: string;
  /** Safe Provider/model labels are visible to authorized readers by default. */
  aiSelectionDisplayDefault?: "show" | "hide";
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  conversationConfig?: ConversationConfig;
  memoryConfig?: MemoryConfig;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  /** Defaults to true; false restores the legacy individual search tools. */
  unifiedSearchEnabled?: boolean;
  imageGenerationReceiptConfig?: ImageGenerationReceiptConfig;
  imageGenerationConfirmation?: "always" | "never";
  agentToolsConfig?: AgentToolsConfig;
  /** Task defaults are resolved fresh for each run; explicit task fields override them. */
  taskAgentConfig?: AgentExecutionConfig;
  githubToolsConfig?: GitHubToolsConfigStored;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  executionConfig?: AiExecutionConfig;
  /** @deprecated migrated into providers[0].models */
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  embeddingConfig?: EmbeddingConfig;
  dataFilesConfig?: DataFilesInjectionConfig;
  privateChatAccess?: "all" | "admin" | "allowlist";
  privateChatWhitelist?: number[];
  timeoutConfig?: TimeoutConfig;
  mcpServerIds?: number[];
  summaryConfig?: SummaryConfigStored;
  imageOcrConfig?: ImageOcrConfig;
  skillConfig?: BotSkillConfigStored;
}

export interface AiConfigPublic {
  modelRecovery?: ModelRecoveryConfig;
  engagement?: EngagementConfigPublic;
  enabled: boolean;
  /** @deprecated reflects providers[activeProviderId].hasApiKey for backward compat */
  hasApiKey: boolean;
  /** @deprecated reflects providers[activeProviderId].baseURL */
  baseURL: string;
  /** @deprecated reflects providers[activeProviderId].defaultModel */
  model: string;
  /** @deprecated reflects providers[activeProviderId].providerFormat */
  providerFormat?: "openai" | "gemini";
  providers: AiProviderEntryPublic[];
  activeProviderId?: string;
  activeModelId?: string;
  aiSelectionDisplayDefault?: "show" | "hide";
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  conversationConfig?: ConversationConfig;
  memoryConfig?: MemoryConfig;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfigPublic;
  unifiedSearchEnabled?: boolean;
  imageGenerationReceiptConfig?: ImageGenerationReceiptConfig;
  imageGenerationConfirmation?: "always" | "never";
  agentToolsConfig?: AgentToolsConfig;
  /** Task defaults are resolved fresh for each run; explicit task fields override them. */
  taskAgentConfig?: AgentExecutionConfig;
  githubToolsConfig?: GitHubToolsConfigPublic;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  executionConfig: AiExecutionConfig;
  /** @deprecated reflects providers[activeProviderId].models */
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  embeddingConfig?: EmbeddingConfigPublic;
  dataFilesConfig?: DataFilesInjectionConfig;
  privateChatAccess?: "all" | "admin" | "allowlist";
  privateChatWhitelist?: number[];
  timeoutConfig?: TimeoutConfig;
  mcpServerIds?: number[];
  summaryConfig?: SummaryConfigStored;
  imageOcrConfig?: ImageOcrConfig;
}
