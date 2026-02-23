import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AiGroupOverride } from "@cos-tool-bot/shared";
import { Trash2 } from "lucide-react";
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
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-muted-foreground text-sm hover:underline"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "▼" : "▶"}
          </button>
          <span className="font-mono text-sm">{groupKey}</span>
          {override.chatTitle && (
            <span className="text-muted-foreground text-sm">({override.chatTitle})</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label
            className="flex items-center gap-1.5 text-sm"
            title="Allow all users in this group to trigger the bot. When off, only admins can use it."
          >
            <input
              type="checkbox"
              checked={override.whitelisted}
              onChange={(e) => onUpdate({ whitelisted: e.target.checked })}
              className="border-input h-4 w-4 rounded"
            />
            Allow All Users
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={override.enabled ?? true}
              onChange={(e) => onUpdate({ enabled: e.target.checked })}
              className="border-input h-4 w-4 rounded"
            />
            Enabled
          </label>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 pl-6">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">System Prompt Override</label>
            <textarea
              className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              value={override.systemPrompt ?? ""}
              onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
              placeholder="Leave empty to use global prompt"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Trigger Overrides</p>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={override.triggerConfig?.replyToBot ?? true}
                onChange={(e) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, replyToBot: e.target.checked },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">Reply to bot</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={override.triggerConfig?.mentionBot ?? true}
                onChange={(e) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, mentionBot: e.target.checked },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">@Mention bot</span>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Conversation Overrides</p>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={override.conversationEnabled ?? true}
                onChange={(e) => onUpdate({ conversationEnabled: e.target.checked })}
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">Enable conversation history</span>
            </div>
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
        </div>
      )}
    </div>
  );
}
