import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SelectMenu } from "@/components/ui/select-menu";
import type { MemoryConfig } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function MemorySystemSection({
  config,
  onUpdate,
}: {
  config: MemoryConfig;
  onUpdate: (updates: Partial<MemoryConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("memorySystem.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="memoryEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="memoryEnabled" className="text-sm font-medium">
            {t("memorySystem.enable")}
          </label>
        </div>
        <p className="text-muted-foreground text-xs">{t("memorySystem.description")}</p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("memorySystem.maxSteps")}</label>
            <Input
              type="number"
              min={1}
              disabled={!config.enabled}
              value={config.maxSteps}
              onChange={(e) => onUpdate({ maxSteps: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">{t("memorySystem.maxStepsDescription")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("memorySystem.toolChoice")}</label>
            <SelectMenu
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled}
              value={config.toolChoice}
              onValueChange={(value) =>
                onUpdate({ toolChoice: value as MemoryConfig["toolChoice"] })
              }
              ariaLabel={t("memorySystem.toolChoice")}
              options={[
                { value: "auto", label: t("memorySystem.autoRecommended") },
                { value: "required", label: t("memorySystem.required") },
              ]}
            />
            <p className="text-muted-foreground text-xs">
              {t("memorySystem.toolChoiceDescription")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="autoReadProfile"
            disabled={!config.enabled}
            checked={config.autoReadProfile}
            onCheckedChange={(autoReadProfile) => onUpdate({ autoReadProfile })}
          />
          <label htmlFor="autoReadProfile" className="text-sm">
            {t("memorySystem.autoReadProfile")}
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="autoUpdateLastSeen"
            disabled={!config.enabled}
            checked={config.autoUpdateLastSeen}
            onCheckedChange={(autoUpdateLastSeen) => onUpdate({ autoUpdateLastSeen })}
          />
          <label htmlFor="autoUpdateLastSeen" className="text-sm">
            {t("memorySystem.autoUpdateLastSeen")}
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
