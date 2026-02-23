import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ConversationConfig } from "@cos-tool-bot/shared";

export function ConversationSection({
  config,
  onUpdate,
}: {
  config: ConversationConfig;
  onUpdate: (updates: Partial<ConversationConfig>) => void;
}) {
  return (
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
              checked={config.enabled}
              onChange={(e) => onUpdate({ enabled: e.target.checked })}
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
              disabled={!config.enabled}
              value={config.historyFormat ?? "prompt"}
              onChange={(e) =>
                onUpdate({
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Max Context Messages</label>
              <Input
                type="number"
                min={1}
                max={100}
                disabled={!config.enabled}
                value={config.maxContextMessages}
                onChange={(e) => onUpdate({ maxContextMessages: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">Messages sent to LLM (1-100)</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Retention Days</label>
              <Input
                type="number"
                min={0}
                max={365}
                disabled={!config.enabled}
                value={config.retentionDays}
                onChange={(e) => onUpdate({ retentionDays: Number(e.target.value) })}
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
              disabled={!config.enabled}
              value={config.groupBufferSize}
              onChange={(e) => onUpdate({ groupBufferSize: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">
              In-memory ring buffer capacity for group messages
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Include Group Context</label>
              <select
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
                disabled={!config.enabled}
                value={config.groupContextMode}
                onChange={(e) =>
                  onUpdate({
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
                disabled={!config.enabled}
                value={config.saveGroupContext}
                onChange={(e) =>
                  onUpdate({
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
              disabled={!config.enabled}
              checked={config.autoSummarize}
              onChange={(e) => onUpdate({ autoSummarize: e.target.checked })}
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
              disabled={!config.enabled}
              value={config.summarizeThreshold}
              onChange={(e) => onUpdate({ summarizeThreshold: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">
              Trigger compression when message count exceeds this
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
