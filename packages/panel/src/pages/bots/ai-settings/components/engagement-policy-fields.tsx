import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_ENGAGEMENT_POLICY, type EngagementPolicy } from "@cos-tool-bot/shared";

const PREFERENCE_EXAMPLES = ["active", "restrained"] as const;
type PreferenceExample = (typeof PREFERENCE_EXAMPLES)[number];

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="min-w-0 space-y-1 text-sm">
      <span className="block">{label}</span>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

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
  const effectiveValue = { ...DEFAULT_ENGAGEMENT_POLICY, ...value };
  const [selectedExample, setSelectedExample] = useState<PreferenceExample | "">("");
  const exampleText = selectedExample
    ? t(`engagement.preferencesExamples.${selectedExample}.text`)
    : "";

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 disabled:opacity-60">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t("engagement.mode")}</span>
          <select
            className="border-input bg-background h-10 w-full rounded-md border px-3"
            value={effectiveValue.mode}
            onChange={(e) =>
              onChange({ ...effectiveValue, mode: e.target.value as EngagementPolicy["mode"] })
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
            value={effectiveValue.style}
            onChange={(e) =>
              onChange({ ...effectiveValue, style: e.target.value as EngagementPolicy["style"] })
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
      <p className="text-muted-foreground text-xs">
        {t(`engagement.styleHelp.${effectiveValue.style}`)}
      </p>
      <p className="text-muted-foreground text-xs">
        {t(`engagement.modeHelp.${effectiveValue.mode}`)}
      </p>
      <label className="block space-y-1 text-sm">
        <span>{t("engagement.preferences")}</span>
        <Textarea
          value={effectiveValue.preferences}
          maxLength={1000}
          rows={3}
          placeholder={t("engagement.preferencesPlaceholder")}
          onChange={(e) => onChange({ ...effectiveValue, preferences: e.target.value })}
        />
        <p className="text-muted-foreground text-xs leading-5">{t("engagement.preferencesHelp")}</p>
      </label>
      <div className="space-y-2 rounded-md border border-dashed p-3">
        <label className="block space-y-1 text-sm">
          <span>{t("engagement.preferencesExample")}</span>
          <select
            className="border-input bg-background h-10 w-full rounded-md border px-3"
            value={selectedExample}
            onChange={(e) => setSelectedExample(e.target.value as PreferenceExample | "")}
          >
            <option value="">{t("engagement.preferencesExampleNone")}</option>
            {PREFERENCE_EXAMPLES.map((example) => (
              <option key={example} value={example}>
                {t(`engagement.preferencesExamples.${example}.label`)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-muted-foreground text-xs">{t("engagement.preferencesExampleHelp")}</p>
        {selectedExample && (
          <div className="bg-background space-y-2 rounded-md p-2.5">
            <p className="text-xs font-medium">
              {t("engagement.preferencesExamplePreview", {
                name: t(`engagement.preferencesExamples.${selectedExample}.label`),
              })}
            </p>
            <p className="text-muted-foreground text-xs leading-5">{exampleText}</p>
            <button
              type="button"
              className="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex min-h-9 items-center justify-center rounded-md border px-3 text-xs font-medium"
              onClick={() => onChange({ ...effectiveValue, preferences: exampleText })}
            >
              {effectiveValue.preferences.length > 0
                ? t("engagement.preferencesExampleReplace")
                : t("engagement.preferencesExampleUse")}
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-keyword`}
          checked={effectiveValue.keywordDirect}
          disabled={disabled}
          onCheckedChange={(keywordDirect) => onChange({ ...effectiveValue, keywordDirect })}
        />
        <label htmlFor={`${id}-keyword`} className="text-sm">
          {t("engagement.keywordDirect")}
        </label>
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm">{t("engagement.advanced")}</summary>
        <div className="mt-3 space-y-4">
          <section className="space-y-3 rounded-md border p-3">
            <div>
              <h3 className="text-sm font-medium">{t("engagement.replyDecision")}</h3>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                {t("engagement.replyDecisionHelp")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                label={t("engagement.confidenceThreshold")}
                value={effectiveValue.confidenceThreshold}
                min={0}
                max={1}
                step={0.05}
                onChange={(confidenceThreshold) =>
                  onChange({ ...effectiveValue, confidenceThreshold })
                }
              />
            </div>
          </section>

          <section className="space-y-3 rounded-md border p-3">
            <div>
              <h3 className="text-sm font-medium">{t("engagement.participationRouting")}</h3>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                {t("engagement.participationRoutingHelp")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                label={t("engagement.addressedConfidenceThreshold")}
                value={effectiveValue.addressedConfidenceThreshold}
                min={0}
                max={1}
                step={0.05}
                onChange={(addressedConfidenceThreshold) =>
                  onChange({ ...effectiveValue, addressedConfidenceThreshold })
                }
              />
              <NumberField
                label={t("engagement.continueConfidenceThreshold")}
                value={effectiveValue.continueConfidenceThreshold}
                min={0}
                max={1}
                step={0.05}
                onChange={(continueConfidenceThreshold) =>
                  onChange({ ...effectiveValue, continueConfidenceThreshold })
                }
              />
              <NumberField
                label={t("engagement.cooldownSeconds")}
                value={effectiveValue.cooldownSeconds}
                min={0}
                max={3600}
                step={1}
                onChange={(cooldownSeconds) => onChange({ ...effectiveValue, cooldownSeconds })}
              />
              <NumberField
                label={t("engagement.continuationWindowSeconds")}
                value={effectiveValue.continuationWindowSeconds}
                min={0}
                max={300}
                step={10}
                onChange={(continuationWindowSeconds) =>
                  onChange({ ...effectiveValue, continuationWindowSeconds })
                }
              />
            </div>
            <p className="text-muted-foreground text-xs leading-5">
              {t("engagement.continuationHelp")}
            </p>
          </section>

          <section className="space-y-3 rounded-md border p-3">
            <div>
              <h3 className="text-sm font-medium">{t("engagement.requestBudget")}</h3>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                {t("engagement.requestBudgetHelp")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                label={t("engagement.contextMessages")}
                value={effectiveValue.contextMessages}
                min={1}
                max={20}
                step={1}
                onChange={(contextMessages) => onChange({ ...effectiveValue, contextMessages })}
              />
              <NumberField
                label={t("engagement.timeoutMs")}
                value={effectiveValue.timeoutMs}
                min={100}
                max={5000}
                step={100}
                onChange={(timeoutMs) => onChange({ ...effectiveValue, timeoutMs })}
              />
            </div>
          </section>
        </div>
      </details>
    </fieldset>
  );
}
