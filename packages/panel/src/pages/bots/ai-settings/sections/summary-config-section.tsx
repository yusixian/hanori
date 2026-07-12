import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SummaryConfigStored } from "@cos-tool-bot/shared";
import { Link } from "react-router";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "react-i18next";

export function SummaryConfigSection({
  botId,
  config,
  onUpdate,
}: {
  botId: string;
  config: SummaryConfigStored;
  onUpdate: (updates: Partial<SummaryConfigStored>) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const roleOptions: Array<"user" | "context" | "assistant"> = ["user", "context", "assistant"];
  const currentRoleFilter = config.roleFilter ?? ["user", "context", "assistant"];

  const toggleRole = (role: "user" | "context" | "assistant") => {
    const next = currentRoleFilter.includes(role)
      ? currentRoleFilter.filter((r) => r !== role)
      : [...currentRoleFilter, role];
    onUpdate({ roleFilter: next });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("summary.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          {t("summary.descriptionBefore")}{" "}
          <Link to={`/bots/${botId}/summary`} className="underline hover:opacity-80">
            {t("summary.pageLink")}
          </Link>{" "}
          {t("summary.descriptionAfter")}
        </p>

        <div className="flex items-center gap-2">
          <Switch
            id="summaryEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="summaryEnabled" className="text-sm font-medium">
            {t("summary.enable")}
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("summary.defaultWindow")}</label>
            <Input
              type="number"
              min={1}
              max={72}
              value={config.defaultWindowHours}
              onChange={(e) => onUpdate({ defaultWindowHours: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("summary.maxMessages")}</label>
            <Input
              type="number"
              min={10}
              max={2000}
              value={config.defaultMaxMessages}
              onChange={(e) => onUpdate({ defaultMaxMessages: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("summary.defaultCooldown")}</label>
            <Input
              type="number"
              min={0}
              max={86400}
              value={config.defaultCooldownSeconds}
              onChange={(e) => onUpdate({ defaultCooldownSeconds: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("summary.timezone")}</label>
            <Input
              placeholder="Asia/Shanghai"
              value={config.timezone ?? ""}
              onChange={(e) => onUpdate({ timezone: e.target.value || undefined })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("summary.scheduleHour")}</label>
            <Input
              type="number"
              min={0}
              max={23}
              placeholder={t("summary.noSchedulePlaceholder")}
              value={config.globalScheduleHour != null ? String(config.globalScheduleHour) : ""}
              onChange={(e) =>
                onUpdate({
                  globalScheduleHour: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("summary.scheduleMinute")}</label>
            <Input
              type="number"
              min={0}
              max={59}
              placeholder={t("summary.noSchedulePlaceholder")}
              value={config.globalScheduleMinute != null ? String(config.globalScheduleMinute) : ""}
              onChange={(e) =>
                onUpdate({
                  globalScheduleMinute: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("summary.modelId")}</label>
          <Input
            placeholder={t("summary.modelPlaceholder")}
            value={config.modelId ?? ""}
            onChange={(e) => onUpdate({ modelId: e.target.value || undefined })}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t("summary.roleFilter")}</label>
          <div className="flex gap-4">
            {roleOptions.map((role) => (
              <label key={role} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={currentRoleFilter.includes(role)}
                  onCheckedChange={() => toggleRole(role)}
                />
                {t(`summary.roles.${role}`)}
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("summary.systemPrompt")}</label>
          <Textarea
            placeholder={t("summary.systemPromptPlaceholder")}
            value={config.systemPrompt ?? ""}
            onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
            rows={4}
          />
        </div>
      </CardContent>
    </Card>
  );
}
