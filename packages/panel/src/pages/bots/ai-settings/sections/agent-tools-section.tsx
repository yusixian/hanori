import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AgentToolsConfig } from "@cos-tool-bot/shared";

export function AgentToolsSection({
  config,
  onUpdate,
}: {
  config: AgentToolsConfig;
  onUpdate: (updates: Partial<AgentToolsConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent Tools</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="agentToolsEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="agentToolsEnabled" className="text-sm font-medium">
            Enable Agent Tools
          </label>
        </div>
        <p className="text-muted-foreground text-xs">
          Allow the AI to delegate tasks to sub-agents for complex multi-step work.
        </p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Sub-agent Model</label>
          <Input
            disabled={!config.enabled}
            value={config.subAgentModel ?? ""}
            onChange={(e) => onUpdate({ subAgentModel: e.target.value || undefined })}
            placeholder="Leave empty to use main model"
          />
          <p className="text-muted-foreground text-xs">
            Optional model for sub-agents. Leave empty to use the same model as the main AI.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Max Sub-agent Steps</label>
          <Input
            type="number"
            min={1}
            max={15}
            disabled={!config.enabled}
            value={config.maxSubAgentSteps ?? 5}
            onChange={(e) => onUpdate({ maxSubAgentSteps: Number(e.target.value) })}
          />
          <p className="text-muted-foreground text-xs">
            Maximum tool-calling rounds per sub-agent (1-15)
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
