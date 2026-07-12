import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { BotMemoryConfig } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function BotMemorySection({
  config,
  onUpdate,
}: {
  config: BotMemoryConfig;
  onUpdate: (updates: Partial<BotMemoryConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("botMemory.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="botMemoryEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="botMemoryEnabled" className="text-sm font-medium">
            {t("botMemory.enable")}
          </label>
        </div>
        <p className="text-muted-foreground text-xs">{t("botMemory.description")}</p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("botMemory.maxMemories")}</label>
          <Input
            type="number"
            min={1}
            max={100}
            disabled={!config.enabled}
            value={config.maxMemories}
            onChange={(e) => onUpdate({ maxMemories: Number(e.target.value) })}
          />
          <p className="text-muted-foreground text-xs">{t("botMemory.maxMemoriesDescription")}</p>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="autoInjectMemories"
            disabled={!config.enabled}
            checked={config.autoInjectMemories}
            onCheckedChange={(autoInjectMemories) => onUpdate({ autoInjectMemories })}
          />
          <label htmlFor="autoInjectMemories" className="text-sm">
            {t("botMemory.autoInject")}
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
