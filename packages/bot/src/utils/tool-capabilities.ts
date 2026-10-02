import type {
  AgentToolsConfig,
  MessageConfig,
  WebToolsConfig,
  WebToolsConfigPublic,
} from "@cos-tool-bot/shared";
import { isStreamReplyMode } from "@cos-tool-bot/shared";
import { getUnifiedSearchScopes } from "../tools/search.js";

type SearchConfig = NonNullable<WebToolsConfig["search"]>;
type PublicSearchConfig = NonNullable<WebToolsConfigPublic["search"]>;

export type ToolPromptCapability =
  | "agent-delegation"
  | "artwork"
  | "bot-memory"
  | "file"
  | "image-generation"
  | "memory"
  | "multi-message"
  | "sticker"
  | "web"
  | "web-search"
  | "unified-search";

const CAPABILITY_MARKER_TOOLS: Record<ToolPromptCapability, string> = {
  "agent-delegation": "delegate_task",
  artwork: "fetch_artwork_info",
  "bot-memory": "recall_memories",
  file: "read_file",
  "image-generation": "get_image_generation",
  memory: "get_profile",
  "multi-message": "multi_message",
  sticker: "send_sticker",
  web: "fetch_webpage",
  "web-search": "web_search",
  "unified-search": "search",
};

/** Configuration a prompt preview describes; runtime turns use deriveCapabilitiesFromTools. */
export interface ToolPromptCapabilityInput {
  stickerPacks?: readonly string[];
  webToolsConfig?: WebToolsConfig | WebToolsConfigPublic;
  hasImageGeneration?: boolean;
  agentToolsConfig?: AgentToolsConfig;
  hasMemoryTool?: boolean;
  hasBotMemoryTool: boolean;
  artworkToolsEnabled?: boolean;
  hasFileTools?: boolean;
  messageConfig?: MessageConfig;
  unifiedSearchEnabled?: boolean;
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
  if (input.unifiedSearchEnabled === true) capabilities.add("unified-search");

  if (input.stickerPacks?.length) capabilities.add("sticker");
  if (!isStreamReplyMode(input.messageConfig)) capabilities.add("multi-message");
  if (input.hasImageGeneration === true || !!input.webToolsConfig?.imageGeneration) {
    capabilities.add("image-generation");
  }
  if (input.agentToolsConfig?.enabled) capabilities.add("agent-delegation");
  if (input.hasMemoryTool) capabilities.add("memory");
  if (input.hasBotMemoryTool) capabilities.add("bot-memory");
  if (input.artworkToolsEnabled) capabilities.add("artwork");
  if (input.hasFileTools) capabilities.add("file");

  if (input.webToolsConfig?.enabled) {
    capabilities.add("web");
    if (hasWebSearchProviderPrerequisites(input.webToolsConfig.search, true)) {
      capabilities.add("web-search");
    }
  }

  return capabilities;
}

/**
 * Reads a runtime turn's capabilities from the tools it offers, so the prompt never describes
 * a tool the model cannot call. send_sticker is offered even without packs, where it can only
 * fail, so the sticker capability also needs configured packs.
 */
export function deriveCapabilitiesFromTools(
  tools: Readonly<Record<string, unknown>>,
  stickerPacks?: readonly string[],
): ReadonlySet<ToolPromptCapability> {
  const capabilities = new Set<ToolPromptCapability>();
  for (const [capability, marker] of Object.entries(CAPABILITY_MARKER_TOOLS)) {
    if (tools[marker]) capabilities.add(capability as ToolPromptCapability);
  }
  const scopes = getUnifiedSearchScopes(tools.search);
  if (scopes?.has("web")) capabilities.add("web-search");
  if (scopes?.has("memory")) capabilities.add("bot-memory");
  if (scopes?.has("artwork")) capabilities.add("artwork");
  if (!stickerPacks?.length) capabilities.delete("sticker");
  return capabilities;
}
