import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { MemoryReview } from "../../memory-review";
import {
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  type AiProviderEntryPublic,
  type BotMemoryConfig,
  type MemoryConsolidationConfig,
} from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function BotMemorySection({
  botId,
  canManage,
  providers,
  config,
  onUpdate,
}: {
  botId: string;
  canManage: boolean;
  providers: AiProviderEntryPublic[];
  config: BotMemoryConfig;
  onUpdate: (updates: Partial<BotMemoryConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  const consolidation = { ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG, ...config.consolidation };
  const updateReview = (updates: Partial<MemoryConsolidationConfig>) =>
    onUpdate({ consolidation: { ...config.consolidation, ...updates } });
  const provider = providers.find((entry) => entry.id === consolidation.providerId);

  const modelIds = [
    ...new Set(
      [provider?.defaultModel, ...(provider?.models ?? []).map((model) => model.id)].filter(
        (model): model is string => !!model,
      ),
    ),
  ];

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
        {canManage && (
          <>
            <fieldset className="space-y-4 border-t pt-4" disabled={!config.enabled}>
              <legend className="sr-only">{t("review.settings")}</legend>
              <div className="flex items-center gap-2">
                <Switch
                  id="scheduledMemoryReview"
                  checked={consolidation.enabled}
                  onCheckedChange={(enabled) => updateReview({ enabled })}
                />
                <label htmlFor="scheduledMemoryReview" className="text-sm font-medium">
                  {t("review.auto")}
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  {t("review.interval")}
                  <Input
                    type="number"
                    min={1}
                    max={168}
                    value={consolidation.intervalHours}
                    onChange={(e) =>
                      updateReview({
                        intervalHours: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  {t("review.callLimit")}
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={consolidation.maxCallsPerRun}
                    onChange={(e) =>
                      updateReview({
                        maxCallsPerRun: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="reviewImpressions"
                  checked={consolidation.groupImpressions}
                  onCheckedChange={(groupImpressions) => updateReview({ groupImpressions })}
                />
                <label htmlFor="reviewImpressions" className="text-sm">
                  {t("review.impressions")}
                </label>
              </div>
              <label className="block space-y-1 text-sm">
                {t("review.retention")}
                <Input
                  type="number"
                  min={1}
                  max={365}
                  placeholder={t("review.indefinite")}
                  value={consolidation.retentionDays ?? ""}
                  onChange={(e) =>
                    updateReview({
                      retentionDays: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor="reviewProvider" className="text-sm">
                    {t("review.provider")}
                  </label>
                  <Select
                    id="reviewProvider"
                    disabled={!config.enabled}
                    value={consolidation.providerId ?? ""}
                    onChange={(e) =>
                      updateReview({ providerId: e.target.value || undefined, modelId: undefined })
                    }
                  >
                    <option value="">{t("githubTools.followChatProvider")}</option>
                    {consolidation.providerId && !provider && (
                      <option value={consolidation.providerId}>
                        {t("githubTools.unavailableProvider", { id: consolidation.providerId })}
                      </option>
                    )}
                    {providers.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="reviewModel" className="text-sm">
                    {t("review.model")}
                  </label>
                  <Select
                    id="reviewModel"
                    disabled={!config.enabled || !provider}
                    value={consolidation.modelId ?? ""}
                    onChange={(e) => updateReview({ modelId: e.target.value || undefined })}
                  >
                    <option value="">
                      {provider
                        ? t("githubTools.providerDefaultModel", { model: provider.defaultModel })
                        : t("githubTools.followChatModel")}
                    </option>
                    {consolidation.modelId && !modelIds.includes(consolidation.modelId) && (
                      <option value={consolidation.modelId}>
                        {t("githubTools.unavailableModel", { id: consolidation.modelId })}
                      </option>
                    )}
                    {modelIds.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {provider?.models?.find((model) => model.id === modelId)?.label || modelId}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </fieldset>
            <MemoryReview key={botId} botId={botId} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
