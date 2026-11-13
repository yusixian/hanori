import type { AiProviderEntryPublic, ModelRecoveryConfig } from "@cos-tool-bot/shared";
import { DEFAULT_MODEL_RECOVERY } from "@cos-tool-bot/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectMenu } from "@/components/ui/select-menu";
import { useId } from "react";
import { useTranslation } from "react-i18next";

export function modelRecoveryError(
  value: ModelRecoveryConfig | undefined,
  providers: AiProviderEntryPublic[],
): "providerMissing" | "modelMissing" | undefined {
  if (!value?.fallback) return;
  if (!providers.some((provider) => provider.id === value.fallback?.providerId))
    return "providerMissing";
  const provider = providers.find((entry) => entry.id === value.fallback?.providerId);
  if (
    !value.fallback.modelId.trim() ||
    (provider?.defaultModel !== value.fallback.modelId &&
      !provider?.models?.some((model) => model.id === value.fallback?.modelId))
  )
    return "modelMissing";
}

export function ModelRecoveryFields({
  value = DEFAULT_MODEL_RECOVERY,
  providers,
  primary,
  disabled = false,
  onChange,
}: {
  value?: ModelRecoveryConfig;
  providers: AiProviderEntryPublic[];
  primary?: { providerId?: string; modelId?: string | null };
  disabled?: boolean;
  onChange: (value: ModelRecoveryConfig) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const id = useId();
  const provider = providers.find((entry) => entry.id === value.fallback?.providerId);
  const issue = modelRecoveryError(value, providers);
  const sameModel =
    !!value.fallback &&
    value.fallback.providerId === primary?.providerId &&
    value.fallback.modelId === (primary.modelId ?? provider?.defaultModel);
  const models = [
    ...new Set(
      [provider?.defaultModel, ...(provider?.models?.map((model) => model.id) ?? [])].filter(
        (model): model is string => !!model,
      ),
    ),
  ];

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 disabled:opacity-60">
      <div className="space-y-1.5">
        <label htmlFor={`${id}-retries`} className="text-sm font-medium">
          {t("recovery.maxRetries")}
        </label>
        <SelectMenu
          id={`${id}-retries`}
          ariaLabel={t("recovery.maxRetries")}
          value={String(value.maxRetries)}
          onValueChange={(maxRetries) => onChange({ ...value, maxRetries: Number(maxRetries) })}
          options={[0, 1, 2].map((count) => ({
            value: String(count),
            label: t("recovery.retryOption", { count }),
          }))}
          disabled={disabled}
        />
        <p className="text-muted-foreground text-xs leading-relaxed">{t("recovery.retryHelp")}</p>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={!!value.fallback}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({
              ...value,
              fallback: checked === true ? { providerId: "", modelId: "" } : null,
            })
          }
        />
        {t("recovery.useFallback")}
      </label>
      {value.fallback ? (
        <div className="bg-background/50 space-y-3 rounded-lg border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={`${id}-provider`} className="text-sm font-medium">
                {t("recovery.provider")}
              </label>
              <SelectMenu
                id={`${id}-provider`}
                ariaLabel={t("recovery.provider")}
                value={value.fallback.providerId}
                placeholder={t("recovery.chooseProvider")}
                disabled={disabled}
                options={[
                  ...(value.fallback.providerId && !provider
                    ? [
                        {
                          value: value.fallback.providerId,
                          label: t("recovery.unavailableProvider"),
                        },
                      ]
                    : []),
                  ...providers.map((entry) => ({ value: entry.id, label: entry.label })),
                ]}
                onValueChange={(providerId) =>
                  onChange({ ...value, fallback: { providerId, modelId: "" } })
                }
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={`${id}-model`} className="text-sm font-medium">
                {t("recovery.model")}
              </label>
              <SelectMenu
                id={`${id}-model`}
                ariaLabel={t("recovery.model")}
                value={value.fallback.modelId}
                disabled={disabled || !provider}
                placeholder={t("recovery.modelPlaceholder")}
                options={models.map((model) => ({ value: model, label: model }))}
                onValueChange={(modelId) =>
                  onChange({
                    ...value,
                    fallback: { providerId: provider?.id ?? "", modelId },
                  })
                }
              />
            </div>
          </div>
          {issue && (
            <p role="alert" className="text-destructive text-xs">
              {t(`recovery.${issue}`)}
            </p>
          )}
          {sameModel && (
            <p role="status" className="text-warning text-xs">
              {t("recovery.sameModel")}
            </p>
          )}
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("recovery.fallbackHelp")}
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t("recovery.noFallback")}</p>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">{t("recovery.safetyHelp")}</p>
    </fieldset>
  );
}
