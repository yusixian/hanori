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
  MemoryConfig,
  MessageConfig,
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
import { Eye, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PromptPreviewDialog } from "./prompt-preview-dialog";
import { useParams } from "react-router";
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
import { StickerPacksSection } from "./sections/sticker-packs-section";
import { TriggerSettingsSection } from "./sections/trigger-settings-section";
import { WebToolsSection } from "./sections/web-tools-section";
import { DEFAULT_AGENT_TOOLS, DEFAULT_CONFIG, DEFAULT_WEB_TOOLS } from "./types";
import type { StatusMessage } from "./types";

export function BotAiSettingsPage() {
  const { botId } = useParams<{ botId: string }>();
  const [config, setConfig] = useState<AiConfigPublic>(DEFAULT_CONFIG);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [triggerWordsText, setTriggerWordsText] = useState("");
  const [stickerPacksText, setStickerPacksText] = useState("");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  const loadConfig = useCallback(async () => {
    if (!botId) return;
    try {
      const res = await client.api.bots[":botId"]["ai-config"].$get({ param: { botId } });
      const json = await res.json();
      if (json.ok) {
        setConfig(json.data);
        setTriggerWordsText(json.data.triggerConfig.triggerWords.join(", "));
        setStickerPacksText(json.data.stickerPacks?.join(", ") ?? "");
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

  const handleSave = async () => {
    if (!botId) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await client.api.bots[":botId"]["ai-config"].$put({
        param: { botId },
        json: {
          enabled: config.enabled,
          apiKey: apiKey || undefined,
          baseURL: config.baseURL,
          model: config.model,
          systemPrompt: config.systemPrompt,
          behavioralPrompt: config.behavioralPrompt || undefined,
          groupBehavioralPrompt: config.groupBehavioralPrompt || undefined,
          triggerConfig: config.triggerConfig,
          groupOverrides: config.groupOverrides,
          conversationConfig: config.conversationConfig,
          memoryConfig: config.memoryConfig,
          botMemoryConfig: config.botMemoryConfig,
          webToolsConfig: config.webToolsConfig,
          agentToolsConfig: config.agentToolsConfig,
          artworkToolsConfig: config.artworkToolsConfig,
          messageConfig: config.messageConfig,
          timeoutConfig: config.timeoutConfig,
          models: config.models,
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
          stickerPacks: stickerPacksText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
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
        setConfig(json.data);
        setTriggerWordsText(json.data.triggerConfig.triggerWords.join(", "));
        setStickerPacksText(json.data.stickerPacks?.join(", ") ?? "");
        setApiKey("");
        setEmbeddingApiKey("");
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

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">AI Settings</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setPreviewOpen(true)}>
            <Eye className="h-4 w-4" />
            Preview Prompt
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </div>

      <PromptPreviewDialog
        botId={botId!}
        config={config}
        stickerPacks={stickerPacksText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />

      {message && (
        <div
          className={`rounded-md p-3 text-sm ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}
        >
          {message.text}
        </div>
      )}

      <GlobalSettingsSection
        config={config}
        apiKey={apiKey}
        onConfigChange={(updates) => setConfig((prev) => ({ ...prev, ...updates }))}
        onApiKeyChange={setApiKey}
      />

      <ModelsSection
        botId={botId!}
        models={config.models ?? []}
        activeModel={config.model}
        modelCommandAccess={config.modelCommandAccess ?? "admin"}
        baseURL={config.baseURL}
        apiKey={apiKey}
        onModelsChange={(models) => setConfig((prev) => ({ ...prev, models }))}
        onActiveModelChange={(model) => setConfig((prev) => ({ ...prev, model }))}
        onModelCommandAccessChange={(modelCommandAccess) =>
          setConfig((prev) => ({ ...prev, modelCommandAccess }))
        }
        onError={(text) => setMessage({ type: "error", text })}
      />

      <TriggerSettingsSection
        config={config.triggerConfig}
        triggerWordsText={triggerWordsText}
        onTriggerWordsTextChange={setTriggerWordsText}
        onUpdate={updateTrigger}
      />

      <ConversationSection config={convCfg} onUpdate={updateConv} />

      <MessageSplittingSection config={msgCfg} onUpdate={updateMessageConfig} />

      <TimeoutSection config={timeoutCfg} onUpdate={updateTimeoutConfig} />

      <MemorySystemSection config={memCfg} onUpdate={updateMemory} />

      <BotMemorySection config={botMemCfg} onUpdate={updateBotMemory} />

      <EmbeddingSection config={embCfg} onUpdate={updateEmbedding} />

      <WebToolsSection config={webCfg} onUpdate={updateWebTools} />

      <AgentToolsSection config={agentCfg} onUpdate={updateAgentTools} />

      <ArtworkToolsSection config={artworkCfg} onUpdate={updateArtworkTools} />

      <StickerPacksSection
        stickerPacksText={stickerPacksText}
        onStickerPacksTextChange={setStickerPacksText}
      />

      <PrivateChatWhitelistSection
        whitelist={config.privateChatWhitelist ?? []}
        onAdd={addWhitelistUser}
        onRemove={removeWhitelistUser}
      />

      <GroupOverridesSection
        overrides={config.groupOverrides}
        onAdd={addGroupOverride}
        onUpdate={updateOverride}
        onRemove={removeOverride}
      />
    </div>
  );
}
