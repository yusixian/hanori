import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TaskAgentFields } from "./task-agent-fields";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_SUB_AGENT_MAX_STEPS,
  MAX_SUB_AGENT_STEPS,
  type AgentToolsConfig,
} from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function AgentToolsSection({
  config,
  onUpdate,
  providers,
}: {
  config: AgentToolsConfig;
  providers: { id: string; label: string; defaultModel: string }[];
  onUpdate: (updates: Partial<AgentToolsConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const [name, setName] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("agentTools.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="agentToolsEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="agentToolsEnabled" className="text-sm font-medium">
            {t("agentTools.enable")}
          </label>
        </div>
        <p className="text-muted-foreground text-xs">{t("agentTools.description")}</p>

        <div className="space-y-1.5">
          <label htmlFor="sub-agent-model" className="text-sm font-medium">
            {t("agentTools.model")}
          </label>
          <Input
            id="sub-agent-model"
            disabled={!config.enabled}
            value={config.subAgentModel ?? ""}
            onChange={(e) => onUpdate({ subAgentModel: e.target.value || undefined })}
            placeholder={t("agentTools.modelPlaceholder")}
          />
          <p className="text-muted-foreground text-xs">{t("agentTools.modelDescription")}</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="max-sub-agent-steps" className="text-sm font-medium">
            {t("agentTools.maxSteps")}
          </label>
          <Input
            id="max-sub-agent-steps"
            type="number"
            min={1}
            max={MAX_SUB_AGENT_STEPS}
            disabled={!config.enabled}
            value={config.maxSubAgentSteps ?? DEFAULT_SUB_AGENT_MAX_STEPS}
            onChange={(e) => onUpdate({ maxSubAgentSteps: Number(e.target.value) })}
          />
          <p className="text-muted-foreground text-xs">{t("agentTools.maxStepsDescription")}</p>
        </div>
        <div className="space-y-4 border-t pt-4">
          <h3 className="font-medium">{t("taskAgent.namedTitle")}</h3>
          {Object.entries(config.agents ?? {}).map(([agentName, agent]) => (
            <div key={agentName} className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="font-medium">{agentName}</h4>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    const agents = { ...config.agents };
                    delete agents[agentName];
                    onUpdate({ agents });
                  }}
                >
                  {t("taskAgent.remove")}
                </Button>
              </div>
              <TaskAgentFields
                config={agent}
                providers={providers}
                onUpdate={(updates) =>
                  onUpdate({ agents: { ...config.agents, [agentName]: { ...agent, ...updates } } })
                }
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label={t("taskAgent.name")}
              className="min-w-40 flex-1"
              placeholder={t("taskAgent.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!name.trim() || !!config.agents?.[name.trim()]}
              onClick={() => {
                onUpdate({ agents: { ...config.agents, [name.trim()]: { enabled: true } } });
                setName("");
              }}
            >
              {t("taskAgent.add")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
