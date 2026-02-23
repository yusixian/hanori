import type {
  AgentToolsConfig,
  AiConfigPublic,
  AiTriggerConfig,
  ModelCapability,
  WebToolsConfig,
} from "@cos-tool-bot/shared";

export interface ModelOption {
  id: string;
  owned_by: string;
  capabilities: ModelCapability[];
}

export const CAPABILITY_BADGES: Record<ModelCapability, { emoji: string; label: string }> = {
  vision: { emoji: "👁", label: "Vision" },
  tool_calling: { emoji: "🔧", label: "Tools" },
  web_search: { emoji: "🌐", label: "Search" },
  reasoning: { emoji: "🧠", label: "Reasoning" },
  long_context: { emoji: "📏", label: "Long" },
  code: { emoji: "💻", label: "Code" },
};

export const DEFAULT_TRIGGER: AiTriggerConfig = {
  replyToBot: true,
  mentionBot: true,
  triggerWords: [],
  randomReplyPercent: 0,
  randomReplyCooldown: 60,
};

export const DEFAULT_WEB_TOOLS: WebToolsConfig = {
  enabled: false,
};

export const DEFAULT_AGENT_TOOLS: AgentToolsConfig = {
  enabled: false,
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
};

export interface StatusMessage {
  type: "success" | "error";
  text: string;
}
