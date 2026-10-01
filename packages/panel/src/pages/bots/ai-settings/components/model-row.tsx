import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import { Popover } from "@/components/ui/popover";
import type { ModelCapability, ModelEntry } from "@cos-tool-bot/shared";
import { inferCapabilities } from "@cos-tool-bot/shared";
import { Minus, Settings } from "lucide-react";
import { CAPABILITY_BADGES } from "../types";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function ModelRow({
  entry,
  isActive,
  radioControl,
  onRemove,
  onUpdate,
  onRename,
}: {
  entry: ModelEntry;
  isActive: boolean;
  radioControl: ReactNode;
  onRemove: () => void;
  onUpdate: (updates: Partial<ModelEntry>) => void;
  onRename: (nextId: string) => boolean;
}) {
  const capabilities = entry.capabilities ?? inferCapabilities(entry.id);
  const { t } = useTranslation("aiSettings");
  const [modelIdDraft, setModelIdDraft] = useState(entry.id);

  useEffect(() => {
    setModelIdDraft(entry.id);
  }, [entry.id]);

  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm sm:flex-nowrap ${isActive ? "bg-primary/10 border-primary/30" : "hover:bg-accent/50 border-transparent"}`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center">{radioControl}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.id}</span>
      {entry.label && (
        <span className="text-muted-foreground max-w-28 truncate text-xs">({entry.label})</span>
      )}
      <span className="order-last flex w-full flex-wrap gap-0.5 pl-10 sm:order-none sm:w-auto sm:pl-0">
        {capabilities.map((cap) => (
          <Badge
            key={cap}
            variant="muted"
            title={CAPABILITY_BADGES[cap] ? t(CAPABILITY_BADGES[cap].labelKey) : cap}
            className="px-1 py-0 text-[10px]"
          >
            {CAPABILITY_BADGES[cap]?.emoji ?? cap}
          </Badge>
        ))}
      </span>
      <Popover
        trigger={
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-8 items-center justify-center rounded-lg focus-visible:ring-2"
            aria-label={t("modelRow.configureAria", { model: entry.id })}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        }
        className="w-64 p-3"
      >
        <div className="space-y-3">
          <p className="text-xs font-medium">{t("modelRow.title")}</p>
          <div className="space-y-1.5">
            <label className="text-xs">{t("modelRow.modelId")}</label>
            <div className="flex gap-2">
              <Input
                value={modelIdDraft}
                onChange={(event) => setModelIdDraft(event.target.value)}
                aria-label={t("modelRow.modelId")}
                className="h-7 font-mono text-xs"
              />
              <button
                type="button"
                className="border-input bg-background hover:bg-accent h-7 shrink-0 rounded-md border px-2 text-xs font-medium"
                onClick={() => {
                  if (!onRename(modelIdDraft)) setModelIdDraft(entry.id);
                }}
                disabled={modelIdDraft.trim() === entry.id}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs">{t("modelRow.label")}</label>
            <Input
              value={entry.label ?? ""}
              onChange={(e) => onUpdate({ label: e.target.value || undefined })}
              placeholder={t("modelRow.displayNamePlaceholder")}
              className="h-7 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs">{t("modelRow.temperature")}</label>
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={entry.temperature ?? ""}
                onChange={(e) =>
                  onUpdate({ temperature: e.target.value ? Number(e.target.value) : undefined })
                }
                placeholder={t("common.defaultLower")}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs">{t("modelRow.maxTokens")}</label>
              <Input
                type="number"
                min={1}
                value={entry.maxTokens ?? ""}
                onChange={(e) =>
                  onUpdate({ maxTokens: e.target.value ? Number(e.target.value) : undefined })
                }
                placeholder={t("common.defaultLower")}
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs">{t("modelRow.thinking")}</label>
              <SelectMenu
                value={entry.thinking ?? "default"}
                onValueChange={(val) => {
                  onUpdate({
                    thinking: val === "enabled" || val === "disabled" ? val : undefined,
                  });
                }}
                className="border-input bg-background h-7 w-full rounded border px-2 text-xs"
                placeholder={t("common.default")}
                ariaLabel={t("modelRow.thinkingMode")}
                options={[
                  { value: "default", label: t("common.default") },
                  { value: "enabled", label: t("common.enabled") },
                  { value: "disabled", label: t("common.disabled") },
                ]}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs">{t("modelRow.thinkingBudget")}</label>
              <Input
                type="number"
                value={entry.thinkingBudget ?? ""}
                onChange={(e) =>
                  onUpdate({
                    thinkingBudget: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder={t("common.defaultLower")}
                className="h-7 text-xs"
                disabled={!entry.thinking}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{t("modelRow.reasoningParamsHint")}</p>
          <div className="space-y-1">
            <label className="text-xs">{t("modelRow.capabilities")}</label>
            <div className="flex flex-wrap gap-1">
              {(
                Object.entries(CAPABILITY_BADGES) as [
                  ModelCapability,
                  { emoji: string; labelKey: string },
                ][]
              ).map(([cap, badge]) => {
                const hasCap = capabilities.includes(cap);
                return (
                  <button
                    key={cap}
                    type="button"
                    className={`rounded border px-1.5 py-0.5 text-xs ${hasCap ? "bg-primary/10 border-primary/30" : "border-transparent opacity-40"}`}
                    onClick={() => {
                      const next = hasCap
                        ? capabilities.filter((c) => c !== cap)
                        : [...capabilities, cap];
                      onUpdate({ capabilities: next });
                    }}
                  >
                    {badge.emoji} {t(badge.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Popover>
      <button
        type="button"
        className="text-muted-foreground focus-visible:ring-ring hover:bg-danger-soft hover:text-destructive flex size-8 items-center justify-center rounded-lg focus-visible:ring-2"
        onClick={() => {
          if (isActive || window.confirm(t("modelRow.removeConfirm", { model: entry.id }))) {
            onRemove();
          }
        }}
        aria-label={t("modelRow.removeAria", { model: entry.id })}
        title={isActive ? t("models.defaultCannotRemove") : undefined}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
