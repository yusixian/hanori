import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DEFAULT_ENGAGEMENT_POLICY, type EngagementConfigPublic } from "@cos-tool-bot/shared";
import { EngagementPolicyFields } from "../components/engagement-policy-fields";

export function EngagementSection({
  config,
  apiKey,
  onApiKeyChange,
  onChange,
}: {
  config?: EngagementConfigPublic;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onChange: (config: EngagementConfigPublic) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const value = config ?? { ...DEFAULT_ENGAGEMENT_POLICY, hasApiKey: false };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("engagement.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block space-y-1 text-sm">
          <span>{t("engagement.apiKey")}</span>
          <Input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            placeholder={t(value.hasApiKey ? "engagement.keyConfigured" : "engagement.keyMissing")}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
        </label>
        <p className="text-muted-foreground text-xs">{t("engagement.keyHelp")}</p>
        <EngagementPolicyFields
          value={value}
          onChange={(policy) => onChange({ ...policy, hasApiKey: value.hasApiKey })}
        />
      </CardContent>
    </Card>
  );
}
