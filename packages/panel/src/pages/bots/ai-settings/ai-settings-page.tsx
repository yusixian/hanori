import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import type {
  AgentToolsConfig,
  AiConfigPublic,
  AiGroupOverride,
  AiTriggerConfig,
  ArtworkToolsConfig,
  BotMemoryConfig,
  ConversationConfig,
  ImageOcrConfig,
  MemoryConfig,
  MessageConfig,
  SummaryConfigStored,
  TimeoutConfig,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_ARTWORK_TOOLS_CONFIG,
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
} from "@cos-tool-bot/shared";
import {
  Brain,
  Eye,
  KeyRound,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Server,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PromptPreviewDialog } from "./prompt-preview-dialog";
import { useParams, useSearchParams } from "react-router";
import {
  AiSettingsNavigation,
  type AiSettingsNavItem,
  type AiSettingsSectionId,
} from "./components/ai-settings-navigation";
import { SettingsDisclosureRow } from "./components/settings-disclosure-row";
import { OverviewSection } from "./sections/overview-section";
import { AgentToolsSection } from "./sections/agent-tools-section";
import { ArtworkToolsSection } from "./sections/artwork-tools-section";
import { BotMemorySection } from "./sections/bot-memory-section";
import type { EmbeddingFormConfig } from "./sections/embedding-section";
import { EmbeddingSection } from "./sections/embedding-section";
import { ConversationSection } from "./sections/conversation-section";
import { GlobalSettingsSection } from "./sections/global-settings-section";
import { GroupOverridesSection } from "./sections/group-overrides-section";
import { MemorySystemSection } from "./sections/memory-system-section";
import { MessageSplittingSection } from "./sections/message-splitting-section";
import { TimeoutSection } from "./sections/timeout-section";
import { ModelsSection } from "./sections/models-section";
import { PrivateChatWhitelistSection } from "./sections/private-whitelist-section";
import { ProvidersSection } from "./sections/providers-section";
import { StickerPacksSection } from "./sections/sticker-packs-section";
import { TriggerSettingsSection } from "./sections/trigger-settings-section";
import { McpServersSection } from "./sections/mcp-servers-section";
import { SummaryConfigSection } from "./sections/summary-config-section";
import { ImageOcrConfigSection } from "./sections/image-ocr-config-section";
import { WebToolsSection } from "./sections/web-tools-section";
import { DEFAULT_AGENT_TOOLS, DEFAULT_CONFIG, DEFAULT_WEB_TOOLS } from "./types";
import type { StatusMessage } from "./types";
import { toast } from "sonner";

const DEFAULT_SUMMARY_CONFIG: SummaryConfigStored = {
  enabled: false,
  defaultWindowHours: 24,
  defaultMaxMessages: 2000,
  defaultCooldownSeconds: 300,
};

const DEFAULT_IMAGE_OCR_CONFIG: ImageOcrConfig = { enabled: false };

function serializeDraft(
  config: AiConfigPublic,
  triggerWordsText: string,
  stickerPacksText: string,
  summaryConfig: SummaryConfigStored,
  imageOcrConfig: ImageOcrConfig,
) {
  return JSON.stringify({
    config,
    triggerWordsText,
    stickerPacksText,
    summaryConfig,
    imageOcrConfig,
  });
}

export function BotAiSettingsPage() {
  const { botId } = useParams<{ botId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [config, setConfig] = useState<AiConfigPublic>(DEFAULT_CONFIG);
  const savedDraftRef = useRef("");
  // Draft per-provider api keys: keyed by provider id (or temp "__new_..." id until saved).
  // Cleared on save. Preserve-when-empty: empty string ⇒ keep existing encrypted key.
  const [providerApiKeys, setProviderApiKeys] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [triggerWordsText, setTriggerWordsText] = useState("");
  const [stickerPacksText, setStickerPacksText] = useState("");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [summaryConfig, setSummaryConfig] = useState<SummaryConfigStored>(DEFAULT_SUMMARY_CONFIG);
  const [imageOcrConfig, setImageOcrConfig] = useState<ImageOcrConfig>(DEFAULT_IMAGE_OCR_CONFIG);

  const sectionItems: AiSettingsNavItem[] = useMemo(
    () => [
      {
        id: "overview",
        label: "Overview",
        description: "Status and quick actions",
        icon: LayoutDashboard,
      },
      {
        id: "providers",
        label: "Providers & Models",
        description: "Connections and model defaults",
        icon: Server,
      },
      {
        id: "replies",
        label: "Reply Behavior",
        description: "Prompts, triggers, and delivery",
        icon: MessageSquare,
      },
      {
        id: "memory",
        label: "Memory",
        description: "Context, embeddings, and summaries",
        icon: Brain,
      },
      { id: "tools", label: "Tools", description: "Web, agents, MCP, and OCR", icon: Wrench },
      {
        id: "access",
        label: "Access & Groups",
        description: "Private and group permissions",
        icon: KeyRound,
      },
    ],
    [],
  );
  const requestedSection = searchParams.get("section") as AiSettingsSectionId | null;
  const activeSection = sectionItems.some((item) => item.id === requestedSection)
    ? requestedSection!
    : "overview";
  const setActiveSection = (section: AiSettingsSectionId) => {
    const next = new URLSearchParams(searchParams);
    if (section === "overview") next.delete("section");
    else next.set("section", section);
    setSearchParams(next);
  };

  const loadConfig = useCallback(async () => {
    if (!botId) return;
    try {
      const res = await client.api.bots[":botId"]["ai-config"].$get({ param: { botId } });
      const json = await res.json();
      if (json.ok) {
        const triggerText = json.data.triggerConfig.triggerWords.join(", ");
        const stickersText = json.data.stickerPacks?.join(", ") ?? "";
        const nextSummary = json.data.summaryConfig ?? DEFAULT_SUMMARY_CONFIG;
        const nextOcr = json.data.imageOcrConfig ?? DEFAULT_IMAGE_OCR_CONFIG;
        setConfig(json.data);
        setTriggerWordsText(triggerText);
        setStickerPacksText(stickersText);
        setSummaryConfig(nextSummary);
        setImageOcrConfig(nextOcr);
        savedDraftRef.current = serializeDraft(
          json.data,
          triggerText,
          stickersText,
          nextSummary,
          nextOcr,
        );
      }
    } catch {
      setMessage({ type: "error", text: "Failed to load AI config" });
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!message) return;
    if (message.type === "success") toast.success(message.text);
    else toast.error(message.text);
  }, [message]);

  const isDirty =
    savedDraftRef.current !== "" &&
    (savedDraftRef.current !==
      serializeDraft(config, triggerWordsText, stickerPacksText, summaryConfig, imageOcrConfig) ||
      embeddingApiKey !== "" ||
      Object.keys(providerApiKeys).length > 0);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isDirty]);

  const handleSave = async () => {
    if (!botId) return;
    setSaving(true);
    setMessage(null);
    try {
      const activeProvider =
        config.providers?.find((provider) => provider.id === config.activeProviderId) ??
        config.providers?.[0];
      const res = await client.api.bots[":botId"]["ai-config"].$put({
        param: { botId },
        json: {
          enabled: config.enabled,
          baseURL: activeProvider?.baseURL ?? config.baseURL,
          providerFormat: activeProvider?.providerFormat ?? config.providerFormat,
          model: activeProvider?.defaultModel ?? config.model,
          systemPrompt: config.systemPrompt,
          behavioralPrompt: config.behavioralPrompt || undefined,
          groupBehavioralPrompt: config.groupBehavioralPrompt || undefined,
          triggerConfig: {
            ...config.triggerConfig,
            triggerWords: triggerWordsText
              .split(",")
              .map((word) => word.trim())
              .filter(Boolean),
          },
          groupOverrides: config.groupOverrides,
          conversationConfig: config.conversationConfig,
          memoryConfig: config.memoryConfig,
          botMemoryConfig: config.botMemoryConfig,
          webToolsConfig: config.webToolsConfig,
          agentToolsConfig: config.agentToolsConfig,
          artworkToolsConfig: config.artworkToolsConfig,
          messageConfig: config.messageConfig,
          timeoutConfig: config.timeoutConfig,
          models: activeProvider?.models ?? config.models,
          modelCommandAccess: config.modelCommandAccess,
          embeddingConfig: config.embeddingConfig
            ? {
                enabled: config.embeddingConfig.enabled,
                apiKey: embeddingApiKey || undefined,
                baseURL: config.embeddingConfig.baseURL,
                model: config.embeddingConfig.model,
              }
            : undefined,
          privateChatWhitelist: config.privateChatWhitelist,
          mcpServerIds: config.mcpServerIds,
          summaryConfig,
          imageOcrConfig,
          stickerPacks: stickerPacksText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          providers: config.providers?.map((p) => ({
            // Keep temp "__new_*" ids so backend can remap activeProviderId through them.
            id: p.id,
            label: p.label,
            baseURL: p.baseURL,
            providerFormat: p.providerFormat,
            defaultModel: p.defaultModel,
            apiKey: providerApiKeys[p.id] || undefined,
            models: p.models,
          })),
          activeProviderId: config.activeProviderId,
        },
      });
      if (!res.ok) {
        try {
          const errorJson = JSON.parse(await res.text());
          const detail = errorJson?.error?.issues
            ? (errorJson.error.issues as Array<{ path: string[]; message: string }>)
                .map(
                  (i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`,
                )
                .join("; ")
            : JSON.stringify(errorJson);
          setMessage({ type: "error", text: `Save failed: ${detail}` });
        } catch {
          setMessage({ type: "error", text: `Save failed (HTTP ${res.status})` });
        }
        return;
      }
      const json = await res.json();
      if (json.ok) {
        const triggerText = json.data.triggerConfig.triggerWords.join(", ");
        const stickersText = json.data.stickerPacks?.join(", ") ?? "";
        const nextSummary = json.data.summaryConfig ?? summaryConfig;
        const nextOcr = json.data.imageOcrConfig ?? imageOcrConfig;
        setConfig(json.data);
        setTriggerWordsText(triggerText);
        setStickerPacksText(stickersText);
        setEmbeddingApiKey("");
        setProviderApiKeys({});
        savedDraftRef.current = serializeDraft(
          json.data,
          triggerText,
          stickersText,
          nextSummary,
          nextOcr,
        );
        setMessage({ type: "success", text: "AI config saved" });
      } else {
        setMessage({
          type: "error",
          text: "error" in json ? String(json.error) : "Failed to save",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to save AI config" });
    } finally {
      setSaving(false);
    }
  };

  // --- updater functions ---

  const updateTrigger = (
    key: keyof AiTriggerConfig,
    value: AiTriggerConfig[keyof AiTriggerConfig],
  ) => {
    setConfig((prev) => ({
      ...prev,
      triggerConfig: { ...prev.triggerConfig, [key]: value },
    }));
  };

  const memCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const updateMemory = (updates: Partial<MemoryConfig>) => {
    setConfig((prev) => ({
      ...prev,
      memoryConfig: { ...memCfg, ...prev.memoryConfig, ...updates },
    }));
  };

  const convCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const updateConv = (updates: Partial<ConversationConfig>) => {
    setConfig((prev) => ({
      ...prev,
      conversationConfig: { ...convCfg, ...prev.conversationConfig, ...updates },
    }));
  };

  const webCfg = config.webToolsConfig ?? DEFAULT_WEB_TOOLS;
  const updateWebTools = (updates: Partial<WebToolsConfig>) => {
    setConfig((prev) => ({
      ...prev,
      webToolsConfig: { ...webCfg, ...prev.webToolsConfig, ...updates },
    }));
  };

  const agentCfg = config.agentToolsConfig ?? DEFAULT_AGENT_TOOLS;
  const updateAgentTools = (updates: Partial<AgentToolsConfig>) => {
    setConfig((prev) => ({
      ...prev,
      agentToolsConfig: { ...agentCfg, ...prev.agentToolsConfig, ...updates },
    }));
  };

  const artworkCfg = config.artworkToolsConfig ?? DEFAULT_ARTWORK_TOOLS_CONFIG;
  const updateArtworkTools = (updates: Partial<ArtworkToolsConfig>) => {
    setConfig((prev) => ({
      ...prev,
      artworkToolsConfig: { ...artworkCfg, ...prev.artworkToolsConfig, ...updates },
    }));
  };

  const botMemCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
  const updateBotMemory = (updates: Partial<BotMemoryConfig>) => {
    setConfig((prev) => ({
      ...prev,
      botMemoryConfig: { ...botMemCfg, ...prev.botMemoryConfig, ...updates },
    }));
  };

  const embCfg: EmbeddingFormConfig = {
    enabled: config.embeddingConfig?.enabled ?? DEFAULT_EMBEDDING_CONFIG.enabled,
    hasApiKey: config.embeddingConfig?.hasApiKey ?? false,
    baseURL: config.embeddingConfig?.baseURL ?? DEFAULT_EMBEDDING_CONFIG.baseURL,
    model: config.embeddingConfig?.model ?? DEFAULT_EMBEDDING_CONFIG.model,
    dimensions: config.embeddingConfig?.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
    apiKey: embeddingApiKey,
  };
  const updateEmbedding = (updates: Partial<EmbeddingFormConfig>) => {
    if ("apiKey" in updates) {
      setEmbeddingApiKey(updates.apiKey ?? "");
    }
    const { apiKey: _, hasApiKey: __, ...configUpdates } = updates;
    if (Object.keys(configUpdates).length > 0) {
      setConfig((prev) => ({
        ...prev,
        embeddingConfig: {
          ...prev.embeddingConfig,
          enabled: prev.embeddingConfig?.enabled ?? DEFAULT_EMBEDDING_CONFIG.enabled,
          hasApiKey: prev.embeddingConfig?.hasApiKey ?? false,
          baseURL: prev.embeddingConfig?.baseURL ?? DEFAULT_EMBEDDING_CONFIG.baseURL,
          model: prev.embeddingConfig?.model ?? DEFAULT_EMBEDDING_CONFIG.model,
          dimensions: prev.embeddingConfig?.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
          ...configUpdates,
        },
      }));
    }
  };

  const timeoutCfg = config.timeoutConfig ?? {};
  const updateTimeoutConfig = (updates: Partial<TimeoutConfig>) => {
    setConfig((prev) => {
      const merged = { ...prev.timeoutConfig, ...updates };
      // If all values are undefined, remove the key entirely
      const hasValue = Object.values(merged).some((v) => v != null);
      return { ...prev, timeoutConfig: hasValue ? merged : undefined };
    });
  };

  const msgCfg = config.messageConfig ?? DEFAULT_MESSAGE_CONFIG;
  const updateMessageConfig = (updates: Partial<MessageConfig>) => {
    setConfig((prev) => ({
      ...prev,
      messageConfig: { ...msgCfg, ...prev.messageConfig, ...updates },
    }));
  };

  const addWhitelistUser = (userId: number) => {
    setConfig((prev) => ({
      ...prev,
      privateChatWhitelist: [...(prev.privateChatWhitelist ?? []), userId],
    }));
  };

  const removeWhitelistUser = (userId: number) => {
    setConfig((prev) => ({
      ...prev,
      privateChatWhitelist: (prev.privateChatWhitelist ?? []).filter((id) => id !== userId),
    }));
  };

  const addGroupOverride = (chatId: number, chatTitle?: string) => {
    const key = String(chatId);
    const override: AiGroupOverride = {
      chatId,
      chatTitle,
      enabled: true,
      whitelisted: true,
    };
    setConfig((prev) => ({
      ...prev,
      groupOverrides: { ...prev.groupOverrides, [key]: override },
    }));
  };

  const updateOverride = (key: string, updates: Partial<AiGroupOverride>) => {
    setConfig((prev) => ({
      ...prev,
      groupOverrides: {
        ...prev.groupOverrides,
        [key]: { ...prev.groupOverrides[key]!, ...updates },
      },
    }));
  };

  const removeOverride = (key: string) => {
    setConfig((prev) => {
      const { [key]: _, ...rest } = prev.groupOverrides;
      return { ...prev, groupOverrides: rest };
    });
  };

  const activeProvider =
    config.providers?.find((provider) => provider.id === config.activeProviderId) ??
    config.providers?.[0];
  const updateActiveProvider = (updates: Partial<NonNullable<typeof activeProvider>>) => {
    if (!activeProvider) return;
    setConfig((prev) => ({
      ...prev,
      providers: prev.providers.map((provider) =>
        provider.id === activeProvider.id ? { ...provider, ...updates } : provider,
      ),
    }));
  };

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-[1180px] space-y-5">
      <div className="sticky top-0 z-20 -mx-2 space-y-3 rounded-b-2xl bg-slate-50/95 px-2 pt-1 pb-3 shadow-[0_12px_24px_-22px_rgb(15_23_42/0.55)] backdrop-blur-xl supports-[backdrop-filter]:bg-slate-50/85">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-balance">AI Settings</h1>
            <div className="mt-1 hidden items-center gap-2 text-sm text-slate-500 sm:flex">
              <span>Configure how this bot thinks, responds, and uses tools.</span>
              {isDirty && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  Unsaved Changes
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setPreviewOpen(true)}>
              <Eye className="h-4 w-4" />
              <span className="hidden sm:inline">Preview Prompt</span>
              <span className="sm:hidden">Preview</span>
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </div>
        <AiSettingsNavigation
          items={sectionItems}
          activeId={activeSection}
          onChange={setActiveSection}
        />
      </div>

      <PromptPreviewDialog
        botId={botId!}
        config={{
          ...config,
          triggerConfig: {
            ...config.triggerConfig,
            triggerWords: triggerWordsText
              .split(",")
              .map((word) => word.trim())
              .filter(Boolean),
          },
        }}
        stickerPacks={stickerPacksText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />

      <div className="space-y-5">
        <div className="min-w-0">
          <header className="mb-5 flex items-end justify-between gap-4 px-1">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                {sectionItems.find((item) => item.id === activeSection)?.label}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {sectionItems.find((item) => item.id === activeSection)?.description}
              </p>
            </div>
          </header>

          {activeSection === "overview" && (
            <OverviewSection
              config={{ ...config, summaryConfig, imageOcrConfig }}
              onEnabledChange={(enabled) => setConfig((prev) => ({ ...prev, enabled }))}
              onNavigate={setActiveSection}
            />
          )}

          {activeSection === "providers" && (
            <div className="space-y-5">
              <ProvidersSection
                providers={config.providers ?? []}
                activeProviderId={config.activeProviderId}
                draftApiKeys={providerApiKeys}
                onProvidersChange={(providers) => setConfig((prev) => ({ ...prev, providers }))}
                onActiveProviderChange={(activeProviderId) =>
                  setConfig((prev) => ({ ...prev, activeProviderId }))
                }
                onDraftApiKeyChange={(id, key) =>
                  setProviderApiKeys((prev) => {
                    if (!key) {
                      const { [id]: _, ...rest } = prev;
                      return rest;
                    }
                    return { ...prev, [id]: key };
                  })
                }
              />

              {activeProvider && (
                <ModelsSection
                  botId={botId!}
                  models={activeProvider.models ?? []}
                  activeModel={activeProvider.defaultModel}
                  modelCommandAccess={config.modelCommandAccess ?? "admin"}
                  baseURL={activeProvider.baseURL}
                  apiKey={providerApiKeys[activeProvider.id] ?? ""}
                  onModelsChange={(models) => updateActiveProvider({ models })}
                  onActiveModelChange={(defaultModel) => updateActiveProvider({ defaultModel })}
                  onModelCommandAccessChange={(modelCommandAccess) =>
                    setConfig((prev) => ({ ...prev, modelCommandAccess }))
                  }
                  onError={(text) => setMessage({ type: "error", text })}
                />
              )}
            </div>
          )}

          {activeSection === "replies" && (
            <div className="space-y-3">
              <SettingsDisclosureRow
                title="Reply prompts"
                description="Define the bot's persona, behavior, and system instructions."
                defaultOpen
                flattenCard={false}
              >
                <GlobalSettingsSection
                  config={config}
                  onConfigChange={(updates) => setConfig((prev) => ({ ...prev, ...updates }))}
                />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Triggers"
                description="Choose when the bot should reply."
                summary={`${config.triggerConfig.triggerWords.length} trigger words`}
              >
                <TriggerSettingsSection
                  config={config.triggerConfig}
                  triggerWordsText={triggerWordsText}
                  onTriggerWordsTextChange={setTriggerWordsText}
                  onUpdate={updateTrigger}
                />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Conversation context"
                description="Control history windows and context construction."
              >
                <ConversationSection config={convCfg} onUpdate={updateConv} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Message delivery"
                description="Configure splitting and pacing for long replies."
              >
                <MessageSplittingSection config={msgCfg} onUpdate={updateMessageConfig} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Timeouts"
                description="Set operation-specific time limits."
              >
                <TimeoutSection config={timeoutCfg} onUpdate={updateTimeoutConfig} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Sticker packs"
                description="Allow the bot to include configured stickers."
              >
                <StickerPacksSection
                  stickerPacksText={stickerPacksText}
                  onStickerPacksTextChange={setStickerPacksText}
                />
              </SettingsDisclosureRow>
            </div>
          )}

          {activeSection === "memory" && (
            <div className="space-y-3">
              <SettingsDisclosureRow
                title="Conversation memory"
                description="Retain useful facts from conversations."
                summary={memCfg.enabled ? "Enabled" : "Disabled"}
              >
                <MemorySystemSection config={memCfg} onUpdate={updateMemory} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Bot memory"
                description="Configure the bot's persistent memory store."
                summary={botMemCfg.enabled ? "Enabled" : "Disabled"}
              >
                <BotMemorySection config={botMemCfg} onUpdate={updateBotMemory} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Embeddings"
                description="Configure semantic indexing and retrieval."
                summary={embCfg.enabled ? "Enabled" : "Disabled"}
              >
                <EmbeddingSection config={embCfg} onUpdate={updateEmbedding} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Chat summaries"
                description="Generate scheduled or manual conversation summaries."
                summary={summaryConfig.enabled ? "Enabled" : "Disabled"}
              >
                <SummaryConfigSection
                  botId={botId!}
                  config={summaryConfig}
                  onUpdate={(updates) => setSummaryConfig((prev) => ({ ...prev, ...updates }))}
                />
              </SettingsDisclosureRow>
            </div>
          )}

          {activeSection === "tools" && (
            <div className="space-y-3">
              <SettingsDisclosureRow
                title="Web tools"
                description="Search, browse, and research information online."
                summary={webCfg.enabled ? "Enabled" : "Disabled"}
              >
                <WebToolsSection config={webCfg} onUpdate={updateWebTools} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Agent tools"
                description="Delegate complex work to sub-agents."
                summary={agentCfg.enabled ? "Enabled" : "Disabled"}
              >
                <AgentToolsSection config={agentCfg} onUpdate={updateAgentTools} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Artwork tools"
                description="Fetch artwork information and images."
                summary={artworkCfg.enabled ? "Enabled" : "Disabled"}
              >
                <ArtworkToolsSection config={artworkCfg} onUpdate={updateArtworkTools} />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="MCP servers"
                description="Connect external tools and data sources."
                summary={`${config.mcpServerIds?.length ?? 0} selected`}
              >
                <McpServersSection
                  selectedIds={config.mcpServerIds ?? []}
                  onUpdate={(ids) => setConfig((prev) => ({ ...prev, mcpServerIds: ids }))}
                />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Image OCR"
                description="Describe images before they reach the main model."
                summary={imageOcrConfig.enabled ? "Enabled" : "Disabled"}
              >
                <ImageOcrConfigSection
                  config={imageOcrConfig}
                  providers={config.providers}
                  activeProviderId={config.activeProviderId}
                  onUpdate={(updates) => setImageOcrConfig((prev) => ({ ...prev, ...updates }))}
                />
              </SettingsDisclosureRow>
            </div>
          )}

          {activeSection === "access" && (
            <div className="space-y-3">
              <SettingsDisclosureRow
                title="Private chat whitelist"
                description="Control who can use the bot in private chats."
                summary={`${config.privateChatWhitelist?.length ?? 0} users`}
              >
                <PrivateChatWhitelistSection
                  whitelist={config.privateChatWhitelist ?? []}
                  onAdd={addWhitelistUser}
                  onRemove={removeWhitelistUser}
                />
              </SettingsDisclosureRow>
              <SettingsDisclosureRow
                title="Group overrides"
                description="Customize behavior for individual groups."
                summary={`${Object.keys(config.groupOverrides).length} groups`}
              >
                <GroupOverridesSection
                  overrides={config.groupOverrides}
                  onAdd={addGroupOverride}
                  onUpdate={updateOverride}
                  onRemove={removeOverride}
                />
              </SettingsDisclosureRow>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
