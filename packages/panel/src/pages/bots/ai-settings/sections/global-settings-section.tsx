import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AiConfigPublic } from "@cos-tool-bot/shared";

export function GlobalSettingsSection({
  config,
  apiKey,
  onConfigChange,
  onApiKeyChange,
}: {
  config: AiConfigPublic;
  apiKey: string;
  onConfigChange: (updates: Partial<AiConfigPublic>) => void;
  onApiKeyChange: (key: string) => void;
}) {
  return (
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
            onChange={(e) => onConfigChange({ enabled: e.target.checked })}
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
            onChange={(e) => onConfigChange({ baseURL: e.target.value })}
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
                onClick={() => onConfigChange({ baseURL: url! })}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Provider Format</label>
          <select
            className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
            value={config.providerFormat ?? "openai"}
            onChange={(e) =>
              onConfigChange({
                providerFormat: e.target.value as "openai" | "gemini",
              })
            }
          >
            <option value="openai">OpenAI Compatible</option>
            <option value="gemini">Gemini Native</option>
          </select>
          <p className="text-muted-foreground text-xs">
            Gemini 原生格式支持隐式缓存和缓存命中诊断。需将 Base URL 设为代理的 Gemini 端点（如
            /v1beta）。
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">API Key</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={config.hasApiKey ? "Key configured (leave empty to keep)" : "sk-..."}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Default Model</label>
          <div className="flex gap-2">
            <Input
              value={config.model}
              onChange={(e) => onConfigChange({ model: e.target.value })}
              placeholder="gpt-4o"
              className="flex-1"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            The default model used for AI replies. Configure additional models below.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Behavioral Prompt</label>
          <textarea
            className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            value={config.behavioralPrompt ?? ""}
            onChange={(e) => onConfigChange({ behavioralPrompt: e.target.value })}
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
            onChange={(e) => onConfigChange({ groupBehavioralPrompt: e.target.value })}
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
            onChange={(e) => onConfigChange({ systemPrompt: e.target.value })}
            placeholder="You are a helpful assistant..."
          />
        </div>
      </CardContent>
    </Card>
  );
}
