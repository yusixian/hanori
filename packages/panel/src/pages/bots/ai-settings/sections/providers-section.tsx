import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import type { AiProviderEntryPublic } from "@cos-tool-bot/shared";
import { Check, ChevronDown, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";

export interface ProviderFormDraft {
  id?: string;
  label: string;
  baseURL: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  apiKey: string;
  hasApiKey: boolean;
}

export function ProvidersSection({
  providers,
  activeProviderId,
  draftApiKeys,
  onProvidersChange,
  onActiveProviderChange,
  onDraftApiKeyChange,
}: {
  providers: AiProviderEntryPublic[];
  activeProviderId?: string;
  /** Map: provider id (or "__new_<tempId>") → plaintext key in-progress (never persisted on display). */
  draftApiKeys: Record<string, string>;
  onProvidersChange: (providers: AiProviderEntryPublic[]) => void;
  onActiveProviderChange: (id: string) => void;
  onDraftApiKeyChange: (providerKey: string, apiKey: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState<ProviderFormDraft>(emptyDraft());
  const [expandedId, setExpandedId] = useState<string | null>(activeProviderId ?? null);

  const updateProvider = (id: string, updates: Partial<AiProviderEntryPublic>) => {
    onProvidersChange(providers.map((p) => (p.id === id ? { ...p, ...updates } : p)));
  };

  const removeProvider = (id: string) => {
    if (id === activeProviderId) return;
    const provider = providers.find((entry) => entry.id === id);
    if (!window.confirm(`Delete provider “${provider?.label ?? id}”?`)) return;
    onProvidersChange(providers.filter((p) => p.id !== id));
    onDraftApiKeyChange(id, "");
  };

  const addProvider = () => {
    if (!newDraft.label.trim() || !newDraft.baseURL.trim() || !newDraft.defaultModel.trim()) return;
    // Use a temp id; backend assigns real uuid on save.
    const tempId = `__new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: AiProviderEntryPublic = {
      id: tempId,
      label: newDraft.label.trim(),
      baseURL: newDraft.baseURL.trim(),
      providerFormat: newDraft.providerFormat,
      defaultModel: newDraft.defaultModel.trim(),
      hasApiKey: false,
    };
    onProvidersChange([...providers, entry]);
    if (newDraft.apiKey) onDraftApiKeyChange(tempId, newDraft.apiKey);
    // If no active yet, make this one active
    if (!activeProviderId) onActiveProviderChange(tempId);
    setAdding(false);
    setExpandedId(tempId);
    setNewDraft(emptyDraft());
  };

  return (
    <Card>
      <CardHeader className="border-b border-slate-100 px-5 py-4 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">AI Providers</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            {adding ? "Cancel" : "Add Provider"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0 sm:p-0">
        {providers.length === 0 && !adding && (
          <p className="text-muted-foreground px-5 py-8 text-center text-sm">
            No providers yet. Legacy top-level fields below will be auto-migrated on first save.
          </p>
        )}

        {/* Existing providers */}
        {providers.map((p) => (
          <div key={p.id} className="border-b border-slate-100 last:border-b-0">
            <div className="group flex min-h-16 items-center gap-3 px-5 py-3 transition-colors duration-150 hover:bg-slate-50/80">
              <button
                type="button"
                className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-2 focus-visible:outline-none"
                onClick={() => setExpandedId((id) => (id === p.id ? null : p.id))}
                aria-expanded={expandedId === p.id}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 ring-1 ring-blue-600/10 ring-inset">
                  <Server className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900">{p.label}</span>
                    {p.id === activeProviderId && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-600/10 ring-inset">
                        <Check className="size-3" /> Default
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                    <span>
                      {p.providerFormat === "openai" ? "OpenAI Compatible" : "Gemini Native"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate font-mono">{p.defaultModel}</span>
                    <span aria-hidden="true">·</span>
                    <span className="hidden max-w-64 truncate sm:inline">{p.baseURL}</span>
                  </span>
                </span>
                <ChevronDown
                  className={`text-muted-foreground size-4 shrink-0 transition-transform duration-200 ${expandedId === p.id ? "rotate-180" : ""}`}
                />
              </button>
            </div>
            {expandedId === p.id && (
              <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-4">
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">Name</label>
                    <Input
                      value={p.label}
                      onChange={(e) => updateProvider(p.id, { label: e.target.value })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">
                      Provider Format
                    </label>
                    <SelectMenu
                      className="border-input flex h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={p.providerFormat}
                      onValueChange={(value) =>
                        updateProvider(p.id, {
                          providerFormat: value as "openai" | "gemini",
                        })
                      }
                      ariaLabel="Provider format"
                      options={[
                        { value: "openai", label: "OpenAI Compatible" },
                        { value: "gemini", label: "Gemini Native" },
                      ]}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">Base URL</label>
                    <Input
                      value={p.baseURL}
                      onChange={(e) => updateProvider(p.id, { baseURL: e.target.value })}
                      placeholder="https://api.openai.com/v1/"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">
                      Default Model
                    </label>
                    <Input
                      value={p.defaultModel}
                      onChange={(e) => updateProvider(p.id, { defaultModel: e.target.value })}
                      placeholder="gpt-4o"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1 lg:col-span-2">
                    <label className="text-muted-foreground flex items-center gap-1 text-xs font-medium">
                      <KeyRound className="size-3" /> API Key
                    </label>
                    <Input
                      type="password"
                      value={draftApiKeys[p.id] ?? ""}
                      onChange={(e) => onDraftApiKeyChange(p.id, e.target.value)}
                      placeholder={p.hasApiKey ? "(leave empty to keep)" : "sk-..."}
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
                  <p className="text-muted-foreground text-xs">
                    Chat-level /provider overrides this default.
                  </p>
                  <div className="flex items-center gap-2">
                    {p.id !== activeProviderId && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onActiveProviderChange(p.id)}
                      >
                        <Check className="size-4" /> Set as default
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeProvider(p.id)}
                      disabled={p.id === activeProviderId}
                      title={
                        p.id === activeProviderId
                          ? "Default provider cannot be deleted"
                          : "Delete provider"
                      }
                      aria-label={`Delete ${p.label}`}
                      className="text-red-500 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* New provider form */}
        {adding && (
          <div className="space-y-3 border-b border-dashed border-blue-200 bg-blue-50/30 p-5">
            <p className="text-sm font-medium">New Provider</p>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">Label</label>
                <Input
                  value={newDraft.label}
                  onChange={(e) => setNewDraft({ ...newDraft, label: e.target.value })}
                  placeholder="OpenAI"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">Provider Format</label>
                <SelectMenu
                  className="border-input flex h-8 w-full rounded-md border bg-transparent px-2 text-sm"
                  value={newDraft.providerFormat}
                  onValueChange={(value) =>
                    setNewDraft({
                      ...newDraft,
                      providerFormat: value as "openai" | "gemini",
                    })
                  }
                  ariaLabel="Provider format"
                  options={[
                    { value: "openai", label: "OpenAI Compatible" },
                    { value: "gemini", label: "Gemini Native" },
                  ]}
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">Base URL</label>
                <Input
                  value={newDraft.baseURL}
                  onChange={(e) => setNewDraft({ ...newDraft, baseURL: e.target.value })}
                  placeholder="https://api.openai.com/v1/"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">Default Model</label>
                <Input
                  value={newDraft.defaultModel}
                  onChange={(e) => setNewDraft({ ...newDraft, defaultModel: e.target.value })}
                  placeholder="gpt-4o"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1 lg:col-span-2">
                <label className="text-muted-foreground text-xs">API Key</label>
                <Input
                  type="password"
                  value={newDraft.apiKey}
                  onChange={(e) => setNewDraft({ ...newDraft, apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={addProvider}
                disabled={
                  !newDraft.label.trim() ||
                  !newDraft.baseURL.trim() ||
                  !newDraft.defaultModel.trim()
                }
              >
                Add
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function emptyDraft(): ProviderFormDraft {
  return {
    label: "",
    baseURL: "https://api.openai.com/v1/",
    providerFormat: "openai",
    defaultModel: "",
    apiKey: "",
    hasApiKey: false,
  };
}
