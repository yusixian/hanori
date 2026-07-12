import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";

export interface EmbeddingFormConfig {
  enabled: boolean;
  hasApiKey: boolean;
  baseURL: string;
  model: string;
  dimensions: number;
  apiKey: string;
}

export function EmbeddingSection({
  config,
  onUpdate,
}: {
  config: EmbeddingFormConfig;
  onUpdate: (updates: Partial<EmbeddingFormConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("embedding.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="embeddingEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="embeddingEnabled" className="text-sm font-medium">
            {t("embedding.enable")}
          </label>
        </div>
        <p className="text-muted-foreground text-xs">{t("embedding.description")}</p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("embedding.baseUrl")}</label>
          <Input
            disabled={!config.enabled}
            value={config.baseURL}
            onChange={(e) => onUpdate({ baseURL: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            {t("embedding.apiKey")} {config.hasApiKey && t("common.configuredParenthetical")}
          </label>
          <Input
            type="password"
            disabled={!config.enabled}
            value={config.apiKey}
            onChange={(e) => onUpdate({ apiKey: e.target.value })}
            placeholder={config.hasApiKey ? t("embedding.keepKeyPlaceholder") : "sk-..."}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("common.model")}</label>
          <Input
            disabled={!config.enabled}
            value={config.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            placeholder="text-embedding-3-small"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("embedding.dimensions")}</label>
          <Input type="number" disabled value={config.dimensions} readOnly />
          <p className="text-muted-foreground text-xs">
            {t("embedding.dimensionsDescriptionBefore")} <code>EMBEDDING_DIMENSIONS</code>{" "}
            {t("embedding.dimensionsDescriptionAfter")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
