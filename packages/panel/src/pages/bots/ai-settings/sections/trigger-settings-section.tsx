import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { settingInputBounds } from "@/lib/setting-input-bounds";
import { AI_SETTING_BOUNDS, type AiTriggerConfig } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function TriggerSettingsSection({
  config,
  triggerWordsText,
  onTriggerWordsTextChange,
  onUpdate,
}: {
  config: AiTriggerConfig;
  triggerWordsText: string;
  onTriggerWordsTextChange: (text: string) => void;
  onUpdate: (key: keyof AiTriggerConfig, value: AiTriggerConfig[keyof AiTriggerConfig]) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("triggerSettings.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="replyToBot"
            checked={config.replyToBot}
            onCheckedChange={(checked) => onUpdate("replyToBot", checked)}
          />
          <label htmlFor="replyToBot" className="text-sm">
            {t("triggerSettings.replyToBot")}
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="mentionBot"
            checked={config.mentionBot}
            onCheckedChange={(checked) => onUpdate("mentionBot", checked)}
          />
          <label htmlFor="mentionBot" className="text-sm">
            {t("triggerSettings.mentionBot")}
          </label>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("triggerSettings.triggerWords")}</label>
          <Input
            value={triggerWordsText}
            onChange={(e) => onTriggerWordsTextChange(e.target.value)}
            onBlur={() =>
              onUpdate(
                "triggerWords",
                triggerWordsText
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="ai, help, ask"
          />
          <p className="text-muted-foreground text-xs">
            {t("triggerSettings.triggerWordsDescription")}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("triggerSettings.randomReply")}</label>
            <Input
              type="number"
              {...settingInputBounds(AI_SETTING_BOUNDS.randomReplyPercent)}
              value={config.randomReplyPercent}
              onChange={(e) => onUpdate("randomReplyPercent", Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("triggerSettings.cooldown")}</label>
            <Input
              type="number"
              {...settingInputBounds(AI_SETTING_BOUNDS.randomReplyCooldown)}
              value={config.randomReplyCooldown}
              onChange={(e) => onUpdate("randomReplyCooldown", Number(e.target.value))}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
