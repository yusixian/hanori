import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AiProviderEntryPublic } from "@cos-tool-bot/shared";
import { Check, Plus, Trash2 } from "lucide-react";
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

  const updateProvider = (id: string, updates: Partial<AiProviderEntryPublic>) => {
    onProvidersChange(providers.map((p) => (p.id === id ? { ...p, ...updates } : p)));
  };

  const removeProvider = (id: string) => {
    if (id === activeProviderId) return;
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
    setNewDraft(emptyDraft());
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">AI Providers</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            {adding ? "Cancel" : "Add Provider"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {providers.length === 0 && !adding && (
          <p className="text-muted-foreground text-sm">
            No providers yet. Legacy top-level fields below will be auto-migrated on first save.
          </p>
        )}

        {providers.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Active (Default)</label>
            <select
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
              value={activeProviderId ?? ""}
              onChange={(e) => onActiveProviderChange(e.target.value)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              Chat-level /provider override takes precedence over this default.
            </p>
          </div>
        )}

        {/* Existing providers */}
        {providers.map((p) => (
          <div key={p.id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Input
                  value={p.label}
                  onChange={(e) => updateProvider(p.id, { label: e.target.value })}
                  className="h-7 w-48 text-sm"
                />
                {p.id === activeProviderId && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-600">
                    <Check className="h-3 w-3" /> Active
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeProvider(p.id)}
                disabled={p.id === activeProviderId}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">Base URL</label>
                <Input
                  value={p.baseURL}
                  onChange={(e) => updateProvider(p.id, { baseURL: e.target.value })}
                  placeholder="https://api.openai.com/v1/"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">Provider Format</label>
                <select
                  className="border-input flex h-8 w-full rounded-md border bg-transparent px-2 text-sm"
                  value={p.providerFormat}
                  onChange={(e) =>
                    updateProvider(p.id, {
                      providerFormat: e.target.value as "openai" | "gemini",
                    })
                  }
                >
                  <option value="openai">OpenAI Compatible</option>
                  <option value="gemini">Gemini Native</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">Default Model</label>
                <Input
                  value={p.defaultModel}
                  onChange={(e) => updateProvider(p.id, { defaultModel: e.target.value })}
                  placeholder="gpt-4o"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">API Key</label>
                <Input
                  type="password"
                  value={draftApiKeys[p.id] ?? ""}
                  onChange={(e) => onDraftApiKeyChange(p.id, e.target.value)}
                  placeholder={p.hasApiKey ? "(leave empty to keep)" : "sk-..."}
                  className="h-8 text-sm"
                />
              </div>
            </div>
          </div>
        ))}

        {/* New provider form */}
        {adding && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="text-sm font-medium">New Provider</p>
            <div className="grid grid-cols-2 gap-2">
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
                <select
                  className="border-input flex h-8 w-full rounded-md border bg-transparent px-2 text-sm"
                  value={newDraft.providerFormat}
                  onChange={(e) =>
                    setNewDraft({
                      ...newDraft,
                      providerFormat: e.target.value as "openai" | "gemini",
                    })
                  }
                >
                  <option value="openai">OpenAI Compatible</option>
                  <option value="gemini">Gemini Native</option>
                </select>
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
              <div className="col-span-2 space-y-1">
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
