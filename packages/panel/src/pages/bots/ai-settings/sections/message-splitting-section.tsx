import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { MessageConfig, ReplyMode } from "@cos-tool-bot/shared";

export function MessageSplittingSection({
  config,
  onUpdate,
}: {
  config: MessageConfig;
  onUpdate: (updates: Partial<MessageConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Reply Mode & Message Splitting</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Reply Mode</label>
          <Select
            className="w-full"
            value={config.replyMode ?? "stream"}
            onChange={(e) => onUpdate({ replyMode: e.target.value as ReplyMode })}
          >
            <option value="stream">Stream (real-time draft animation)</option>
            <option value="segment">Segment (multi_message tool, human-like)</option>
          </Select>
          <p className="text-muted-foreground text-xs">
            Stream: text appears character by character using Telegram draft. Segment: AI splits
            reply into 2-5 messages with typing delay via multi_message tool.
          </p>
        </div>

        <hr className="border-border" />

        <p className="text-muted-foreground text-xs">
          When the AI reply exceeds the threshold, it is automatically split at natural boundaries
          (paragraphs, lines, sentences) and sent as multiple messages with typing delay. Set
          threshold to 0 to disable.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Auto-Split Threshold</label>
            <Input
              type="number"
              min={0}
              max={4096}
              value={config.autoSplitThreshold}
              onChange={(e) => onUpdate({ autoSplitThreshold: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">
              0 = disabled. Recommended: 1500-2500. Max per chunk: 4096 (Telegram limit).
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Split Delay (ms)</label>
            <Input
              type="number"
              min={0}
              max={5000}
              disabled={config.autoSplitThreshold === 0}
              value={config.splitDelayMs}
              onChange={(e) => onUpdate({ splitDelayMs: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">
              Delay between split messages. Shows typing indicator.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
