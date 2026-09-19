import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/client";
import {
  GovernanceSubjectPicker,
  type GovernanceSubjectOption,
} from "@/pages/bots/governance-subject-picker";
import { Plus, Trash2 } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface CosInsideTargetDraft {
  key: string;
  alias: string;
  chatId: string;
}

export interface CosInsideTargetErrors {
  alias?: string;
  chatId?: string;
}

interface SubjectSearchResult {
  id: string;
  name?: string;
  username?: string;
}

interface CosInsideTargetsFieldProps {
  botId: string;
  targets: CosInsideTargetDraft[];
  errors: Record<string, CosInsideTargetErrors>;
  onAdd: () => void;
  onUpdate: (key: string, patch: Partial<Pick<CosInsideTargetDraft, "alias" | "chatId">>) => void;
  onRemove: (key: string) => void;
}

export function CosInsideTargetsField({
  botId,
  targets,
  errors,
  onAdd,
  onUpdate,
  onRemove,
}: CosInsideTargetsFieldProps) {
  const { t } = useTranslation("bots");

  const loadOptions = useCallback(
    async (query: string, signal: AbortSignal): Promise<GovernanceSubjectOption[]> => {
      const params = new URLSearchParams({ query });
      const response = await authFetch(
        `/api/bots/${encodeURIComponent(botId)}/cos-inside/groups?${params.toString()}`,
        { signal },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        subjects?: SubjectSearchResult[];
      };
      if (!response.ok || !body.ok || !body.subjects) throw new Error("subject_search_failed");
      return body.subjects
        .filter(({ id }) => /^-\d+$/.test(id) && Number.isSafeInteger(Number(id)))
        .map((subject) => {
          const fallback = t("form.cosInside.groupWithId", { id: subject.id });
          const label = subject.name || (subject.username ? `@${subject.username}` : fallback);
          const details = [
            subject.name && subject.username ? `@${subject.username}` : undefined,
            `ID ${subject.id}`,
          ].filter(Boolean);
          return { value: subject.id, label, detail: details.join(" · ") };
        });
    },
    [botId, t],
  );

  const resolveOption = useCallback(
    async (value: string, signal: AbortSignal) => {
      const options = await loadOptions(value, signal);
      return options.find((option) => option.value === value);
    },
    [loadOptions],
  );

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("form.cosInside.title")}</h3>
        <p className="text-muted-foreground text-xs">{t("form.cosInside.description")}</p>
        <p className="text-muted-foreground text-xs">{t("form.cosInside.restartHint")}</p>
      </div>

      {targets.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
          {t("form.cosInside.empty")}
        </p>
      ) : (
        <div className="space-y-3">
          {targets.map((target, index) => {
            const targetErrors = errors[target.key];
            return (
              <div
                key={target.key}
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto] sm:items-start"
              >
                <div className="space-y-1">
                  <label htmlFor={`cos-inside-alias-${target.key}`} className="text-xs font-medium">
                    {t("form.cosInside.alias")}
                  </label>
                  <Input
                    id={`cos-inside-alias-${target.key}`}
                    value={target.alias}
                    maxLength={32}
                    aria-invalid={!!targetErrors?.alias || undefined}
                    aria-describedby={
                      targetErrors?.alias ? `cos-inside-alias-error-${target.key}` : undefined
                    }
                    placeholder="ops"
                    onChange={(event) => onUpdate(target.key, { alias: event.target.value })}
                  />
                  {targetErrors?.alias && (
                    <p
                      id={`cos-inside-alias-error-${target.key}`}
                      className="text-destructive text-xs"
                      role="alert"
                    >
                      {targetErrors.alias}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <span className="block text-xs font-medium">{t("form.cosInside.group")}</span>
                  <GovernanceSubjectPicker
                    label={t("form.cosInside.groupNumber", { number: index + 1 })}
                    value={target.chatId}
                    onValueChange={(chatId) => onUpdate(target.key, { chatId })}
                    loadOptions={loadOptions}
                    resolveOption={resolveOption}
                    placeholder={t("form.cosInside.selectGroup")}
                    searchPlaceholder={t("form.cosInside.searchGroup")}
                    emptyText={t("form.cosInside.noGroups")}
                    unknownText={(value) => t("form.cosInside.groupWithId", { id: value })}
                    loadErrorText={t("form.cosInside.loadGroupsFailed")}
                    invalid={!!targetErrors?.chatId}
                  />
                  {targetErrors?.chatId && (
                    <p className="text-destructive text-xs" role="alert">
                      {targetErrors.chatId}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-end sm:mb-0.5"
                  aria-label={t("form.cosInside.removeTarget", { number: index + 1 })}
                  onClick={() => onRemove(target.key)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={targets.length >= 20}
        onClick={onAdd}
      >
        <Plus className="mr-1 size-4" aria-hidden="true" />
        {t("form.cosInside.addTarget")}
      </Button>
      <p className="text-muted-foreground text-xs">
        {t("form.cosInside.example", { command: "/cosinside ops message" })}
      </p>
    </div>
  );
}
