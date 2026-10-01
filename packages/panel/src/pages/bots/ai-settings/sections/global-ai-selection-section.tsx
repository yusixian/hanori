import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectMenu } from "@/components/ui/select-menu";
import { Switch } from "@/components/ui/switch";
import { Loader2, RefreshCw, RadioTower } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GlobalAiSelection } from "../types";

export interface GlobalAiSelectionDraft {
  providerId: string;
  modelId: string | null;
  displayDefault: "show" | "hide";
}

export function GlobalAiSelectionSection({
  selection,
  draft,
  canManage,
  saving,
  retrying,
  onChange,
  onSave,
  onDiscard,
  onRetry,
}: {
  selection: GlobalAiSelection;
  draft: GlobalAiSelectionDraft;
  canManage: boolean;
  saving: boolean;
  retrying: boolean;
  onChange: (draft: GlobalAiSelectionDraft) => void;
  onSave: () => void;
  onDiscard: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("aiSettings");
  const provider = selection.options.find((option) => option.id === draft.providerId);
  const dirty =
    draft.providerId !== selection.selection.providerId ||
    draft.modelId !== selection.selection.modelId ||
    draft.displayDefault !== selection.displayDefault;
  const busy = saving || retrying;

  return (
    <Card className="hanori-section-banner border-border overflow-hidden shadow-sm">
      <CardHeader className="border-border border-b p-4 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="text-primary mt-0.5 flex size-9 items-center justify-center rounded-xl bg-white/75">
              <RadioTower className="size-4" />
            </span>
            <div>
              <CardTitle className="text-base">{t("selection.title")}</CardTitle>
              <p className="text-muted-foreground mt-1 text-xs">{t("selection.description")}</p>
            </div>
          </div>
          <Badge variant={selection.applyState === "applied" ? "success" : "warning"}>
            {selection.applyState === "applied" ? t("selection.applied") : t("selection.pending")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 sm:p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-foreground text-xs font-semibold">{t("common.provider")}</label>
            <SelectMenu
              value={draft.providerId}
              onValueChange={(providerId) => {
                const next = selection.options.find((option) => option.id === providerId);
                onChange({
                  ...draft,
                  providerId,
                  modelId: next?.defaultModelId ?? null,
                });
              }}
              options={selection.options.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              disabled={!canManage || busy}
              ariaLabel={t("selection.providerAria")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-foreground text-xs font-semibold">{t("common.model")}</label>
            <SelectMenu
              value={draft.modelId ?? provider?.defaultModelId}
              onValueChange={(modelId) => onChange({ ...draft, modelId })}
              options={(provider?.models ?? []).map((model) => ({
                value: model.id,
                label: model.label,
              }))}
              disabled={!canManage || busy || !provider}
              ariaLabel={t("selection.modelAria")}
            />
          </div>
        </div>

        <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white/75 px-3 py-2">
          <div>
            <p className="text-foreground text-sm font-semibold">{t("selection.publicTitle")}</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t("selection.publicDescription")}
            </p>
          </div>
          <Switch
            checked={draft.displayDefault === "show"}
            onCheckedChange={(checked) =>
              onChange({ ...draft, displayDefault: checked ? "show" : "hide" })
            }
            disabled={!canManage || busy}
            aria-label={t("selection.publicAria")}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          {!canManage ? (
            <p className="text-muted-foreground text-xs">{t("selection.readOnly")}</p>
          ) : (
            <p className="text-muted-foreground text-xs">
              {dirty ? t("selection.unsaved") : t("selection.saved")}
            </p>
          )}
          <div className="flex items-center gap-2">
            {selection.applyState === "pending" && canManage && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={busy}>
                {retrying ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {t("selection.retry")}
              </Button>
            )}
            {canManage && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onDiscard}
                  disabled={!dirty || busy}
                >
                  {t("selection.discard")}
                </Button>
                <Button type="button" size="sm" onClick={onSave} disabled={!dirty || busy}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {saving ? t("common.saving") : t("selection.apply")}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
