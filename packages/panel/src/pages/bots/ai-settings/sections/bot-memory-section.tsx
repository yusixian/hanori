import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { BotMemoryConfig } from "@cos-tool-bot/shared";

export function BotMemorySection({
  config,
  onUpdate,
}: {
  config: BotMemoryConfig;
  onUpdate: (updates: Partial<BotMemoryConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Bot Memory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="botMemoryEnabled"
            checked={config.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            className="border-input h-4 w-4 rounded"
          />
          <label htmlFor="botMemoryEnabled" className="text-sm font-medium">
            Enable Bot Memory
          </label>
        </div>
        <p className="text-muted-foreground text-xs">
          Persistent long-term memory for the bot. Stores facts, rules, preferences and
          user-specific notes across conversations. The AI can save and recall memories via tool
          calls.
        </p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Max Memories in Prompt</label>
          <Input
            type="number"
            min={1}
            max={100}
            disabled={!config.enabled}
            value={config.maxMemories}
            onChange={(e) => onUpdate({ maxMemories: Number(e.target.value) })}
          />
          <p className="text-muted-foreground text-xs">
            Maximum number of memories injected into system prompt (1-100)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="autoInjectMemories"
            disabled={!config.enabled}
            checked={config.autoInjectMemories}
            onChange={(e) => onUpdate({ autoInjectMemories: e.target.checked })}
            className="border-input h-4 w-4 rounded"
          />
          <label htmlFor="autoInjectMemories" className="text-sm">
            Auto-inject memories into system prompt
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
