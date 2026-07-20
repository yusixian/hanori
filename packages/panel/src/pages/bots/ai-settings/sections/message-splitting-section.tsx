import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { BotWithStatus, MessageConfig, ReplyMode } from "@cos-tool-bot/shared";
import { isRichMessageEnabled } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function MessageSplittingSection({
  config,
  platform,
  onUpdate,
}: {
  config: MessageConfig;
  platform?: BotWithStatus["platform"];
  onUpdate: (updates: Partial<MessageConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("messageSplitting.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {platform === "telegram" && (
          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-1">
              <label htmlFor="richMessageEnabled" className="text-sm font-medium">
                {t("messageSplitting.richMessage")}
              </label>
              <p className="text-muted-foreground text-xs">
                {t("messageSplitting.richMessageDescription")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("messageSplitting.richMessageCommand")}
              </p>
            </div>
            <Switch
              id="richMessageEnabled"
              checked={isRichMessageEnabled(config)}
              onCheckedChange={(richMessageEnabled) => onUpdate({ richMessageEnabled })}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("messageSplitting.replyMode")}</label>
          <Select
            className="w-full"
            value={config.replyMode ?? "stream"}
            onChange={(e) => onUpdate({ replyMode: e.target.value as ReplyMode })}
          >
            <option value="stream">{t("messageSplitting.streamOption")}</option>
            <option value="segment">{t("messageSplitting.segmentOption")}</option>
          </Select>
          <p className="text-muted-foreground text-xs">
            {t("messageSplitting.replyModeDescription")}
          </p>
        </div>

        {(config.replyMode ?? "stream") === "segment" && (
          <>
            <hr className="border-border" />

            <p className="text-muted-foreground text-xs">
              {t("messageSplitting.segmentDescription")}
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t("messageSplitting.autoSplitThreshold")}
                </label>
                <Input
                  type="number"
                  min={0}
                  max={4096}
                  value={config.autoSplitThreshold}
                  onChange={(e) => onUpdate({ autoSplitThreshold: Number(e.target.value) })}
                />
                <p className="text-muted-foreground text-xs">
                  {t("messageSplitting.autoSplitThresholdDescription")}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("messageSplitting.splitDelay")}</label>
                <Input
                  type="number"
                  min={0}
                  max={5000}
                  disabled={config.autoSplitThreshold === 0}
                  value={config.splitDelayMs}
                  onChange={(e) => onUpdate({ splitDelayMs: Number(e.target.value) })}
                />
                <p className="text-muted-foreground text-xs">
                  {t("messageSplitting.splitDelayDescription")}
                </p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
