import type {
  AgentToolsConfig,
  AiConfigPublic,
  AiTriggerConfig,
  ModelCapability,
  WebToolsConfigPublic,
  GitHubToolsConfigPublic,
} from "@cos-tool-bot/shared";

export interface ModelOption {
  id: string;
  owned_by?: string;
  capabilities: ModelCapability[];
}

export const CAPABILITY_BADGES: Record<ModelCapability, { emoji: string; labelKey: string }> = {
  vision: { emoji: "👁", labelKey: "capabilities.vision" },
  tool_calling: { emoji: "🔧", labelKey: "capabilities.toolCalling" },
  web_search: { emoji: "🌐", labelKey: "capabilities.webSearch" },
  reasoning: { emoji: "🧠", labelKey: "capabilities.reasoning" },
  long_context: { emoji: "📏", labelKey: "capabilities.longContext" },
  code: { emoji: "💻", labelKey: "capabilities.code" },
};

export const DEFAULT_TRIGGER: AiTriggerConfig = {
  replyToBot: true,
  mentionBot: true,
  triggerWords: [],
  randomReplyPercent: 0,
  randomReplyCooldown: 60,
};

export const DEFAULT_WEB_TOOLS: WebToolsConfigPublic = {
  enabled: false,
};

export const DEFAULT_AGENT_TOOLS: AgentToolsConfig = {
  enabled: false,
};

export const DEFAULT_GITHUB_TOOLS: GitHubToolsConfigPublic = {
  enabled: false,
  publicReadEnabled: true,
  codingAgentEnabled: false,
  hasToken: false,
  authorName: "Ai-chan",
  authorEmail: "ai-chan@users.noreply.github.com",
  repositories: [],
};

export const DEFAULT_CONFIG: AiConfigPublic = {
  enabled: false,
  hasApiKey: false,
  baseURL: "",
  model: "",
  systemPrompt: "",
  behavioralPrompt: "",
  groupBehavioralPrompt: "",
  triggerConfig: DEFAULT_TRIGGER,
  groupOverrides: {},
  providers: [],
};

export interface StatusMessage {
  type: "success" | "error";
  text: string;
}

export interface AiSelectionOption {
  id: string;
  label: string;
}

export interface AiSelectionProviderOption extends AiSelectionOption {
  defaultModelId: string;
  models: AiSelectionOption[];
}

export interface GlobalAiSelection {
  revision: string;
  applyState: "applied" | "pending";
  displayDefault: "show" | "hide";
  selection: {
    providerId: string;
    modelId: string | null;
    providerLabel: string;
    modelLabel: string;
  };
  options: AiSelectionProviderOption[];
}
