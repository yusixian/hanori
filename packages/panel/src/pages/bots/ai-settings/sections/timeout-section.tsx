import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { TimeoutConfig } from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

interface TimeoutField {
  key: keyof TimeoutConfig;
  min: number;
}

const TIMEOUT_FIELDS: TimeoutField[] = [
  {
    key: "aiReplyMs",
    min: 1,
  },
  {
    key: "perStepMs",
    min: 1,
  },
  {
    key: "searchMs",
    min: 1,
  },
  {
    key: "fetchPageMs",
    min: 1,
  },
  {
    key: "imageGenerationMs",
    min: 1,
  },
  {
    key: "researcherAgentMs",
    min: 1,
  },
  {
    key: "defaultAgentMs",
    min: 1,
  },
  {
    key: "imageDownloadMs",
    min: 1,
  },
  {
    key: "pixaiTaskMs",
    min: 1,
  },
];

export function TimeoutSection({
  config,
  onUpdate,
}: {
  config: TimeoutConfig;
  onUpdate: (updates: Partial<TimeoutConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("timeouts.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">{t("timeouts.description")}</p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TIMEOUT_FIELDS.map((field) => {
            const valueMs = config[field.key];
            const defaultMs = DEFAULT_TIMEOUT_CONFIG[field.key];
            const valueSec = valueMs != null ? String(valueMs / 1000) : "";
            return (
              <div key={field.key} className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t(`timeouts.fields.${field.key}.label`)}
                </label>
                <Input
                  type="number"
                  min={field.min}
                  placeholder={String(defaultMs / 1000)}
                  value={valueSec}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      onUpdate({ [field.key]: undefined });
                    } else {
                      onUpdate({ [field.key]: Number(raw) * 1000 });
                    }
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  {t(`timeouts.fields.${field.key}.description`)}{" "}
                  {t("timeouts.defaultSeconds", { seconds: defaultMs / 1000 })}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
