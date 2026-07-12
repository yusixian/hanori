import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { client } from "@/lib/client";
import type { ModelEntry } from "@cos-tool-bot/shared";
import { Check, ChevronDown, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ModelRow } from "../components/model-row";
import type { ModelOption } from "../types";
import { CAPABILITY_BADGES } from "../types";
import { groupFetchedModels, groupModelsByProvider } from "../utils";

export function ModelsSection({
  botId,
  models,
  activeModel,
  modelCommandAccess,
  baseURL,
  apiKey,
  onModelsChange,
  onActiveModelChange,
  onModelCommandAccessChange,
  onError,
}: {
  botId: string;
  models: ModelEntry[];
  activeModel: string;
  modelCommandAccess: "admin" | "all";
  baseURL: string;
  apiKey: string;
  onModelsChange: (models: ModelEntry[]) => void;
  onActiveModelChange: (modelId: string) => void;
  onModelCommandAccessChange: (access: "admin" | "all") => void;
  onError: (text: string) => void;
}) {
  const [fetchedModels, setFetchedModels] = useState<ModelOption[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [showFetchedModels, setShowFetchedModels] = useState(false);
  const [selectedFetchedModels, setSelectedFetchedModels] = useState<Set<string>>(new Set());
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());

  const filteredFetchedModels = useMemo(() => {
    if (!modelSearchQuery.trim()) return fetchedModels;
    const q = modelSearchQuery.toLowerCase();
    return fetchedModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.owned_by.toLowerCase().includes(q) ||
        m.capabilities.some((c) => CAPABILITY_BADGES[c]?.label.toLowerCase().includes(q)),
    );
  }, [fetchedModels, modelSearchQuery]);

  const handleFetchModels = async () => {
    setFetchingModels(true);
    try {
      const res = await client.api.bots[":botId"]["ai-models"].$post({
        param: { botId },
        json: {
          baseURL: baseURL || undefined,
          apiKey: apiKey || undefined,
        },
      });
      const json = await res.json();
      if (json.ok) {
        setFetchedModels(json.data);
        setShowFetchedModels(true);
        setSelectedFetchedModels(new Set());
      } else {
        onError("error" in json ? String(json.error) : "Failed to fetch models");
      }
    } catch {
      onError("Failed to fetch models");
    } finally {
      setFetchingModels(false);
    }
  };

  const addSelectedModels = () => {
    const existing = new Set(models.map((m) => m.id));
    const toAdd: ModelEntry[] = [];
    for (const fm of fetchedModels) {
      if (selectedFetchedModels.has(fm.id) && !existing.has(fm.id)) {
        toAdd.push({ id: fm.id, capabilities: fm.capabilities });
      }
    }
    if (toAdd.length > 0) {
      onModelsChange([...models, ...toAdd]);
    }
    setShowFetchedModels(false);
    setSelectedFetchedModels(new Set());
    setModelSearchQuery("");
    setCollapsedProviders(new Set());
  };

  const removeModel = (modelId: string) => {
    onModelsChange(models.filter((m) => m.id !== modelId));
  };

  const updateModelEntry = (modelId: string, updates: Partial<ModelEntry>) => {
    onModelsChange(models.map((m) => (m.id === modelId ? { ...m, ...updates } : m)));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Models</CardTitle>
          <Button variant="outline" size="sm" onClick={handleFetchModels} disabled={fetchingModels}>
            {fetchingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : "Fetch Models"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Configured models list */}
        {models.length > 0 ? (
          <RadioGroup value={activeModel} onValueChange={onActiveModelChange} className="space-y-2">
            {groupModelsByProvider(models).map(([group, entries]) => (
              <div key={group}>
                <p className="text-muted-foreground mb-1 text-xs font-medium uppercase">{group}</p>
                {entries.map((m) => (
                  <ModelRow
                    key={m.id}
                    entry={m}
                    isActive={m.id === activeModel}
                    radioControl={
                      <RadioGroupItem value={m.id} aria-label={`Set ${m.id} as default`} />
                    }
                    onRemove={() => removeModel(m.id)}
                    onUpdate={(updates) => updateModelEntry(m.id, updates)}
                  />
                ))}
              </div>
            ))}
          </RadioGroup>
        ) : (
          <p className="text-muted-foreground text-sm">
            No models configured. Click "Fetch Models" to discover available models.
          </p>
        )}

        {/* Fetched models panel */}
        {showFetchedModels && fetchedModels.length > 0 && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <p className="text-sm font-medium">Available Models ({fetchedModels.length})</p>
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
                    Select all
                  </button>
                  <span className="text-muted-foreground text-xs">|</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                    onClick={() => setSelectedFetchedModels(new Set())}
                  >
                    Deselect all
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
                  Add Selected ({selectedFetchedModels.size})
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
                  Close
                </Button>
              </div>
            </div>

            {/* Search bar */}
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
              <Input
                value={modelSearchQuery}
                onChange={(e) => setModelSearchQuery(e.target.value)}
                placeholder="Search models, providers, capabilities..."
                className="pl-8"
              />
            </div>

            {/* Model list */}
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {groupFetchedModels(filteredFetchedModels).length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-center gap-1 py-8 text-sm">
                  <Search className="h-5 w-5 opacity-50" />
                  <p>No models match "{modelSearchQuery}"</p>
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
                            {selectedCount} selected
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
                                  Added
                                </span>
                              )}
                              <span className="flex gap-0.5">
                                {m.capabilities.map((cap) => (
                                  <Badge
                                    key={cap}
                                    variant="muted"
                                    title={CAPABILITY_BADGES[cap]?.label ?? cap}
                                    className="px-1 py-0 text-[10px]"
                                  >
                                    {CAPABILITY_BADGES[cap]?.emoji ?? cap}{" "}
                                    {CAPABILITY_BADGES[cap]?.label ?? cap}
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
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                    onClick={() => setSelectedFetchedModels(new Set())}
                  >
                    Deselect all
                  </button>
                </div>
                <span className="text-muted-foreground text-xs">
                  {selectedFetchedModels.size} of{" "}
                  {filteredFetchedModels.filter((m) => !models.some((cm) => cm.id === m.id)).length}{" "}
                  available selected
                </span>
              </div>
            </div>
          </div>
        )}

        {/* /model command access */}
        <div className="space-y-1.5 border-t pt-4">
          <span className="text-sm font-medium">/model Command Access</span>
          <RadioGroup
            className="grid gap-2 sm:grid-cols-2"
            value={modelCommandAccess}
            onValueChange={(value) => onModelCommandAccessChange(value as "admin" | "all")}
          >
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border bg-white p-3 hover:bg-slate-50">
              <RadioGroupItem value="admin" />
              <span>
                <span className="block text-sm font-medium">Admin Only</span>
                <span className="text-xs text-slate-500">
                  Only bot administrators can switch models.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border bg-white p-3 hover:bg-slate-50">
              <RadioGroupItem value="all" />
              <span>
                <span className="block text-sm font-medium">All Users</span>
                <span className="text-xs text-slate-500">
                  Anyone in the chat can switch models.
                </span>
              </span>
            </label>
          </RadioGroup>
          <p className="text-muted-foreground text-xs">
            Who can use the /model command to switch AI models per-chat in Telegram.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
