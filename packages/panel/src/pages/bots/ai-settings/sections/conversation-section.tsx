import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import { Switch } from "@/components/ui/switch";
import type { AiProviderEntryPublic, ConversationConfig } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function ConversationSection({
  config,
  providers,
  activeProviderId,
  onUpdate,
}: {
  config: ConversationConfig;
  providers: AiProviderEntryPublic[];
  activeProviderId?: string;
  onUpdate: (updates: Partial<ConversationConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const activeProviderLabel =
    providers.find((provider) => provider.id === activeProviderId)?.label ??
    t("conversation.activeProvider");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("conversation.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Basic Settings */}
        <div className="space-y-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {t("conversation.basicSettings")}
          </p>
          <div className="flex items-center gap-2">
            <Switch
              id="convEnabled"
              checked={config.enabled}
              onCheckedChange={(enabled) => onUpdate({ enabled })}
            />
            <label htmlFor="convEnabled" className="text-sm font-medium">
              {t("conversation.enable")}
            </label>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("conversation.historyFormat")}</label>
            <SelectMenu
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled}
              value={config.historyFormat ?? "prompt"}
              onValueChange={(value) =>
                onUpdate({
                  historyFormat: value as ConversationConfig["historyFormat"],
                })
              }
              ariaLabel={t("conversation.historyFormat")}
              options={[
                { value: "prompt", label: t("conversation.promptRecommended") },
                { value: "messages", label: t("conversation.messages") },
              ]}
            />
            <p className="text-muted-foreground text-xs">
              {t("conversation.historyFormatDescription")}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("conversation.maxContext")}</label>
              <Input
                type="number"
                min={1}
                max={100}
                disabled={!config.enabled}
                value={config.maxContextMessages}
                onChange={(e) => onUpdate({ maxContextMessages: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                {t("conversation.maxContextDescription")}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t("conversation.groupHistoryMaxTokens")}
              </label>
              <Input
                type="number"
                min={2_000}
                max={64_000}
                step={1_000}
                disabled={!config.enabled}
                value={config.groupHistoryMaxTokens}
                onChange={(e) => onUpdate({ groupHistoryMaxTokens: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                {t("conversation.groupHistoryMaxTokensDescription")}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("conversation.retentionDays")}</label>
              <Input
                type="number"
                min={0}
                max={365}
                disabled={!config.enabled}
                value={config.retentionDays}
                onChange={(e) => onUpdate({ retentionDays: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                {t("conversation.retentionDescription")}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t("conversation.maxRawMessagesPerChat")}
              </label>
              <Input
                type="number"
                min={0}
                max={1_000_000}
                disabled={!config.enabled}
                value={config.maxRawMessagesPerChat}
                onChange={(e) => onUpdate({ maxRawMessagesPerChat: Number(e.target.value) })}
              />
              <p className="text-muted-foreground text-xs">
                {t("conversation.maxRawMessagesDescription")}
              </p>
            </div>
          </div>
        </div>

        {/* Group Chat Settings */}
        <div className="space-y-4 border-t pt-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {t("conversation.groupSettings")}
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("conversation.groupBufferSize")}</label>
            <Input
              type="number"
              min={10}
              max={200}
              disabled={!config.enabled}
              value={config.groupBufferSize}
              onChange={(e) => onUpdate({ groupBufferSize: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">
              {t("conversation.groupBufferDescription")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("conversation.includeGroupContext")}</label>
              <SelectMenu
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
                disabled={!config.enabled}
                value={config.groupContextMode}
                onValueChange={(value) =>
                  onUpdate({
                    groupContextMode: value as ConversationConfig["groupContextMode"],
                  })
                }
                ariaLabel={t("conversation.includeGroupContext")}
                options={[
                  { value: "all", label: t("conversation.allTriggers") },
                  { value: "random_only", label: t("conversation.randomOnly") },
                  { value: "none", label: t("common.never") },
                ]}
              />
              <p className="text-muted-foreground text-xs">
                {t("conversation.includeGroupContextDescription")}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("conversation.groupPersistence")}</label>
              <p className="text-muted-foreground text-xs">
                {t("conversation.groupPersistenceDescription")}
              </p>
            </div>
          </div>
        </div>

        {/* Compression Settings */}
        <div className="space-y-4 border-t pt-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {t("conversation.compressionSettings")}
          </p>
          <div className="flex items-center gap-2">
            <Switch
              id="autoSummarize"
              disabled={!config.enabled}
              checked={config.autoSummarize}
              onCheckedChange={(autoSummarize) => onUpdate({ autoSummarize })}
            />
            <label htmlFor="autoSummarize" className="text-sm font-medium">
              {t("conversation.autoSummarize")}
            </label>
            <span className="text-muted-foreground text-xs">
              {t("conversation.autoSummarizeOff")}
            </span>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("conversation.compressionProvider")}</label>
            <SelectMenu
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled || !config.autoSummarize}
              value={config.compressionProviderId ?? "default"}
              onValueChange={(value) =>
                onUpdate({ compressionProviderId: value === "default" ? undefined : value })
              }
              ariaLabel={t("conversation.compressionProvider")}
              options={[
                {
                  value: "default",
                  label: t("conversation.defaultCompressionProvider", {
                    provider: activeProviderLabel,
                  }),
                },
                ...providers.map((provider) => ({
                  value: provider.id,
                  label: `${provider.label} (${provider.defaultModel})`,
                })),
              ]}
            />
            <p className="text-muted-foreground text-xs">
              {t("conversation.compressionProviderDescription")}
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("conversation.summarizeThreshold")}</label>
            <Input
              type="number"
              min={10}
              max={200}
              disabled={!config.enabled}
              value={config.summarizeThreshold}
              onChange={(e) => onUpdate({ summarizeThreshold: Number(e.target.value) })}
            />
            <p className="text-muted-foreground text-xs">
              {t("conversation.summarizeThresholdDescription")}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
