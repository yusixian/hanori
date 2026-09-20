import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { EngagementPolicy } from "@cos-tool-bot/shared";

export function EngagementPolicyFields({
  value,
  onChange,
  disabled = false,
}: {
  value: EngagementPolicy;
  onChange: (value: EngagementPolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("aiSettings");
  const id = useId();
  const numericFields = [
    ["confidenceThreshold", 0, 1, 0.05],
    ["contextMessages", 1, 20, 1],
    ["timeoutMs", 100, 5000, 100],
  ] as const;
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 disabled:opacity-60">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t("engagement.mode")}</span>
          <select
            className="border-input bg-background h-10 w-full rounded-md border px-3"
            value={value.mode}
            onChange={(e) =>
              onChange({ ...value, mode: e.target.value as EngagementPolicy["mode"] })
            }
          >
            {(["off", "shadow", "active"] as const).map((mode) => (
              <option key={mode} value={mode}>
                {t(`engagement.modes.${mode}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>{t("engagement.style")}</span>
          <select
            className="border-input bg-background h-10 w-full rounded-md border px-3"
            value={value.style}
            onChange={(e) =>
              onChange({ ...value, style: e.target.value as EngagementPolicy["style"] })
            }
          >
            {(["natural", "assistant", "filter"] as const).map((style) => (
              <option key={style} value={style}>
                {t(`engagement.styles.${style}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t(`engagement.styleHelp.${value.style}`)}</p>
      <p className="text-muted-foreground text-xs">{t(`engagement.modeHelp.${value.mode}`)}</p>
      <label className="block space-y-1 text-sm">
        <span>{t("engagement.preferences")}</span>
        <Textarea
          value={value.preferences}
          maxLength={1000}
          rows={3}
          placeholder={t("engagement.preferencesPlaceholder")}
          onChange={(e) => onChange({ ...value, preferences: e.target.value })}
        />
      </label>
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-keyword`}
          checked={value.keywordDirect}
          disabled={disabled}
          onCheckedChange={(keywordDirect) => onChange({ ...value, keywordDirect })}
        />
        <label htmlFor={`${id}-keyword`} className="text-sm">
          {t("engagement.keywordDirect")}
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span>{t("engagement.cooldownSeconds")}</span>
        <Input
          type="number"
          min={0}
          max={3600}
          step={1}
          value={value.cooldownSeconds}
          onChange={(e) => onChange({ ...value, cooldownSeconds: Number(e.target.value) })}
        />
      </label>
      <p className="text-muted-foreground text-xs">{t("engagement.continuationHelp")}</p>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm">{t("engagement.advanced")}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {numericFields.map(([key, min, max, step]) => (
            <label key={key} className="space-y-1 text-sm">
              <span>{t(`engagement.${key}`)}</span>
              <Input
                type="number"
                value={value[key]}
                min={min}
                max={max}
                step={step}
                onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">{t("engagement.confidenceHelp")}</p>
      </details>
    </fieldset>
  );
}
