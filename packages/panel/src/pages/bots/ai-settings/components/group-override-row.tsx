import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import type { AiGroupOverride } from "@cos-tool-bot/shared";
import { ChevronRight, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";

export function GroupOverrideRow({
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
    <div className="overflow-hidden rounded-xl border bg-white">
      <div className="flex min-h-14 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3 self-stretch sm:self-auto">
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? "Collapse group settings" : "Expand group settings"}
            aria-expanded={expanded}
          >
            <ChevronRight
              className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
          <span className="flex size-8 items-center justify-center rounded-full bg-blue-50 text-blue-600">
            <UsersRound className="size-4" />
          </span>
          <span className="truncate font-mono text-sm">{groupKey}</span>
          {override.chatTitle && (
            <span className="text-muted-foreground text-sm">({override.chatTitle})</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 self-stretch sm:self-auto">
          <label
            className="flex items-center gap-1.5 text-sm"
            title="Allow all users in this group to trigger the bot. When off, only admins can use it."
          >
            <Switch
              checked={override.whitelisted}
              onCheckedChange={(whitelisted) => onUpdate({ whitelisted })}
            />
            Allow All Users
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <Switch
              checked={override.enabled ?? true}
              onCheckedChange={(enabled) => onUpdate({ enabled })}
            />
            Enabled
          </label>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.confirm(`Remove group ${groupKey}?`) && onRemove()}
            aria-label={`Remove group ${groupKey}`}
            className="ml-auto text-red-500 hover:bg-red-50 hover:text-red-700 sm:ml-0"
          >
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-5 border-t bg-slate-50/50 px-4 py-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">System Prompt Override</label>
            <Textarea
              className="min-h-20"
              value={override.systemPrompt ?? ""}
              onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
              placeholder="Leave empty to use global prompt"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Trigger Overrides</p>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.triggerConfig?.replyToBot ?? true}
                onCheckedChange={(checked) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, replyToBot: checked === true },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">Reply to bot</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.triggerConfig?.mentionBot ?? true}
                onCheckedChange={(checked) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, mentionBot: checked === true },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">@Mention bot</span>
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Conversation Overrides</p>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.conversationEnabled ?? true}
                onCheckedChange={(checked) => onUpdate({ conversationEnabled: checked === true })}
              />
              <span className="text-sm">Enable conversation history</span>
            </label>
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

          <div className="space-y-2">
            <p className="text-sm font-medium">Tools Overrides</p>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.imageGenerationEnabled ?? false}
                onCheckedChange={(checked) =>
                  onUpdate({ imageGenerationEnabled: checked === true })
                }
              />
              <span className="text-sm">Enable image generation for all users</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
