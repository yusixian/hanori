import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ModelEntry } from "@cos-tool-bot/shared";
import { Loader2, Plus, Search, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { ModelRow } from "../components/model-row";
import { CAPABILITY_BADGES } from "../types";
import { groupModelsByProvider } from "../utils";
import { useTranslation } from "react-i18next";

export function ModelsSection({
  models,
  activeModel,
  modelCommandAccess,
  providerLabel,
  canFetch,
  fetchingModels,
  onRefresh,
  onModelsChange,
  onActiveModelChange,
  onModelRename,
  onModelCommandAccessChange,
  onError,
}: {
  models: ModelEntry[];
  activeModel: string;
  modelCommandAccess: "admin" | "all";
  providerLabel: string;
  canFetch: boolean;
  fetchingModels: boolean;
  onRefresh: () => void;
  onModelsChange: (models: ModelEntry[]) => void;
  onActiveModelChange: (modelId: string) => void;
  onModelRename: (currentId: string, nextId: string) => void;
  onModelCommandAccessChange: (access: "admin" | "all") => void;
  onError: (text: string) => void;
}) {
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [manualModelIds, setManualModelIds] = useState("");
  const [manualAddResult, setManualAddResult] = useState("");
  const { t } = useTranslation("aiSettings");
  const query = modelSearchQuery.trim().toLowerCase();
  const filteredModels = models.filter(
    (model) =>
      !query ||
      model.id.toLowerCase().includes(query) ||
      model.label?.toLowerCase().includes(query) ||
      model.capabilities?.some((capability) =>
        t(CAPABILITY_BADGES[capability].labelKey).toLowerCase().includes(query),
      ),
  );

  const addManualModels = () => {
    const parsed = manualModelIds
      .split(/[,\n]/)
      .map((modelId) => modelId.trim())
      .filter(Boolean);
    const uniqueIds = [...new Set(parsed)];
    const existingIds = new Set(models.map((model) => model.id));
    const idsToAdd = uniqueIds.filter((modelId) => !existingIds.has(modelId));
    const nextModels = [...models, ...idsToAdd.map((id) => ({ id }))];
    const skipped = parsed.length - idsToAdd.length;

    if (idsToAdd.length > 0) {
      onModelsChange(nextModels);
      if (!activeModel) onActiveModelChange(idsToAdd[0]!);
      setModelSearchQuery("");
    }
    setManualAddResult(
      t("models.manualAddResult", {
        added: idsToAdd.length,
        skipped,
      }),
    );
    if (idsToAdd.length > 0) setManualModelIds("");
  };

  const removeModel = (modelId: string) => {
    if (modelId === activeModel) {
      onError(t("models.defaultCannotRemove"));
      return;
    }
    onModelsChange(models.filter((m) => m.id !== modelId));
  };

  const renameModel = (modelId: string, nextId: string) => {
    const normalizedId = nextId.trim();
    if (!normalizedId) {
      onError(t("models.modelIdRequired"));
      return false;
    }
    if (normalizedId === modelId) return true;
    if (models.some((model) => model.id === normalizedId)) {
      onError(t("models.modelIdConflict", { model: normalizedId }));
      return false;
    }
    onModelRename(modelId, normalizedId);
    return true;
  };

  const updateModelEntry = (modelId: string, updates: Partial<ModelEntry>) => {
    onModelsChange(models.map((m) => (m.id === modelId ? { ...m, ...updates } : m)));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <SlidersHorizontal className="text-primary size-4" />
              {t("models.managingTitle", { provider: providerLabel })}
            </CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">{t("models.managingDescription")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={fetchingModels || !canFetch}
            title={!canFetch ? t("models.fetchDisabled") : undefined}
            aria-label={t("models.fetch")}
          >
            {fetchingModels && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("models.fetch")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border-border bg-accent/40 space-y-2 rounded-xl border p-3">
          <div>
            <p className="text-foreground text-sm font-medium">{t("models.manualAdd")}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t("models.manualAddDescription")}
            </p>
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={manualModelIds}
              onChange={(event) => {
                setManualModelIds(event.target.value);
                setManualAddResult("");
              }}
              aria-label={t("models.manualAddInput")}
              placeholder={t("models.manualAddPlaceholder")}
              rows={2}
              className="min-h-16 resize-y bg-white font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              onClick={addManualModels}
              disabled={!manualModelIds.trim()}
            >
              <Plus className="size-4" />
              {t("common.add")}
            </Button>
          </div>
          {manualAddResult && (
            <p className="text-muted-foreground text-xs" role="status">
              {manualAddResult}
            </p>
          )}
        </div>

        {models.length > 0 && (
          <div className="relative">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              value={modelSearchQuery}
              onChange={(event) => setModelSearchQuery(event.target.value)}
              aria-label={t("models.searchPlaceholder")}
              placeholder={t("models.searchPlaceholder")}
              className="pl-8"
            />
          </div>
        )}
        {models.length > 0 && filteredModels.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("models.noMatch", { query: modelSearchQuery })}
          </p>
        )}
        {/* Configured models list */}
        {models.length > 0 ? (
          <RadioGroup
            value={activeModel}
            onValueChange={onActiveModelChange}
            className="grid-cols-[minmax(0,1fr)] space-y-2"
          >
            {groupModelsByProvider(filteredModels).map(([group, entries]) => (
              <div key={group}>
                <p className="text-muted-foreground mb-1 text-xs font-medium uppercase">{group}</p>
                {entries.map((m) => (
                  <ModelRow
                    key={m.id}
                    entry={m}
                    isActive={m.id === activeModel}
                    radioControl={
                      <RadioGroupItem
                        value={m.id}
                        aria-label={t("models.setDefaultAria", { model: m.id })}
                      />
                    }
                    onRemove={() => removeModel(m.id)}
                    onUpdate={(updates) => updateModelEntry(m.id, updates)}
                    onRename={(nextId) => renameModel(m.id, nextId)}
                  />
                ))}
              </div>
            ))}
          </RadioGroup>
        ) : (
          <p className="text-muted-foreground text-sm">{t("models.emptyManual")}</p>
        )}

        {/* /model command access */}
        <div className="space-y-1.5 border-t pt-4">
          <span className="text-sm font-medium">{t("models.commandAccess")}</span>
          <RadioGroup
            className="grid gap-2 sm:grid-cols-2"
            value={modelCommandAccess}
            onValueChange={(value) => onModelCommandAccessChange(value as "admin" | "all")}
          >
            <label className="hover:bg-background flex cursor-pointer items-center gap-3 rounded-lg border bg-white p-3">
              <RadioGroupItem value="admin" />
              <span>
                <span className="block text-sm font-medium">{t("models.adminOnly")}</span>
                <span className="text-muted-foreground text-xs">
                  {t("models.adminOnlyDescription")}
                </span>
              </span>
            </label>
            <label className="hover:bg-background flex cursor-pointer items-center gap-3 rounded-lg border bg-white p-3">
              <RadioGroupItem value="all" />
              <span>
                <span className="block text-sm font-medium">{t("models.allUsers")}</span>
                <span className="text-muted-foreground text-xs">
                  {t("models.allUsersDescription")}
                </span>
              </span>
            </label>
          </RadioGroup>
          <p className="text-muted-foreground text-xs">{t("models.commandAccessDescription")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
