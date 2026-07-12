import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ArtworkToolsConfig } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function ArtworkToolsSection({
  config,
  onUpdate,
}: {
  config: ArtworkToolsConfig;
  onUpdate: (updates: Partial<ArtworkToolsConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("artworkTools.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="artworkToolsEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="artworkToolsEnabled" className="text-sm font-medium">
            {t("artworkTools.enable")}
          </label>
        </div>
        <p className="text-muted-foreground text-xs">{t("artworkTools.description")}</p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("artworkTools.pixivCookie")}</label>
          <Input
            type="password"
            disabled={!config.enabled}
            value={config.pixivCookie ?? ""}
            onChange={(e) => onUpdate({ pixivCookie: e.target.value || undefined })}
            placeholder={t("artworkTools.pixivCookiePlaceholder")}
          />
          <p className="text-muted-foreground text-xs">
            {t("artworkTools.pixivCookieDescription")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
