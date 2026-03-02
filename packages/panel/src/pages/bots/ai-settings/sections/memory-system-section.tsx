import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { MemoryConfig } from "@cos-tool-bot/shared";

export function MemorySystemSection({
  config,
  onUpdate,
}: {
  config: MemoryConfig;
  onUpdate: (updates: Partial<MemoryConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Memory System</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="memoryEnabled"
            checked={config.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Max Steps</label>
            <Input
              type="number"
              min={1}
              disabled={!config.enabled}
              value={config.maxSteps}
              onChange={(e) => onUpdate({ maxSteps: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">
              Max tool-calling rounds per reply (min 1)
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Tool Choice</label>
            <select
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled}
              value={config.toolChoice}
              onChange={(e) =>
                onUpdate({ toolChoice: e.target.value as MemoryConfig["toolChoice"] })
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
            disabled={!config.enabled}
            checked={config.autoReadProfile}
            onChange={(e) => onUpdate({ autoReadProfile: e.target.checked })}
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
            disabled={!config.enabled}
            checked={config.autoUpdateLastSeen}
            onChange={(e) => onUpdate({ autoUpdateLastSeen: e.target.checked })}
            className="border-input h-4 w-4 rounded"
          />
          <label htmlFor="autoUpdateLastSeen" className="text-sm">
            Auto-update last seen on message
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
