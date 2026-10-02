import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";
import { settingElementId } from "../settings-index";

export function UnifiedSearchSection({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const settingId = settingElementId("unified-search");
  return (
    <Card id={settingId}>
      <CardHeader>
        <CardTitle className="text-base">{t("unifiedSearch.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id={`${settingId}-trigger`}
            checked={enabled}
            onCheckedChange={onChange}
            aria-describedby="unified-search-help"
          />
          <label htmlFor={`${settingId}-trigger`} className="text-sm font-medium">
            {t("unifiedSearch.enable")}
          </label>
        </div>
        <p id="unified-search-help" className="text-muted-foreground text-sm">
          {t("unifiedSearch.description")}
        </p>
      </CardContent>
    </Card>
  );
}
