import type {
  AgentToolsConfig,
  MessageConfig,
  WebToolsConfig,
  WebToolsConfigPublic,
} from "@cos-tool-bot/shared";
import { isStreamReplyMode } from "@cos-tool-bot/shared";

type SearchConfig = NonNullable<WebToolsConfig["search"]>;
type PublicSearchConfig = NonNullable<WebToolsConfigPublic["search"]>;

export type ToolPromptCapability =
  | "agent-delegation"
  | "artwork"
  | "bot-memory"
  | "file"
  | "image-generation"
  | "multi-message"
  | "sticker"
  | "web"
  | "web-search";

export interface ToolPromptCapabilityInput {
  stickerPacks?: readonly string[];
  webToolsConfig?: WebToolsConfig | WebToolsConfigPublic;
  /** Resolved runtime tools. Omit only when deriving a configuration preview. */
  webTools?: Readonly<Record<string, unknown>>;
  hasImageGeneration?: boolean;
  agentToolsConfig?: AgentToolsConfig;
  hasBotMemoryTool: boolean;
  artworkToolsEnabled?: boolean;
  hasFileTools?: boolean;
  messageConfig?: MessageConfig;
}

export function hasWebSearchProviderPrerequisites(
  config: SearchConfig | PublicSearchConfig | undefined,
  allowRedactedApiKey = false,
): boolean {
  if (!config) return false;
  switch (config.provider) {
    case "tavily":
    case "brave": {
      const apiKey = "apiKey" in config && config.apiKey;
      const redactedApiKey = "hasApiKey" in config && config.hasApiKey;
      return !!(apiKey || (allowRedactedApiKey && redactedApiKey));
    }
    case "searxng":
    case "custom":
      return !!config.baseURL;
  }
}

export function deriveToolPromptCapabilities(
  input: ToolPromptCapabilityInput,
): ReadonlySet<ToolPromptCapability> {
  const capabilities = new Set<ToolPromptCapability>();

  if (input.stickerPacks?.length) capabilities.add("sticker");
  if (!isStreamReplyMode(input.messageConfig)) capabilities.add("multi-message");
  if (input.hasImageGeneration === true || !!input.webToolsConfig?.imageGeneration) {
    capabilities.add("image-generation");
  }
  if (input.agentToolsConfig?.enabled) capabilities.add("agent-delegation");
  if (input.hasBotMemoryTool) capabilities.add("bot-memory");
  if (input.artworkToolsEnabled) capabilities.add("artwork");
  if (input.hasFileTools) capabilities.add("file");

  if (input.webTools !== undefined) {
    if (input.webTools.fetch_webpage) capabilities.add("web");
    if (input.webTools.web_search) capabilities.add("web-search");
  } else if (input.webToolsConfig?.enabled) {
    capabilities.add("web");
    if (hasWebSearchProviderPrerequisites(input.webToolsConfig.search, true)) {
      capabilities.add("web-search");
    }
  }

  return capabilities;
}
