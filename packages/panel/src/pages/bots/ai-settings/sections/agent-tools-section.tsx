import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AgentToolsConfig } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function AgentToolsSection({
  config,
  onUpdate,
}: {
  config: AgentToolsConfig;
  onUpdate: (updates: Partial<AgentToolsConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("agentTools.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="agentToolsEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="agentToolsEnabled" className="text-sm font-medium">
            {t("agentTools.enable")}
          </label>
        </div>
        <p className="text-muted-foreground text-xs">{t("agentTools.description")}</p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("agentTools.model")}</label>
          <Input
            disabled={!config.enabled}
            value={config.subAgentModel ?? ""}
            onChange={(e) => onUpdate({ subAgentModel: e.target.value || undefined })}
            placeholder={t("agentTools.modelPlaceholder")}
          />
          <p className="text-muted-foreground text-xs">{t("agentTools.modelDescription")}</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("agentTools.maxSteps")}</label>
          <Input
            type="number"
            min={1}
            max={15}
            disabled={!config.enabled}
            value={config.maxSubAgentSteps ?? 5}
            onChange={(e) => onUpdate({ maxSubAgentSteps: Number(e.target.value) })}
          />
          <p className="text-muted-foreground text-xs">{t("agentTools.maxStepsDescription")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
