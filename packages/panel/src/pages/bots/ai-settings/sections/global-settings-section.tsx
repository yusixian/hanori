import type { AiConfigPublic } from "@cos-tool-bot/shared";

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
    </div>
  );
}
