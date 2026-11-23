import { ModelRecoveryFields } from "./model-recovery-fields";
import {
  DEFAULT_MODEL_RECOVERY,
  type ModelRecoveryConfig,
  type AiProviderEntryPublic,
} from "@cos-tool-bot/shared";
import { EngagementPolicyFields } from "./engagement-policy-fields";
import { DEFAULT_ENGAGEMENT_POLICY, type EngagementPolicy } from "@cos-tool-bot/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { settingInputBounds } from "@/lib/setting-input-bounds";
import {
  AI_SETTING_BOUNDS,
  DEFAULT_CONVERSATION_CONFIG,
  type AiGroupOverride,
} from "@cos-tool-bot/shared";
import { ChevronRight, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function GroupOverrideRow({
  groupKey,
  override,
  engagement,
  modelRecovery,
  providers = [],
  onUpdate,
  onRemove,
}: {
  groupKey: string;
  override: AiGroupOverride;
  engagement?: EngagementPolicy;
  modelRecovery?: ModelRecoveryConfig;
  providers?: AiProviderEntryPublic[];
  onUpdate: (updates: Partial<AiGroupOverride>) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation("aiSettings");

  return (
    <div className="overflow-hidden rounded-xl border bg-white">
      <div className="flex min-h-14 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3 self-stretch sm:self-auto">
          <button
            type="button"
            className="text-muted-foreground hover:bg-surface-subtle hover:text-foreground flex size-9 items-center justify-center rounded-lg"
            onClick={() => setExpanded(!expanded)}
            aria-label={
              expanded ? t("groupOverride.collapseSettings") : t("groupOverride.expandSettings")
            }
            aria-expanded={expanded}
          >
            <ChevronRight
              className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
          <span className="bg-accent text-primary flex size-8 items-center justify-center rounded-full">
            <UsersRound className="size-4" />
          </span>
          <span className="truncate font-mono text-sm">{groupKey}</span>
          {override.chatTitle && (
            <span className="text-muted-foreground text-sm">({override.chatTitle})</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 self-stretch sm:self-auto">
          <label
            className="flex items-center gap-1.5 text-sm"
            title={t("groupOverride.allowAllDescription")}
          >
            <Switch
              checked={override.whitelisted}
              onCheckedChange={(whitelisted) => onUpdate({ whitelisted })}
            />
            {t("groupOverride.allowAllUsers")}
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <Switch
              checked={override.enabled ?? true}
              onCheckedChange={(enabled) => onUpdate({ enabled })}
            />
            {t("common.enabled")}
          </label>
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              window.confirm(t("groupOverride.removeConfirm", { group: groupKey })) && onRemove()
            }
            aria-label={t("groupOverride.removeAria", { group: groupKey })}
            className="text-destructive hover:bg-danger-soft hover:text-destructive ml-auto sm:ml-0"
          >
            <Trash2 className="text-destructive h-4 w-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="bg-background/50 space-y-5 border-t px-4 py-4">
          <div className="space-y-3 rounded-lg border bg-white p-3">
            <p className="text-sm font-medium">{t("engagement.title")}</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={override.engagement !== undefined}
                onCheckedChange={(checked) =>
                  onUpdate({
                    engagement:
                      checked === true
                        ? { ...DEFAULT_ENGAGEMENT_POLICY, ...engagement }
                        : undefined,
                  })
                }
              />
              {t("engagement.override")}
            </label>
            <p className="text-muted-foreground text-xs">
              {t(override.engagement ? "engagement.overridden" : "engagement.inherited")}
            </p>
            <EngagementPolicyFields
              value={{ ...DEFAULT_ENGAGEMENT_POLICY, ...engagement, ...override.engagement }}
              disabled={override.engagement === undefined}
              onChange={(value) => onUpdate({ engagement: value })}
            />
          </div>
          <div className="space-y-3 rounded-lg border bg-white p-3">
            <p className="text-sm font-medium">{t("recovery.title")}</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={override.modelRecovery !== undefined}
                onCheckedChange={(checked) =>
                  onUpdate({
                    modelRecovery:
                      checked === true
                        ? structuredClone(modelRecovery ?? DEFAULT_MODEL_RECOVERY)
                        : undefined,
                  })
                }
              />
              {t("recovery.override")}
            </label>
            <p className="text-muted-foreground text-xs">
              {t(
                override.modelRecovery === undefined ? "recovery.inherited" : "recovery.overridden",
              )}
            </p>
            <ModelRecoveryFields
              value={override.modelRecovery ?? modelRecovery}
              providers={providers}
              disabled={override.modelRecovery === undefined}
              onChange={(value) => onUpdate({ modelRecovery: value })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("groupOverride.systemPrompt")}</label>
            <Textarea
              className="min-h-20"
              value={override.systemPrompt ?? ""}
              onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
              placeholder={t("groupOverride.systemPromptPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("groupOverride.triggerOverrides")}</p>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.triggerConfig?.replyToBot ?? true}
                onCheckedChange={(checked) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, replyToBot: checked === true },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">{t("groupOverride.replyToBot")}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.triggerConfig?.mentionBot ?? true}
                onCheckedChange={(checked) =>
                  onUpdate({
                    triggerConfig: { ...override.triggerConfig, mentionBot: checked === true },
                  })
                }
                className="border-input h-4 w-4 rounded"
              />
              <span className="text-sm">{t("groupOverride.mentionBot")}</span>
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("groupOverride.conversationOverrides")}</p>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.conversationEnabled ?? true}
                onCheckedChange={(checked) => onUpdate({ conversationEnabled: checked === true })}
              />
              <span className="text-sm">{t("groupOverride.enableConversationHistory")}</span>
            </label>
            <div className="space-y-1.5">
              <label className="text-sm">{t("groupOverride.maxContextMessages")}</label>
              <Input
                type="number"
                {...settingInputBounds(AI_SETTING_BOUNDS.maxContextMessages)}
                value={override.maxContextMessages ?? ""}
                onChange={(e) =>
                  onUpdate({
                    maxContextMessages: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder={t("groupOverride.followGlobal")}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm">{t("groupOverride.groupHistoryMaxTokens")}</label>
              <Input
                type="number"
                {...settingInputBounds(AI_SETTING_BOUNDS.groupHistoryMaxTokens)}
                step={1_000}
                value={override.groupHistoryMaxTokens ?? ""}
                onChange={(e) =>
                  onUpdate({
                    groupHistoryMaxTokens: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                placeholder={t("groupOverride.followGlobal")}
              />
              {(override.groupHistoryMaxTokens ?? 0) >
                DEFAULT_CONVERSATION_CONFIG.groupHistoryMaxTokens && (
                <p className="text-warning text-xs font-medium">
                  {t("groupOverride.groupHistoryMaxTokensWarning")}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("groupOverride.toolsOverrides")}</p>
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={override.imageGenerationEnabled ?? false}
                onCheckedChange={(checked) =>
                  onUpdate({ imageGenerationEnabled: checked === true })
                }
              />
              <span className="text-sm">{t("groupOverride.enableImageGeneration")}</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
