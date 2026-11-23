import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { BotPlatform, CosInsideConfig } from "@cos-tool-bot/shared";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CosInsideTargetsField,
  type CosInsideTargetDraft,
  type CosInsideTargetErrors,
} from "./cos-inside-targets-field";

export interface BotFormData {
  name: string;
  platform: BotPlatform;
  token: string | undefined;
  adminChatIds: number[];
  isActive: boolean;
  miniAppEnabled: boolean;
  cosInsideConfig?: CosInsideConfig;
}

interface BotFormProps {
  initialData?: {
    name: string;
    platform?: BotPlatform;
    tokenMasked: string;
    adminChatIds: number[];
    isActive: boolean;
    miniAppEnabled: boolean;
    cosInsideConfig?: CosInsideConfig;
  };
  onSubmit: (data: BotFormData) => Promise<void>;
  submitLabel: string;
  isEdit?: boolean;
  botId?: string;
  canManageCosInside?: boolean;
}

export function BotForm({
  initialData,
  onSubmit,
  submitLabel,
  isEdit,
  botId,
  canManageCosInside = false,
}: BotFormProps) {
  const { t } = useTranslation("bots");
  const [name, setName] = useState(initialData?.name ?? "");
  const [token, setToken] = useState("");
  const [adminChatIds, setAdminChatIds] = useState(initialData?.adminChatIds.join(", ") ?? "");
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);
  const [miniAppEnabled, setMiniAppEnabled] = useState(initialData?.miniAppEnabled ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const nextCosInsideKey = useRef(0);
  const [cosInsideTargets, setCosInsideTargets] = useState<CosInsideTargetDraft[]>(() =>
    (initialData?.cosInsideConfig?.targets ?? []).map((target, index) => ({
      key: `stored-${index}`,
      alias: target.alias,
      chatId: String(target.chatId),
    })),
  );
  const [cosInsideTouched, setCosInsideTouched] = useState(false);
  const [cosInsideErrors, setCosInsideErrors] = useState<Record<string, CosInsideTargetErrors>>({});

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError("");
    let parsedCosInsideConfig: CosInsideConfig | undefined;
    if (canManageCosInside && isEdit && botId && cosInsideTouched) {
      const nextErrors: Record<string, CosInsideTargetErrors> = {};
      const aliases = new Set<string>();
      const targets: CosInsideConfig["targets"] = [];
      for (const target of cosInsideTargets) {
        const alias = target.alias.trim();
        const normalizedAlias = alias.toLowerCase();
        const errors: CosInsideTargetErrors = {};
        if (!/^[a-z0-9_-]{1,32}$/i.test(alias)) {
          errors.alias = t("form.cosInside.aliasInvalid");
        } else if (aliases.has(normalizedAlias)) {
          errors.alias = t("form.cosInside.aliasDuplicate");
        } else {
          aliases.add(normalizedAlias);
        }

        const chatIdText = target.chatId.trim();
        const chatId = Number(chatIdText);
        if (!/^-\d+$/.test(chatIdText) || !Number.isSafeInteger(chatId) || chatId > -1) {
          errors.chatId = t("form.cosInside.groupInvalid");
        }
        if (errors.alias || errors.chatId) nextErrors[target.key] = errors;
        else targets.push({ alias, chatId });
      }
      setCosInsideErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;
      parsedCosInsideConfig = { targets };
    }
    setSubmitting(true);
    try {
      const ids = adminChatIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !Number.isNaN(n));

      const data: BotFormData = {
        name,
        platform: "telegram",
        token: isEdit && !token ? undefined : token,
        adminChatIds: ids,
        isActive,
        miniAppEnabled,
      };

      if (parsedCosInsideConfig) data.cosInsideConfig = parsedCosInsideConfig;

      await onSubmit(data);
    } catch {
      setSubmitError(t("form.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle className="text-base">
          {isEdit ? t("form.editTitle") : t("form.createTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="bot-name" className="text-sm font-medium">
              {t("form.name")}
            </label>
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("form.namePlaceholder")}
              required
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="bot-token" className="text-sm font-medium">
              {t("form.botToken")}
            </label>
            <Input
              id="bot-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                isEdit ? (initialData?.tokenMasked ?? t("form.keepCurrent")) : "123456:ABC-DEF..."
              }
              required={!isEdit}
            />
            {isEdit && (
              <p className="text-muted-foreground text-xs">{t("form.keepCurrentToken")}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="bot-admin-ids" className="text-sm font-medium">
              {t("form.adminChatIds")}
            </label>
            <Input
              id="bot-admin-ids"
              value={adminChatIds}
              onChange={(e) => setAdminChatIds(e.target.value)}
              placeholder="123456, 789012"
            />
            <p className="text-muted-foreground text-xs">{t("form.adminChatIdsHint")}</p>
          </div>

          {canManageCosInside &&
            (isEdit && botId ? (
              <CosInsideTargetsField
                botId={botId}
                targets={cosInsideTargets}
                errors={cosInsideErrors}
                onAdd={() => {
                  const key = `new-${nextCosInsideKey.current++}`;
                  setCosInsideTargets((current) => [...current, { key, alias: "", chatId: "" }]);
                  setCosInsideTouched(true);
                }}
                onUpdate={(key, patch) => {
                  setCosInsideTargets((current) =>
                    current.map((target) =>
                      target.key === key ? { ...target, ...patch } : target,
                    ),
                  );
                  setCosInsideErrors((current) => {
                    if (!(key in current)) return current;
                    const next = { ...current };
                    delete next[key];
                    return next;
                  });
                  setCosInsideTouched(true);
                }}
                onRemove={(key) => {
                  setCosInsideTargets((current) => current.filter((target) => target.key !== key));
                  setCosInsideErrors((current) => {
                    if (!(key in current)) return current;
                    const next = { ...current };
                    delete next[key];
                    return next;
                  });
                  setCosInsideTouched(true);
                }}
              />
            ) : (
              <div className="space-y-1 rounded-md border p-3">
                <h3 className="text-sm font-medium">{t("form.cosInside.title")}</h3>
                <p className="text-muted-foreground text-xs">{t("form.cosInside.createFirst")}</p>
              </div>
            ))}

          <div className="flex items-center gap-2">
            <Switch id="isActive" checked={isActive} onCheckedChange={setIsActive} />
            <label htmlFor="isActive" className="text-sm font-medium">
              {t("form.autoStart")}
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="miniAppEnabled"
              checked={miniAppEnabled}
              onCheckedChange={setMiniAppEnabled}
            />
            <label htmlFor="miniAppEnabled" className="text-sm font-medium">
              {t("form.miniAppEnabled")}
            </label>
          </div>

          {submitError && (
            <p className="text-destructive text-sm" role="alert">
              {submitError}
            </p>
          )}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? t("common:common.saving") : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
