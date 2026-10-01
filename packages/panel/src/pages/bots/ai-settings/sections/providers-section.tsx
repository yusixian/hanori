import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import type { AiProviderEntryPublic } from "@cos-tool-bot/shared";
import {
  Check,
  ChevronDown,
  KeyRound,
  Plus,
  Server,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export interface ProviderFormDraft {
  id?: string;
  label: string;
  baseURL: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  modelDiscoveryPath: string;
  apiKey: string;
  hasApiKey: boolean;
}

function defaultDiscoveryPath(format: "openai" | "gemini") {
  return format === "openai" ? "/models" : "";
}

export function ProvidersSection({
  providers,
  activeProviderId,
  managedProviderId,
  draftApiKeys,
  canChangeActiveProvider = true,
  onProvidersChange,
  onActiveProviderChange,
  onManagedProviderChange,
  onDraftApiKeyChange,
}: {
  providers: AiProviderEntryPublic[];
  activeProviderId?: string;
  managedProviderId?: string;
  /** Map: provider id (or "__new_<tempId>") → plaintext key in-progress (never persisted on display). */
  draftApiKeys: Record<string, string>;
  canChangeActiveProvider?: boolean;
  onProvidersChange: (providers: AiProviderEntryPublic[]) => void;
  onActiveProviderChange: (id: string) => void;
  onManagedProviderChange: (id: string) => void;
  onDraftApiKeyChange: (providerKey: string, apiKey: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState<ProviderFormDraft>(emptyDraft());
  const [expandedId, setExpandedId] = useState<string | null>(
    managedProviderId ?? activeProviderId ?? null,
  );
  const { t } = useTranslation("aiSettings");

  const updateProvider = (id: string, updates: Partial<AiProviderEntryPublic>) => {
    onProvidersChange(providers.map((p) => (p.id === id ? { ...p, ...updates } : p)));
  };

  const updateProviderFormat = (
    provider: AiProviderEntryPublic,
    providerFormat: "openai" | "gemini",
  ) => {
    const updates: Partial<AiProviderEntryPublic> = { providerFormat };
    const currentPath =
      provider.modelDiscoveryPath ?? defaultDiscoveryPath(provider.providerFormat);
    if (currentPath === defaultDiscoveryPath(provider.providerFormat)) {
      updates.modelDiscoveryPath = defaultDiscoveryPath(providerFormat);
    }
    updateProvider(provider.id, updates);
  };

  const removeProvider = (id: string) => {
    if (id === activeProviderId) return;
    const provider = providers.find((entry) => entry.id === id);
    if (!window.confirm(t("providers.deleteConfirm", { provider: provider?.label ?? id }))) return;
    const nextProviders = providers.filter((p) => p.id !== id);
    onProvidersChange(nextProviders);
    onDraftApiKeyChange(id, "");
    if (id === managedProviderId) {
      const nextManagedId =
        nextProviders.find((entry) => entry.id === activeProviderId)?.id ?? nextProviders[0]?.id;
      if (nextManagedId) onManagedProviderChange(nextManagedId);
      setExpandedId(nextManagedId ?? null);
    }
  };

  const addProvider = () => {
    if (!newDraft.label.trim() || !newDraft.baseURL.trim()) return;
    // Use a temp id; backend assigns real uuid on save.
    const tempId = `__new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: AiProviderEntryPublic = {
      id: tempId,
      label: newDraft.label.trim(),
      baseURL: newDraft.baseURL.trim(),
      providerFormat: newDraft.providerFormat,
      defaultModel: newDraft.defaultModel.trim(),
      modelDiscoveryPath: newDraft.modelDiscoveryPath.trim(),
      hasApiKey: false,
      models: newDraft.defaultModel.trim() ? [{ id: newDraft.defaultModel.trim() }] : [],
    };
    onProvidersChange([...providers, entry]);
    if (newDraft.apiKey) onDraftApiKeyChange(tempId, newDraft.apiKey);
    // The first provider is both the runtime default and the current management target.
    if (!activeProviderId) onActiveProviderChange(tempId);
    onManagedProviderChange(tempId);
    setAdding(false);
    setExpandedId(tempId);
    setNewDraft(emptyDraft());
  };

  return (
    <Card>
      <CardHeader className="border-border border-b px-5 py-4 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{t("providers.title")}</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            {adding ? t("common.cancel") : t("providers.addProvider")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0 sm:p-0">
        {providers.length === 0 && !adding && (
          <p className="text-muted-foreground px-5 py-8 text-center text-sm">
            {t("providers.empty")}
          </p>
        )}

        {/* Existing providers */}
        {providers.map((p) => (
          <div key={p.id} className="border-border border-b last:border-b-0">
            <div className="group hover:bg-background/80 flex min-h-16 items-center gap-3 px-5 py-3 transition-colors duration-150">
              <button
                type="button"
                className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-2 focus-visible:outline-none"
                onClick={() => {
                  onManagedProviderChange(p.id);
                  setExpandedId((id) => (id === p.id ? null : p.id));
                }}
                aria-expanded={expandedId === p.id}
              >
                <span className="bg-accent text-primary ring-primary/10 flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset">
                  <Server className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-foreground w-full min-w-0 truncate text-sm font-semibold sm:w-auto">
                      {p.label}
                    </span>
                    {p.id === activeProviderId && (
                      <span className="bg-success-soft text-success ring-success/10 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ring-inset">
                        <Check className="size-3" /> {t("common.default")}
                      </span>
                    )}
                    {p.id === managedProviderId && (
                      <Badge
                        variant="muted"
                        className="border-primary bg-accent text-primary shrink-0 gap-1 px-2 py-0.5 text-[10px] font-bold"
                      >
                        <SlidersHorizontal className="size-3" />
                        {t("providers.managed")}
                      </Badge>
                    )}
                  </span>
                  <span className="text-muted-foreground mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                    <span>
                      {p.providerFormat === "openai"
                        ? t("providers.openAiCompatible")
                        : t("providers.geminiNative")}
                    </span>
                    {p.defaultModel && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate font-mono">{p.defaultModel}</span>
                      </>
                    )}
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
              <div className="border-border bg-background/50 border-t px-5 py-4">
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">
                      {t("common.name")}
                    </label>
                    <Input
                      value={p.label}
                      onChange={(e) => updateProvider(p.id, { label: e.target.value })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">
                      {t("providers.format")}
                    </label>
                    <SelectMenu
                      className="border-input flex h-9 w-full rounded-md border bg-white px-2 text-sm"
                      value={p.providerFormat}
                      onValueChange={(value) =>
                        updateProviderFormat(p, value as "openai" | "gemini")
                      }
                      ariaLabel={t("providers.format")}
                      options={[
                        { value: "openai", label: t("providers.openAiCompatible") },
                        { value: "gemini", label: t("providers.geminiNative") },
                      ]}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">
                      {t("common.baseUrl")}
                    </label>
                    <Input
                      value={p.baseURL}
                      onChange={(e) => updateProvider(p.id, { baseURL: e.target.value })}
                      placeholder="https://api.openai.com/v1/"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted-foreground text-xs font-medium">
                      {t("providers.defaultModel")}
                    </label>
                    <Input
                      value={p.defaultModel}
                      onChange={(e) => updateProvider(p.id, { defaultModel: e.target.value })}
                      placeholder="gpt-4o"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1 lg:col-span-2">
                    <label className="text-muted-foreground text-xs font-medium">
                      {t("providers.discoveryPath")}
                    </label>
                    <Input
                      value={p.modelDiscoveryPath ?? defaultDiscoveryPath(p.providerFormat)}
                      aria-label={t("providers.discoveryPath")}
                      onChange={(e) => updateProvider(p.id, { modelDiscoveryPath: e.target.value })}
                      placeholder="/models"
                      className="h-9 font-mono text-sm"
                    />
                    <p className="text-muted-foreground text-xs">
                      {t("providers.discoveryPathHelp")}
                    </p>
                  </div>
                  <div className="space-y-1 lg:col-span-2">
                    <label className="text-muted-foreground flex items-center gap-1 text-xs font-medium">
                      <KeyRound className="size-3" /> {t("common.apiKey")}
                    </label>
                    <Input
                      type="password"
                      value={draftApiKeys[p.id] ?? ""}
                      onChange={(e) => onDraftApiKeyChange(p.id, e.target.value)}
                      placeholder={p.hasApiKey ? t("providers.keepKeyPlaceholder") : "sk-..."}
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
                <div className="border-border mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <p className="text-muted-foreground text-xs">{t("providers.chatOverrideHelp")}</p>
                  <div className="flex items-center gap-2">
                    {p.id !== activeProviderId && canChangeActiveProvider && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onActiveProviderChange(p.id)}
                      >
                        <Check className="size-4" /> {t("providers.setDefault")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeProvider(p.id)}
                      disabled={p.id === activeProviderId}
                      title={
                        p.id === activeProviderId
                          ? t("providers.defaultCannotDelete")
                          : t("providers.delete")
                      }
                      aria-label={t("providers.deleteAria", { provider: p.label })}
                      className="text-destructive hover:bg-danger-soft hover:text-destructive"
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
          <div className="border-primary bg-accent/30 space-y-3 border-b border-dashed p-5">
            <p className="text-sm font-medium">{t("providers.newProvider")}</p>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">{t("common.label")}</label>
                <Input
                  value={newDraft.label}
                  onChange={(e) => setNewDraft({ ...newDraft, label: e.target.value })}
                  placeholder="OpenAI"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">{t("providers.format")}</label>
                <SelectMenu
                  className="border-input flex h-8 w-full rounded-md border bg-transparent px-2 text-sm"
                  value={newDraft.providerFormat}
                  onValueChange={(value) => {
                    const providerFormat = value as "openai" | "gemini";
                    const currentPathIsDefault =
                      newDraft.modelDiscoveryPath === defaultDiscoveryPath(newDraft.providerFormat);
                    setNewDraft({
                      ...newDraft,
                      providerFormat,
                      modelDiscoveryPath: currentPathIsDefault
                        ? defaultDiscoveryPath(providerFormat)
                        : newDraft.modelDiscoveryPath,
                    });
                  }}
                  ariaLabel={t("providers.format")}
                  options={[
                    { value: "openai", label: t("providers.openAiCompatible") },
                    { value: "gemini", label: t("providers.geminiNative") },
                  ]}
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">{t("common.baseUrl")}</label>
                <Input
                  value={newDraft.baseURL}
                  onChange={(e) => setNewDraft({ ...newDraft, baseURL: e.target.value })}
                  placeholder="https://api.openai.com/v1/"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">
                  {t("providers.defaultModel")}
                </label>
                <Input
                  value={newDraft.defaultModel}
                  onChange={(e) => setNewDraft({ ...newDraft, defaultModel: e.target.value })}
                  placeholder="gpt-4o"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1 lg:col-span-2">
                <label className="text-muted-foreground text-xs">
                  {t("providers.discoveryPath")}
                </label>
                <Input
                  value={newDraft.modelDiscoveryPath}
                  aria-label={t("providers.discoveryPath")}
                  onChange={(e) => setNewDraft({ ...newDraft, modelDiscoveryPath: e.target.value })}
                  placeholder="/models"
                  className="h-8 font-mono text-sm"
                />
                <p className="text-muted-foreground text-xs">{t("providers.discoveryPathHelp")}</p>
              </div>
              <div className="space-y-1 lg:col-span-2">
                <label className="text-muted-foreground text-xs">{t("common.apiKey")}</label>
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
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={addProvider}
                disabled={!newDraft.label.trim() || !newDraft.baseURL.trim()}
              >
                {t("common.add")}
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
    modelDiscoveryPath: "/models",
    apiKey: "",
    hasApiKey: false,
  };
}
