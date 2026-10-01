import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { client } from "@/lib/client";
import type { ModelEntry } from "@cos-tool-bot/shared";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModelRow } from "../components/model-row";
import type { ModelOption } from "../types";
import { CAPABILITY_BADGES } from "../types";
import { groupFetchedModels, groupModelsByProvider } from "../utils";
import { useTranslation } from "react-i18next";

function formatApiError(error: unknown, fallback: string) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    const detail = error.issues
      .map((issue) => {
        if (!issue || typeof issue !== "object") return "";
        const path =
          "path" in issue && Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
        const message = "message" in issue ? String(issue.message) : "";
        return path && message ? `${path}: ${message}` : message;
      })
      .filter(Boolean)
      .join("; ");
    if (detail) return detail;
  }
  return fallback;
}

export function ModelsSection({
  botId,
  models,
  activeModel,
  modelCommandAccess,
  providerId,
  providerLabel,
  baseURL,
  apiKey,
  modelDiscoveryPath,
  onModelsChange,
  onActiveModelChange,
  onModelRename,
  onModelCommandAccessChange,
  onError,
}: {
  botId: string;
  models: ModelEntry[];
  activeModel: string;
  modelCommandAccess: "admin" | "all";
  providerId: string;
  providerLabel: string;
  baseURL: string;
  apiKey: string;
  modelDiscoveryPath: string;
  onModelsChange: (models: ModelEntry[]) => void;
  onActiveModelChange: (modelId: string) => void;
  onModelRename: (currentId: string, nextId: string) => void;
  onModelCommandAccessChange: (access: "admin" | "all") => void;
  onError: (text: string) => void;
}) {
  const [fetchedModels, setFetchedModels] = useState<ModelOption[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [showFetchedModels, setShowFetchedModels] = useState(false);
  const [selectedFetchedModels, setSelectedFetchedModels] = useState<Set<string>>(new Set());
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());
  const [manualModelIds, setManualModelIds] = useState("");
  const [manualAddResult, setManualAddResult] = useState("");
  const fetchControllerRef = useRef<AbortController | null>(null);
  const fetchSequenceRef = useRef(0);
  const { t } = useTranslation("aiSettings");

  useEffect(() => {
    fetchControllerRef.current?.abort();
    fetchControllerRef.current = null;
    fetchSequenceRef.current += 1;
    setFetchedModels([]);
    setShowFetchedModels(false);
    setSelectedFetchedModels(new Set());
    setModelSearchQuery("");
    setCollapsedProviders(new Set());
    setFetchingModels(false);
    setManualAddResult("");
  }, [apiKey, baseURL, botId, modelDiscoveryPath, providerId]);

  useEffect(() => {
    setManualModelIds("");
  }, [botId, providerId]);

  useEffect(
    () => () => {
      fetchControllerRef.current?.abort();
      fetchSequenceRef.current += 1;
    },
    [],
  );

  const filteredFetchedModels = useMemo(() => {
    if (!modelSearchQuery.trim()) return fetchedModels;
    const q = modelSearchQuery.toLowerCase();
    return fetchedModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.owned_by ?? "").toLowerCase().includes(q) ||
        m.capabilities.some((c) =>
          CAPABILITY_BADGES[c]
            ? t(CAPABILITY_BADGES[c].labelKey).toLowerCase().includes(q)
            : c.toLowerCase().includes(q),
        ),
    );
  }, [fetchedModels, modelSearchQuery, t]);

  const handleFetchModels = async () => {
    const controller = new AbortController();
    fetchControllerRef.current?.abort();
    fetchControllerRef.current = controller;
    const sequence = ++fetchSequenceRef.current;
    setFetchingModels(true);
    try {
      const res = await client.api.bots[":botId"]["ai-models"].$post(
        {
          param: { botId },
          json: {
            providerId,
            baseURL: baseURL || undefined,
            apiKey: apiKey || undefined,
            modelDiscoveryPath,
          },
        },
        { init: { signal: controller.signal } },
      );
      const json = await res.json();
      if (sequence !== fetchSequenceRef.current || controller.signal.aborted) return;
      if (json.ok) {
        const uniqueModels = new Map<string, ModelOption>();
        for (const model of json.data) {
          if (!uniqueModels.has(model.id)) {
            uniqueModels.set(model.id, { ...model, owned_by: model.owned_by ?? "" });
          }
        }
        setFetchedModels([...uniqueModels.values()]);
        setShowFetchedModels(true);
        setSelectedFetchedModels(new Set());
      } else {
        onError(
          "error" in json
            ? formatApiError(json.error, t("models.fetchError"))
            : t("models.fetchError"),
        );
      }
    } catch (error) {
      if (
        sequence !== fetchSequenceRef.current ||
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      onError(t("models.fetchError"));
    } finally {
      if (sequence === fetchSequenceRef.current) {
        fetchControllerRef.current = null;
        setFetchingModels(false);
      }
    }
  };

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
    }
    setManualAddResult(
      t("models.manualAddResult", {
        added: idsToAdd.length,
        skipped,
      }),
    );
    if (idsToAdd.length > 0) setManualModelIds("");
  };

  const addSelectedModels = () => {
    const existing = new Set(models.map((m) => m.id));
    const toAdd: ModelEntry[] = [];
    for (const fm of fetchedModels) {
      if (selectedFetchedModels.has(fm.id) && !existing.has(fm.id)) {
        toAdd.push({ id: fm.id, capabilities: fm.capabilities });
        existing.add(fm.id);
      }
    }
    if (toAdd.length > 0) {
      onModelsChange([...models, ...toAdd]);
      if (!activeModel) onActiveModelChange(toAdd[0]!.id);
    }
    setShowFetchedModels(false);
    setSelectedFetchedModels(new Set());
    setModelSearchQuery("");
    setCollapsedProviders(new Set());
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
            onClick={handleFetchModels}
            disabled={fetchingModels || !modelDiscoveryPath.trim()}
            title={!modelDiscoveryPath.trim() ? t("models.fetchDisabledNoPath") : undefined}
          >
            {fetchingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : t("models.fetch")}
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

        {/* Configured models list */}
        {models.length > 0 ? (
          <RadioGroup
            value={activeModel}
            onValueChange={onActiveModelChange}
            className="grid-cols-[minmax(0,1fr)] space-y-2"
          >
            {groupModelsByProvider(models).map(([group, entries]) => (
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

        {/* Fetched models panel */}
        {showFetchedModels && fetchedModels.length > 0 && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <p className="text-sm font-medium">
                  {t("models.available", { count: fetchedModels.length })}
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                    onClick={() => {
                      const addable = filteredFetchedModels.filter(
                        (m) => !models.some((cm) => cm.id === m.id),
                      );
                      setSelectedFetchedModels(new Set(addable.map((m) => m.id)));
                    }}
                  >
                    {t("models.selectAll")}
                  </button>
                  <span className="text-muted-foreground text-xs">|</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                    onClick={() => setSelectedFetchedModels(new Set())}
                  >
                    {t("models.deselectAll")}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addSelectedModels}
                  disabled={selectedFetchedModels.size === 0}
                >
                  <Plus className="h-4 w-4" />
                  {t("models.addSelected", { count: selectedFetchedModels.size })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowFetchedModels(false);
                    setModelSearchQuery("");
                    setCollapsedProviders(new Set());
                  }}
                >
                  {t("common.close")}
                </Button>
              </div>
            </div>

            {/* Search bar */}
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
              <Input
                value={modelSearchQuery}
                onChange={(e) => setModelSearchQuery(e.target.value)}
                placeholder={t("models.searchPlaceholder")}
                className="pl-8"
              />
            </div>

            {/* Model list */}
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {groupFetchedModels(filteredFetchedModels).length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-center gap-1 py-8 text-sm">
                  <Search className="h-5 w-5 opacity-50" />
                  <p>{t("models.noMatch", { query: modelSearchQuery })}</p>
                </div>
              ) : (
                groupFetchedModels(filteredFetchedModels).map(([group, groupModels]) => {
                  const isCollapsed = collapsedProviders.has(group);
                  const selectedCount = groupModels.filter(
                    (m) => selectedFetchedModels.has(m.id) || models.some((cm) => cm.id === m.id),
                  ).length;
                  return (
                    <div key={group}>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 py-1 text-xs font-medium uppercase"
                        onClick={() => {
                          const next = new Set(collapsedProviders);
                          if (isCollapsed) next.delete(group);
                          else next.add(group);
                          setCollapsedProviders(next);
                        }}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        {group}
                        <span className="text-muted-foreground ml-1 text-[10px] font-normal normal-case">
                          ({groupModels.length})
                        </span>
                        {isCollapsed && selectedCount > 0 && (
                          <Badge variant="default" className="ml-auto px-1.5 py-0 text-[10px]">
                            {t("models.selectedCount", { count: selectedCount })}
                          </Badge>
                        )}
                      </button>
                      {!isCollapsed &&
                        groupModels.map((m) => {
                          const alreadyAdded = models.some((cm) => cm.id === m.id);
                          const isSelected = selectedFetchedModels.has(m.id);
                          return (
                            <label
                              key={m.id}
                              className={cn(
                                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                                alreadyAdded
                                  ? "cursor-default opacity-40"
                                  : isSelected
                                    ? "bg-primary/10 border-primary/20 border"
                                    : "hover:bg-accent/50",
                              )}
                            >
                              <Checkbox
                                disabled={alreadyAdded}
                                checked={alreadyAdded || isSelected}
                                onCheckedChange={(checked) => {
                                  const next = new Set(selectedFetchedModels);
                                  if (checked === true) next.add(m.id);
                                  else next.delete(m.id);
                                  setSelectedFetchedModels(next);
                                }}
                                className="sr-only"
                              />
                              <span
                                className={cn(
                                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                                  alreadyAdded || isSelected
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-input",
                                )}
                              >
                                {(alreadyAdded || isSelected) && <Check className="h-3 w-3" />}
                              </span>
                              <span className="flex-1 truncate font-mono text-xs">{m.id}</span>
                              {alreadyAdded && (
                                <span className="text-muted-foreground text-[10px] uppercase">
                                  {t("models.added")}
                                </span>
                              )}
                              <span className="flex gap-0.5">
                                {m.capabilities.map((cap) => (
                                  <Badge
                                    key={cap}
                                    variant="muted"
                                    title={
                                      CAPABILITY_BADGES[cap]
                                        ? t(CAPABILITY_BADGES[cap].labelKey)
                                        : cap
                                    }
                                    className="px-1 py-0 text-[10px]"
                                  >
                                    {CAPABILITY_BADGES[cap]?.emoji ?? cap}{" "}
                                    {CAPABILITY_BADGES[cap]
                                      ? t(CAPABILITY_BADGES[cap].labelKey)
                                      : cap}
                                  </Badge>
                                ))}
                              </span>
                            </label>
                          );
                        })}
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom toolbar */}
            <div className="border-t pt-2">
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                    onClick={() => {
                      const addable = filteredFetchedModels.filter(
                        (m) => !models.some((cm) => cm.id === m.id),
                      );
                      setSelectedFetchedModels(new Set(addable.map((m) => m.id)));
                    }}
                  >
                    {t("models.selectAll")}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                    onClick={() => setSelectedFetchedModels(new Set())}
                  >
                    {t("models.deselectAll")}
                  </button>
                </div>
                <span className="text-muted-foreground text-xs">
                  {t("models.availableSelected", {
                    selected: selectedFetchedModels.size,
                    available: filteredFetchedModels.filter(
                      (m) => !models.some((cm) => cm.id === m.id),
                    ).length,
                  })}
                </span>
              </div>
            </div>
          </div>
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
