import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { MessageConfig } from "@cos-tool-bot/shared";

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
        <CardTitle className="text-base">Message Splitting</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
