import type { AgentExecutionConfig } from "./scheduled-tasks.js";
import type { PixAIConfig } from "./pixai.js";

export interface WebToolsConfig {
  enabled: boolean;
  /** Explicit hostnames/IPs that fetch_webpage may access on private networks. */
  trustedPrivateHosts?: string[];
  search?: {
    provider: "tavily" | "searxng" | "brave" | "custom";
    apiKey?: string;
    baseURL?: string;
  };
  imageGeneration?: {
    provider: "openai" | "custom" | "pixai";
    apiKey?: string;
    baseURL?: string;
    model?: string;
    size?: string;
    pixaiConfig?: PixAIConfig;
  };
}

export interface WebToolsConfigPublic {
  enabled: boolean;
  trustedPrivateHosts?: string[];
  search?: {
    provider: "tavily" | "searxng" | "brave" | "custom";
    hasApiKey?: boolean;
    baseURL?: string;
  };
  imageGeneration?: {
    provider: "openai" | "custom" | "pixai";
    hasApiKey?: boolean;
    baseURL?: string;
    model?: string;
    size?: string;
    pixaiConfig?: PixAIConfig;
  };
}

export interface AgentToolsConfig {
  enabled: boolean;
  subAgentModel?: string;
  maxSubAgentSteps?: number;
  agents?: Record<string, AgentExecutionConfig & { enabled?: boolean }>;
}

export interface ArtworkToolsConfig {
  enabled: boolean;
  pixivCookie?: string;
}

export const DEFAULT_ARTWORK_TOOLS_CONFIG: ArtworkToolsConfig = {
  enabled: false,
};
