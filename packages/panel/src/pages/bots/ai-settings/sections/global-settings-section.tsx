import type { AiConfigPublic } from "@cos-tool-bot/shared";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

export function GlobalSettingsSection({
  config,
  onConfigChange,
}: {
  config: AiConfigPublic;
  onConfigChange: (updates: Partial<AiConfigPublic>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <div className="space-y-4 p-1">
      <div className="space-y-1.5">
        <Label>{t("globalSettings.behavioralPrompt")}</Label>
        <Textarea
          value={config.behavioralPrompt ?? ""}
          onChange={(e) => onConfigChange({ behavioralPrompt: e.target.value })}
          placeholder={t("globalSettings.behavioralPromptPlaceholder")}
        />
        <p className="text-muted-foreground text-xs">
          {t("globalSettings.behavioralPromptDescription")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t("globalSettings.groupBehavioralPrompt")}</Label>
        <Textarea
          value={config.groupBehavioralPrompt ?? ""}
          onChange={(e) => onConfigChange({ groupBehavioralPrompt: e.target.value })}
          placeholder={t("globalSettings.groupBehavioralPromptPlaceholder")}
        />
        <p className="text-muted-foreground text-xs">
          {t("globalSettings.groupBehavioralPromptDescription")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t("globalSettings.systemPrompt")}</Label>
        <Textarea
          value={config.systemPrompt}
          onChange={(e) => onConfigChange({ systemPrompt: e.target.value })}
          placeholder={t("globalSettings.systemPromptPlaceholder")}
        />
      </div>
    </div>
  );
}
