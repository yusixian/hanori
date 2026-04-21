import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import type { ModelCapability, ModelEntry } from "@cos-tool-bot/shared";
import { inferCapabilities } from "@cos-tool-bot/shared";
import { Minus, Settings } from "lucide-react";
import { CAPABILITY_BADGES } from "../types";

export function ModelRow({
  entry,
  isActive,
  onSetActive,
  onRemove,
  onUpdate,
}: {
  entry: ModelEntry;
  isActive: boolean;
  onSetActive: () => void;
  onRemove: () => void;
  onUpdate: (updates: Partial<ModelEntry>) => void;
}) {
  const capabilities = entry.capabilities ?? inferCapabilities(entry.id);

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${isActive ? "bg-primary/10 border-primary/30" : "hover:bg-accent/50 border-transparent"}`}
    >
      <button
        type="button"
        className={`h-3 w-3 shrink-0 rounded-full border-2 ${isActive ? "border-primary bg-primary" : "border-muted-foreground/40"}`}
        onClick={onSetActive}
        title={isActive ? "Current default" : "Set as default"}
      />
      <span className="flex-1 truncate font-mono text-xs">{entry.id}</span>
      {entry.label && <span className="text-muted-foreground text-xs">({entry.label})</span>}
      <span className="flex gap-0.5">
        {capabilities.map((cap) => (
          <Badge
            key={cap}
            variant="muted"
            title={CAPABILITY_BADGES[cap]?.label ?? cap}
            className="px-1 py-0 text-[10px]"
          >
            {CAPABILITY_BADGES[cap]?.emoji ?? cap}
          </Badge>
        ))}
      </span>
      <Popover
        trigger={
          <button type="button" className="text-muted-foreground hover:text-foreground p-0.5">
            <Settings className="h-3.5 w-3.5" />
          </button>
        }
        className="w-64 p-3"
      >
        <div className="space-y-3">
          <p className="text-xs font-medium">Model Settings</p>
          <div className="space-y-1.5">
            <label className="text-xs">Label</label>
            <Input
              value={entry.label ?? ""}
              onChange={(e) => onUpdate({ label: e.target.value || undefined })}
              placeholder="Display name"
              className="h-7 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs">Temperature</label>
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={entry.temperature ?? ""}
                onChange={(e) =>
                  onUpdate({ temperature: e.target.value ? Number(e.target.value) : undefined })
                }
                placeholder="default"
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs">Max Tokens</label>
              <Input
                type="number"
                min={1}
                value={entry.maxTokens ?? ""}
                onChange={(e) =>
                  onUpdate({ maxTokens: e.target.value ? Number(e.target.value) : undefined })
                }
                placeholder="default"
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs">Thinking</label>
              <select
                value={entry.thinking ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  onUpdate({
                    thinking: val === "enabled" || val === "disabled" ? val : undefined,
                  });
                }}
                className="border-input bg-background h-7 w-full rounded border px-2 text-xs"
              >
                <option value="">Default</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs">Thinking Budget</label>
              <Input
                type="number"
                value={entry.thinkingBudget ?? ""}
                onChange={(e) =>
                  onUpdate({
                    thinkingBudget: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder="default"
                className="h-7 text-xs"
                disabled={!entry.thinking}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs">Capabilities</label>
            <div className="flex flex-wrap gap-1">
              {(
                Object.entries(CAPABILITY_BADGES) as [
                  ModelCapability,
                  { emoji: string; label: string },
                ][]
              ).map(([cap, badge]) => {
                const hasCap = capabilities.includes(cap);
                return (
                  <button
                    key={cap}
                    type="button"
                    className={`rounded border px-1.5 py-0.5 text-xs ${hasCap ? "bg-primary/10 border-primary/30" : "border-transparent opacity-40"}`}
                    onClick={() => {
                      const next = hasCap
                        ? capabilities.filter((c) => c !== cap)
                        : [...capabilities, cap];
                      onUpdate({ capabilities: next });
                    }}
                  >
                    {badge.emoji} {badge.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Popover>
      <button
        type="button"
        className="text-muted-foreground p-0.5 hover:text-red-500"
        onClick={onRemove}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
