import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import { Popover } from "@/components/ui/popover";
import type { ModelCapability, ModelEntry } from "@cos-tool-bot/shared";
import { inferCapabilities } from "@cos-tool-bot/shared";
import { Minus, Settings } from "lucide-react";
import { CAPABILITY_BADGES } from "../types";
import type { ReactNode } from "react";

export function ModelRow({
  entry,
  isActive,
  radioControl,
  onRemove,
  onUpdate,
}: {
  entry: ModelEntry;
  isActive: boolean;
  radioControl: ReactNode;
  onRemove: () => void;
  onUpdate: (updates: Partial<ModelEntry>) => void;
}) {
  const capabilities = entry.capabilities ?? inferCapabilities(entry.id);

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${isActive ? "bg-primary/10 border-primary/30" : "hover:bg-accent/50 border-transparent"}`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center">{radioControl}</span>
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
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-8 items-center justify-center rounded-lg focus-visible:ring-2"
            aria-label={`Configure ${entry.id}`}
          >
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
              <SelectMenu
                value={entry.thinking ?? "default"}
                onValueChange={(val) => {
                  onUpdate({
                    thinking: val === "enabled" || val === "disabled" ? val : undefined,
                  });
                }}
                className="border-input bg-background h-7 w-full rounded border px-2 text-xs"
                placeholder="Default"
                ariaLabel="Thinking mode"
                options={[
                  { value: "default", label: "Default" },
                  { value: "enabled", label: "Enabled" },
                  { value: "disabled", label: "Disabled" },
                ]}
              />
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
        className="text-muted-foreground focus-visible:ring-ring flex size-8 items-center justify-center rounded-lg hover:bg-red-50 hover:text-red-500 focus-visible:ring-2"
        onClick={() => window.confirm(`Remove model “${entry.id}”?`) && onRemove()}
        aria-label={`Remove ${entry.id}`}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
