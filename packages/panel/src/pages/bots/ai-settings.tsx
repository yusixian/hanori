import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import type {
  AiConfigPublic,
  AiGroupOverride,
  AiTriggerConfig,
  ConversationConfig,
  MemoryConfig,
} from "@cos-tool-bot/shared";
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";

interface ModelOption {
  id: string;
  owned_by: string;
}

const DEFAULT_TRIGGER: AiTriggerConfig = {
  replyToBot: true,
  mentionBot: true,
  triggerWords: [],
  randomReplyPercent: 0,
  randomReplyCooldown: 60,
};

const DEFAULT_CONFIG: AiConfigPublic = {
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

export function BotAiSettingsPage() {
  const { botId } = useParams<{ botId: string }>();
  const [config, setConfig] = useState<AiConfigPublic>(DEFAULT_CONFIG);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  // New group form
  const [triggerWordsText, setTriggerWordsText] = useState("");
  const [newChatId, setNewChatId] = useState("");
  const [newChatTitle, setNewChatTitle] = useState("");

  const loadConfig = useCallback(async () => {
    if (!botId) return;
    try {
      const res = await client.api.bots[":botId"]["ai-config"].$get({ param: { botId } });
      const json = await res.json();
      if (json.ok) {
        setConfig(json.data);
        setTriggerWordsText(json.data.triggerConfig.triggerWords.join(", "));
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
        },
      });
      const json = await res.json();
      if (json.ok) {
        setConfig(json.data);
        setTriggerWordsText(json.data.triggerConfig.triggerWords.join(", "));
        setApiKey("");
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

  const handleFetchModels = async () => {
    if (!botId) return;
    setFetchingModels(true);
    try {
      const res = await client.api.bots[":botId"]["ai-models"].$post({
        param: { botId },
        json: {
          baseURL: config.baseURL || undefined,
          apiKey: apiKey || undefined,
        },
      });
      const json = await res.json();
      if (json.ok) {
        setModels(json.data);
      } else {
        setMessage({
          type: "error",
          text: "error" in json ? String(json.error) : "Failed to fetch models",
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to fetch models" });
    } finally {
      setFetchingModels(false);
    }
  };

  const updateTrigger = (
    key: keyof AiTriggerConfig,
    value: AiTriggerConfig[keyof AiTriggerConfig],
  ) => {
    setConfig((prev) => ({
      ...prev,
      triggerConfig: { ...prev.triggerConfig, [key]: value },
    }));
  };

  const addGroupOverride = () => {
    const chatId = Number(newChatId);
    if (Number.isNaN(chatId) || chatId === 0) return;
    const key = String(chatId);
    if (config.groupOverrides[key]) return;
    const override: AiGroupOverride = {
      chatId,
      chatTitle: newChatTitle || undefined,
      whitelisted: false,
    };
    setConfig((prev) => ({
      ...prev,
      groupOverrides: { ...prev.groupOverrides, [key]: override },
    }));
    setNewChatId("");
    setNewChatTitle("");
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

      {message && (
        <div
          className={`rounded-md p-3 text-sm ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}
        >
          {message.text}
        </div>
      )}

      {/* Global Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Global AI Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="aiEnabled"
              checked={config.enabled}
              onChange={(e) => setConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
              className="border-input h-4 w-4 rounded"
            />
            <label htmlFor="aiEnabled" className="text-sm font-medium">
              Enable AI Reply
            </label>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Base URL</label>
            <Input
              value={config.baseURL}
              onChange={(e) => setConfig((prev) => ({ ...prev, baseURL: e.target.value }))}
              placeholder="https://api.openai.com/v1/"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                ["OpenAI", "https://api.openai.com/v1/"],
                ["DeepSeek", "https://api.deepseek.com/"],
              ].map(([name, url]) => (
                <button
                  key={name}
                  type="button"
                  className="text-muted-foreground hover:text-foreground rounded border px-2 py-0.5 text-xs"
                  onClick={() => setConfig((prev) => ({ ...prev, baseURL: url! }))}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config.hasApiKey ? "Key configured (leave empty to keep)" : "sk-..."}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Model</label>
            <div className="flex gap-2">
              <Input
                value={config.model}
                onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
                placeholder="gpt-4o"
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleFetchModels}
                disabled={fetchingModels}
              >
                {fetchingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : "Fetch Models"}
              </Button>
            </div>
            {models.length > 0 && (
              <select
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
                value={config.model}
                onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
              >
                <option value="">Select a model...</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Behavioral Prompt</label>
            <textarea
              className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              value={config.behavioralPrompt ?? ""}
              onChange={(e) => setConfig((prev) => ({ ...prev, behavioralPrompt: e.target.value }))}
              placeholder="General behavioral instructions (persona, tone, rules...). Injected before system prompt for both private and group chats."
            />
            <p className="text-muted-foreground text-xs">
              Injected before the system prompt in all chats (private + group).
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Group Behavioral Prompt</label>
            <textarea
              className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              value={config.groupBehavioralPrompt ?? ""}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, groupBehavioralPrompt: e.target.value }))
              }
              placeholder="Group-only behavioral instructions (group etiquette, multi-user rules...). Only injected in group chats."
            />
            <p className="text-muted-foreground text-xs">
              Only injected in group chats, after the general behavioral prompt.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">System Prompt</label>
            <textarea
              className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              value={config.systemPrompt}
              onChange={(e) => setConfig((prev) => ({ ...prev, systemPrompt: e.target.value }))}
              placeholder="You are a helpful assistant..."
            />
          </div>
        </CardContent>
      </Card>

      {/* Default Trigger Config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Default Trigger Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="replyToBot"
              checked={config.triggerConfig.replyToBot}
              onChange={(e) => updateTrigger("replyToBot", e.target.checked)}
              className="border-input h-4 w-4 rounded"
            />
            <label htmlFor="replyToBot" className="text-sm">
              Trigger when replying to bot
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="mentionBot"
              checked={config.triggerConfig.mentionBot}
              onChange={(e) => updateTrigger("mentionBot", e.target.checked)}
              className="border-input h-4 w-4 rounded"
            />
            <label htmlFor="mentionBot" className="text-sm">
              Trigger when @mentioning bot
            </label>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Trigger Words</label>
            <Input
              value={triggerWordsText}
              onChange={(e) => setTriggerWordsText(e.target.value)}
              onBlur={() =>
                updateTrigger(
                  "triggerWords",
                  triggerWordsText
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              placeholder="ai, help, ask"
            />
            <p className="text-muted-foreground text-xs">
              Comma-separated keywords (case-insensitive)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Random Reply %</label>
              <Input
                type="number"
                min={0}
                max={100}
                value={config.triggerConfig.randomReplyPercent}
                onChange={(e) => updateTrigger("randomReplyPercent", Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Cooldown (seconds)</label>
              <Input
                type="number"
                min={0}
                value={config.triggerConfig.randomReplyCooldown}
                onChange={(e) => updateTrigger("randomReplyCooldown", Number(e.target.value))}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Conversation History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversation History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Basic Settings */}
          <div className="space-y-4">
            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Basic Settings
            </p>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="convEnabled"
                checked={convCfg.enabled}
                onChange={(e) => updateConv({ enabled: e.target.checked })}
                className="border-input h-4 w-4 rounded"
              />
              <label htmlFor="convEnabled" className="text-sm font-medium">
                Enable Conversation History
              </label>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">History Format</label>
              <select
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
                disabled={!convCfg.enabled}
                value={convCfg.historyFormat ?? "prompt"}
                onChange={(e) =>
                  updateConv({
                    historyFormat: e.target.value as ConversationConfig["historyFormat"],
                  })
                }
              >
                <option value="prompt">Prompt (recommended)</option>
                <option value="messages">Messages</option>
              </select>
              <p className="text-muted-foreground text-xs">
                Prompt: pack history into system prompt, best compatibility. Messages: standard
                multi-turn format, only for models with native multi-turn support.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Max Context Messages</label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  disabled={!convCfg.enabled}
                  value={convCfg.maxContextMessages}
                  onChange={(e) => updateConv({ maxContextMessages: Number(e.target.value) })}
                />
                <p className="text-muted-foreground text-xs">Messages sent to LLM (1-100)</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Retention Days</label>
                <Input
                  type="number"
                  min={0}
                  max={365}
                  disabled={!convCfg.enabled}
                  value={convCfg.retentionDays}
                  onChange={(e) => updateConv({ retentionDays: Number(e.target.value) })}
                />
                <p className="text-muted-foreground text-xs">0 = keep forever</p>
              </div>
            </div>
          </div>

          {/* Group Chat Settings */}
          <div className="space-y-4 border-t pt-4">
            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Group Chat Settings
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Group Buffer Size</label>
              <Input
                type="number"
                min={10}
                max={200}
                disabled={!convCfg.enabled}
                value={convCfg.groupBufferSize}
                onChange={(e) => updateConv({ groupBufferSize: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                In-memory ring buffer capacity for group messages
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Include Group Context</label>
                <select
                  className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
                  disabled={!convCfg.enabled}
                  value={convCfg.groupContextMode}
                  onChange={(e) =>
                    updateConv({
                      groupContextMode: e.target.value as ConversationConfig["groupContextMode"],
                    })
                  }
                >
                  <option value="all">All triggers</option>
                  <option value="random_only">Random reply only</option>
                  <option value="none">Never</option>
                </select>
                <p className="text-muted-foreground text-xs">
                  When to include recent group messages in LLM context
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Save Group Context</label>
                <select
                  className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
                  disabled={!convCfg.enabled}
                  value={convCfg.saveGroupContext}
                  onChange={(e) =>
                    updateConv({
                      saveGroupContext: e.target.value as ConversationConfig["saveGroupContext"],
                    })
                  }
                >
                  <option value="random_only">Random reply only</option>
                  <option value="all">All triggers</option>
                  <option value="none">Never</option>
                </select>
                <p className="text-muted-foreground text-xs">
                  When to persist group context to database
                </p>
              </div>
            </div>
          </div>

          {/* Compression Settings */}
          <div className="space-y-4 border-t pt-4">
            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Compression Settings
            </p>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoSummarize"
                disabled={!convCfg.enabled}
                checked={convCfg.autoSummarize}
                onChange={(e) => updateConv({ autoSummarize: e.target.checked })}
                className="border-input h-4 w-4 rounded"
              />
              <label htmlFor="autoSummarize" className="text-sm font-medium">
                Auto-summarize with LLM
              </label>
              <span className="text-muted-foreground text-xs">
                (off = sliding window, old messages discarded)
              </span>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Summarize Threshold</label>
              <Input
                type="number"
                min={10}
                max={200}
                disabled={!convCfg.enabled}
                value={convCfg.summarizeThreshold}
                onChange={(e) => updateConv({ summarizeThreshold: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                Trigger compression when message count exceeds this
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Memory System */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Memory System</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="memoryEnabled"
              checked={memCfg.enabled}
              onChange={(e) => updateMemory({ enabled: e.target.checked })}
              className="border-input h-4 w-4 rounded"
            />
            <label htmlFor="memoryEnabled" className="text-sm font-medium">
              Enable Memory System
            </label>
          </div>
          <p className="text-muted-foreground text-xs">
            When enabled, the AI agent can autonomously manage per-person profiles and search
            conversation history via tool calls.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Max Steps</label>
              <Input
                type="number"
                min={1}
                max={10}
                disabled={!memCfg.enabled}
                value={memCfg.maxSteps}
                onChange={(e) => updateMemory({ maxSteps: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                Max tool-calling rounds per reply (1-10)
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Tool Choice</label>
              <select
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
                disabled={!memCfg.enabled}
                value={memCfg.toolChoice}
                onChange={(e) =>
                  updateMemory({ toolChoice: e.target.value as MemoryConfig["toolChoice"] })
                }
              >
                <option value="auto">Auto (recommended)</option>
                <option value="required">Required</option>
              </select>
              <p className="text-muted-foreground text-xs">
                Auto: LLM decides when to use tools. Required: must call at least one tool.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="autoReadProfile"
              disabled={!memCfg.enabled}
              checked={memCfg.autoReadProfile}
              onChange={(e) => updateMemory({ autoReadProfile: e.target.checked })}
              className="border-input h-4 w-4 rounded"
            />
            <label htmlFor="autoReadProfile" className="text-sm">
              Auto-read user profile before reply
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="autoUpdateLastSeen"
              disabled={!memCfg.enabled}
              checked={memCfg.autoUpdateLastSeen}
              onChange={(e) => updateMemory({ autoUpdateLastSeen: e.target.checked })}
              className="border-input h-4 w-4 rounded"
            />
            <label htmlFor="autoUpdateLastSeen" className="text-sm">
              Auto-update last seen on message
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Group Overrides */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Group Overrides</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {Object.entries(config.groupOverrides).map(([key, override]) => (
            <GroupOverrideRow
              key={key}
              groupKey={key}
              override={override}
              onUpdate={(updates) => updateOverride(key, updates)}
              onRemove={() => removeOverride(key)}
            />
          ))}

          <div className="border-t pt-4">
            <p className="mb-2 text-sm font-medium">Add Group</p>
            <div className="flex gap-2">
              <Input
                value={newChatId}
                onChange={(e) => setNewChatId(e.target.value)}
                placeholder="Chat ID (e.g. -1001234567)"
                className="flex-1"
              />
              <Input
                value={newChatTitle}
                onChange={(e) => setNewChatTitle(e.target.value)}
                placeholder="Title (optional)"
                className="flex-1"
              />
              <Button variant="outline" size="sm" onClick={addGroupOverride}>
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              Use @RawDataBot on Telegram to find a group's chat ID
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GroupOverrideRow({
  groupKey,
  override,
  onUpdate,
  onRemove,
}: {
  groupKey: string;
  override: AiGroupOverride;
  onUpdate: (updates: Partial<AiGroupOverride>) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-muted-foreground text-sm hover:underline"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "▼" : "▶"}
          </button>
          <span className="font-mono text-sm">{groupKey}</span>
          {override.chatTitle && (
            <span className="text-muted-foreground text-sm">({override.chatTitle})</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={override.whitelisted}
              onChange={(e) => onUpdate({ whitelisted: e.target.checked })}
              className="border-input h-4 w-4 rounded"
            />
            Whitelist
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={override.enabled ?? true}
              onChange={(e) => onUpdate({ enabled: e.target.checked })}
              className="border-input h-4 w-4 rounded"
            />
            Enabled
          </label>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 pl-6">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">System Prompt Override</label>
            <textarea
              className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              value={override.systemPrompt ?? ""}
              onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
              placeholder="Leave empty to use global prompt"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Trigger Overrides</p>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={override.triggerConfig?.replyToBot ?? true}
                onChange={(e) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, replyToBot: e.target.checked },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">Reply to bot</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={override.triggerConfig?.mentionBot ?? true}
                onChange={(e) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, mentionBot: e.target.checked },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">@Mention bot</span>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Conversation Overrides</p>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={override.conversationEnabled ?? true}
                onChange={(e) => onUpdate({ conversationEnabled: e.target.checked })}
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">Enable conversation history</span>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm">Max Context Messages</label>
              <Input
                type="number"
                min={1}
                max={100}
                value={override.maxContextMessages ?? ""}
                onChange={(e) =>
                  onUpdate({
                    maxContextMessages: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder="Follow global"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
