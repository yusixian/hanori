import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import type { AgentExecutionConfig } from "@cos-tool-bot/shared";
import { useId } from "react";
import { useTranslation } from "react-i18next";

export function TaskAgentFields({
  config,
  onUpdate,
  providers,
}: {
  config: AgentExecutionConfig;
  onUpdate: (updates: Partial<AgentExecutionConfig>) => void;
  providers: { id: string; label: string; defaultModel: string }[];
}) {
  const { t } = useTranslation("aiSettings");
  const id = useId();
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-provider`} className="text-sm font-medium">
            {t("taskAgent.provider")}
          </label>
          <Select
            id={`${id}-provider`}
            value={config.providerId ?? ""}
            onChange={(e) => onUpdate({ providerId: e.target.value || undefined })}
          >
            <option value="">{t("taskAgent.inherit")}</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-model`} className="text-sm font-medium">
            {t("taskAgent.model")}
          </label>
          <Input
            id={`${id}-model`}
            value={config.modelId ?? ""}
            placeholder={t("taskAgent.inherit")}
            onChange={(e) => onUpdate({ modelId: e.target.value || undefined })}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-prompt`} className="text-sm font-medium">
          {t("taskAgent.prompt")}
        </label>
        <Textarea
          id={`${id}-prompt`}
          rows={4}
          value={config.systemPrompt ?? ""}
          placeholder={t("taskAgent.inherit")}
          onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-tools`} className="text-sm font-medium">
          {t("taskAgent.tools")}
        </label>
        <Input
          id={`${id}-tools`}
          value={config.toolNames?.join(", ") ?? ""}
          placeholder={t("taskAgent.inherit")}
          onChange={(e) =>
            onUpdate({
              toolNames: e.target.value.trim()
                ? e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                : undefined,
            })
          }
        />
        <p className="text-muted-foreground text-xs">{t("taskAgent.toolsHelp")}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.toolNames?.length === 0}
            onChange={(e) => onUpdate({ toolNames: e.target.checked ? [] : undefined })}
          />
          {t("taskAgent.noTools")}
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["timeoutMs", "maxSteps"] as const).map((field) => (
          <div key={field} className="space-y-1.5">
            <label htmlFor={`${id}-${field}`} className="text-sm font-medium">
              {t(`taskAgent.${field}`)}
            </label>
            <Input
              id={`${id}-${field}`}
              type="number"
              min={field === "timeoutMs" ? 1000 : 1}
              max={field === "timeoutMs" ? 3600000 : 256}
              value={config[field] ?? ""}
              placeholder={t("taskAgent.inherit")}
              onChange={(e) =>
                onUpdate({ [field]: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
