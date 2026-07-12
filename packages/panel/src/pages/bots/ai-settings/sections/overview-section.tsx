import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { AiConfigPublic } from "@cos-tool-bot/shared";
import { AlertTriangle, Bot, Boxes, Brain, ChevronRight, Wrench } from "lucide-react";
import type { AiSettingsSectionId } from "../components/ai-settings-navigation";

export function OverviewSection({
  config,
  onEnabledChange,
  onNavigate,
}: {
  config: AiConfigPublic;
  onEnabledChange: (enabled: boolean) => void;
  onNavigate: (section: AiSettingsSectionId) => void;
}) {
  const activeProvider =
    config.providers.find((provider) => provider.id === config.activeProviderId) ??
    config.providers[0];
  const toolsEnabled = [
    config.webToolsConfig?.enabled,
    config.agentToolsConfig?.enabled,
    config.artworkToolsConfig?.enabled,
    config.imageOcrConfig?.enabled,
  ].filter(Boolean).length;
  const memoryEnabled = [
    config.memoryConfig?.enabled,
    config.botMemoryConfig?.enabled,
    config.embeddingConfig?.enabled,
    config.summaryConfig?.enabled,
  ].filter(Boolean).length;

  return (
    <div className="space-y-5">
      {!activeProvider && config.enabled && (
        <div className="flex items-start gap-3 rounded-lg border bg-white p-4 text-slate-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="text-sm">
            <p className="font-semibold">A provider is required</p>
            <p className="mt-0.5 text-xs leading-5 text-slate-600">
              Add a provider before enabling AI replies for this bot.
            </p>
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-4">
            <span className={cn("mt-0.5", config.enabled ? "text-blue-600" : "text-slate-400")}>
              <Bot className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-slate-950">AI replies</h2>
              <p className="mt-1 text-sm text-slate-500">
                {config.enabled
                  ? "The bot can respond using the active provider."
                  : "AI replies are currently disabled."}
              </p>
            </div>
          </div>
          <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm font-medium">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => onEnabledChange(event.target.checked)}
              className="border-input size-4 rounded"
            />
            Enable AI replies
          </label>
        </div>
      </Card>

      <div className="divide-y rounded-xl border bg-white">
        <OverviewCard
          icon={Boxes}
          label="Provider"
          value={activeProvider?.label ?? "Not configured"}
          detail={activeProvider?.defaultModel ?? "Add a provider and model"}
          healthy={Boolean(activeProvider)}
          onClick={() => onNavigate("providers")}
        />
        <OverviewCard
          icon={Brain}
          label="Memory"
          value={`${memoryEnabled} enabled`}
          detail="Memory, embeddings, and summaries"
          healthy={memoryEnabled > 0}
          onClick={() => onNavigate("memory")}
        />
        <OverviewCard
          icon={Wrench}
          label="Tools"
          value={`${toolsEnabled} enabled`}
          detail="Web, agent, artwork, MCP, and OCR"
          healthy={toolsEnabled > 0}
          onClick={() => onNavigate("tools")}
        />
      </div>
    </div>
  );
}

function OverviewCard({
  icon: Icon,
  label,
  value,
  detail,
  healthy,
  onClick,
}: {
  icon: typeof Boxes;
  label: string;
  value: string;
  detail: string;
  healthy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors duration-150 hover:bg-slate-50"
    >
      <Icon className="size-5 shrink-0 text-slate-500" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-950">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-slate-500">{detail}</span>
      </span>
      <span className={cn("text-sm font-medium", healthy ? "text-slate-800" : "text-slate-500")}>
        {value}
      </span>
      <ChevronRight className="size-4 shrink-0 text-slate-400" />
    </button>
  );
}
