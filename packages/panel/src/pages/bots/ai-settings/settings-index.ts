import type { AiSettingsSectionId } from "./components/ai-settings-navigation";

export const AI_SETTING_DEFINITIONS = [
  {
    id: "reply-prompts",
    section: "replies",
    titleKey: "disclosures.replyPrompts.title",
    descriptionKey: "disclosures.replyPrompts.description",
  },
  {
    id: "engagement",
    section: "replies",
    titleKey: "engagement.title",
    descriptionKey: "engagement.description",
  },
  {
    id: "triggers",
    section: "replies",
    titleKey: "disclosures.triggers.title",
    descriptionKey: "disclosures.triggers.description",
  },
  {
    id: "conversation-context",
    section: "replies",
    titleKey: "disclosures.conversationContext.title",
    descriptionKey: "disclosures.conversationContext.description",
  },
  {
    id: "execution",
    section: "replies",
    titleKey: "disclosures.execution.title",
    descriptionKey: "disclosures.execution.description",
  },
  {
    id: "message-delivery",
    section: "replies",
    titleKey: "disclosures.messageDelivery.title",
    descriptionKey: "disclosures.messageDelivery.description",
  },
  {
    id: "timeouts",
    section: "replies",
    titleKey: "disclosures.timeouts.title",
    descriptionKey: "disclosures.timeouts.description",
  },
  {
    id: "sticker-packs",
    section: "replies",
    titleKey: "disclosures.stickerPacks.title",
    descriptionKey: "disclosures.stickerPacks.description",
  },
  {
    id: "conversation-memory",
    section: "memory",
    titleKey: "disclosures.conversationMemory.title",
    descriptionKey: "disclosures.conversationMemory.description",
  },
  {
    id: "bot-memory",
    section: "memory",
    titleKey: "disclosures.botMemory.title",
    descriptionKey: "disclosures.botMemory.description",
  },
  {
    id: "embeddings",
    section: "memory",
    titleKey: "disclosures.embeddings.title",
    descriptionKey: "disclosures.embeddings.description",
  },
  {
    id: "chat-summaries",
    section: "memory",
    titleKey: "disclosures.chatSummaries.title",
    descriptionKey: "disclosures.chatSummaries.description",
  },
  {
    id: "unified-search",
    section: "tools",
    titleKey: "unifiedSearch.title",
    descriptionKey: "unifiedSearch.description",
  },
  {
    id: "web-tools",
    section: "tools",
    titleKey: "disclosures.webTools.title",
    descriptionKey: "disclosures.webTools.description",
  },
  {
    id: "image-generation-receipt",
    section: "tools",
    titleKey: "disclosures.imageGenerationReceipt.title",
    descriptionKey: "disclosures.imageGenerationReceipt.description",
  },
  {
    id: "github-tools",
    section: "tools",
    titleKey: "disclosures.githubTools.title",
    descriptionKey: "disclosures.githubTools.description",
  },
  {
    id: "agent-tools",
    section: "tools",
    titleKey: "disclosures.agentTools.title",
    descriptionKey: "disclosures.agentTools.description",
  },
  {
    id: "artwork-tools",
    section: "tools",
    titleKey: "disclosures.artworkTools.title",
    descriptionKey: "disclosures.artworkTools.description",
  },
  {
    id: "mcp-servers",
    section: "tools",
    titleKey: "disclosures.mcpServers.title",
    descriptionKey: "disclosures.mcpServers.description",
  },
  {
    id: "image-ocr",
    section: "tools",
    titleKey: "disclosures.imageOcr.title",
    descriptionKey: "disclosures.imageOcr.description",
  },
  {
    id: "private-whitelist",
    section: "access",
    titleKey: "disclosures.privateWhitelist.title",
    descriptionKey: "disclosures.privateWhitelist.description",
  },
  {
    id: "group-overrides",
    section: "access",
    titleKey: "disclosures.groupOverrides.title",
    descriptionKey: "disclosures.groupOverrides.description",
  },
] as const satisfies readonly {
  id: string;
  section: AiSettingsSectionId;
  titleKey: string;
  descriptionKey: string;
}[];

export type AiSettingId = (typeof AI_SETTING_DEFINITIONS)[number]["id"];
export type AiSettingDefinition = (typeof AI_SETTING_DEFINITIONS)[number];

export function findAiSettingDefinition(value: string | null): AiSettingDefinition | undefined {
  if (!value) return undefined;
  return AI_SETTING_DEFINITIONS.find((setting) => setting.id === value);
}

export function settingElementId(settingId: AiSettingId): string {
  return `ai-setting-${settingId}`;
}
