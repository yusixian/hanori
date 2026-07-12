import type { AiConfigPublic } from "@cos-tool-bot/shared";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function GlobalSettingsSection({
  config,
  onConfigChange,
}: {
  config: AiConfigPublic;
  onConfigChange: (updates: Partial<AiConfigPublic>) => void;
}) {
  return (
    <div className="space-y-4 p-1">
      <div className="space-y-1.5">
        <Label>Behavioral Prompt</Label>
        <Textarea
          value={config.behavioralPrompt ?? ""}
          onChange={(e) => onConfigChange({ behavioralPrompt: e.target.value })}
          placeholder="General behavioral instructions (persona, tone, rules...). Injected before system prompt for both private and group chats."
        />
        <p className="text-muted-foreground text-xs">
          Injected before the system prompt in all chats (private + group).
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Group Behavioral Prompt</Label>
        <Textarea
          value={config.groupBehavioralPrompt ?? ""}
          onChange={(e) => onConfigChange({ groupBehavioralPrompt: e.target.value })}
          placeholder="Group-only behavioral instructions (group etiquette, multi-user rules...). Only injected in group chats."
        />
        <p className="text-muted-foreground text-xs">
          Only injected in group chats, after the general behavioral prompt.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>System Prompt</Label>
        <Textarea
          value={config.systemPrompt}
          onChange={(e) => onConfigChange({ systemPrompt: e.target.value })}
          placeholder="You are a helpful assistant..."
        />
      </div>
    </div>
  );
}
