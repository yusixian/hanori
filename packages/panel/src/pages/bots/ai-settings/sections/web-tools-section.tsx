import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { InlineDisclosure } from "@/components/ui/inline-disclosure";
import { Select } from "@/components/ui/select";
import type { PixAIConfig, WebToolsConfig } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function WebToolsSection({
  config,
  onUpdate,
}: {
  config: WebToolsConfig;
  onUpdate: (updates: Partial<WebToolsConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("webTools.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-2">
          <Switch
            id="webToolsEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="webToolsEnabled" className="text-sm font-medium">
            {t("webTools.enable")}
          </label>
        </div>

        {/* Search */}
        <div className="space-y-4 border-t pt-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {t("webTools.search.title")}
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("common.provider")}</label>
            <SelectMenu
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled}
              value={config.search?.provider ?? "brave"}
              onValueChange={(value) =>
                onUpdate({
                  search: {
                    ...config.search,
                    provider: value as NonNullable<WebToolsConfig["search"]>["provider"],
                  },
                })
              }
              ariaLabel={t("webTools.search.providerAria")}
              options={[
                { value: "brave", label: t("webTools.search.braveRecommended") },
                { value: "tavily", label: "Tavily" },
                { value: "searxng", label: "SearXNG" },
                { value: "custom", label: t("common.custom") },
              ]}
            />
          </div>

          {(config.search?.provider ?? "brave") === "brave" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("common.apiKey")}</label>
              <Input
                type="password"
                disabled={!config.enabled}
                value={config.search?.apiKey ?? ""}
                onChange={(e) =>
                  onUpdate({
                    search: { ...config.search, provider: "brave", apiKey: e.target.value },
                  })
                }
                placeholder={t("webTools.search.braveKeyPlaceholder")}
              />
              <p className="text-muted-foreground text-xs">
                {t("webTools.search.visit")}{" "}
                <a
                  href="https://brave.com/search/api/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  brave.com/search/api
                </a>{" "}
                {t("webTools.search.braveKeyHelp")}
              </p>
            </div>
          )}

          {config.search?.provider === "tavily" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("common.apiKey")}</label>
              <Input
                type="password"
                disabled={!config.enabled}
                value={config.search?.apiKey ?? ""}
                onChange={(e) =>
                  onUpdate({
                    search: { ...config.search, provider: "tavily", apiKey: e.target.value },
                  })
                }
                placeholder={t("webTools.search.tavilyKeyPlaceholder")}
              />
              <p className="text-muted-foreground text-xs">
                {t("webTools.search.visit")}{" "}
                <a href="https://tavily.com" target="_blank" rel="noreferrer" className="underline">
                  tavily.com
                </a>{" "}
                {t("webTools.search.tavilyKeyHelp")}
              </p>
            </div>
          )}

          {config.search?.provider === "searxng" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("common.baseUrl")}</label>
              <Input
                disabled={!config.enabled}
                value={config.search?.baseURL ?? ""}
                onChange={(e) =>
                  onUpdate({
                    search: { ...config.search, provider: "searxng", baseURL: e.target.value },
                  })
                }
                placeholder="https://searxng.example.com"
              />
              <p className="text-muted-foreground text-xs">
                {t("webTools.search.searxngHelp")}{" "}
                <a
                  href="https://docs.searxng.org"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  docs.searxng.org
                </a>
              </p>
            </div>
          )}

          {config.search?.provider === "custom" && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("common.baseUrl")}</label>
                <Input
                  disabled={!config.enabled}
                  value={config.search?.baseURL ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      search: { ...config.search, provider: "custom", baseURL: e.target.value },
                    })
                  }
                  placeholder="https://api.example.com"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("common.apiKey")}</label>
                <Input
                  type="password"
                  disabled={!config.enabled}
                  value={config.search?.apiKey ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      search: { ...config.search, provider: "custom", apiKey: e.target.value },
                    })
                  }
                  placeholder={t("webTools.search.customKeyPlaceholder")}
                />
              </div>
              <p className="text-muted-foreground text-xs">{t("webTools.search.customHelp")}</p>
            </>
          )}
        </div>

        {/* Image Generation */}
        <div className="space-y-4 border-t pt-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {t("webTools.image.title")}
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("common.provider")}</label>
            <SelectMenu
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled}
              value={config.imageGeneration?.provider ?? "openai"}
              onValueChange={(value) =>
                onUpdate({
                  imageGeneration: {
                    ...config.imageGeneration,
                    provider: value as "openai" | "custom" | "pixai",
                  },
                })
              }
              ariaLabel={t("webTools.image.providerAria")}
              options={[
                { value: "openai", label: "OpenAI" },
                { value: "custom", label: t("common.custom") },
                { value: "pixai", label: "PixAI" },
              ]}
            />
          </div>

          {/* Common: API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("common.apiKey")}</label>
            <Input
              type="password"
              disabled={!config.enabled}
              value={config.imageGeneration?.apiKey ?? ""}
              onChange={(e) =>
                onUpdate({
                  imageGeneration: {
                    ...config.imageGeneration,
                    provider: config.imageGeneration?.provider ?? "openai",
                    apiKey: e.target.value,
                  },
                })
              }
              placeholder={
                config.imageGeneration?.provider === "pixai"
                  ? t("webTools.image.pixaiKeyPlaceholder")
                  : t("webTools.image.keyPlaceholder")
              }
            />
            {config.imageGeneration?.provider === "pixai" && (
              <p className="text-muted-foreground text-xs">
                {t("webTools.search.visit")}{" "}
                <a
                  href="https://platform.pixai.art"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  platform.pixai.art
                </a>{" "}
                {t("webTools.image.pixaiKeyHelp")}
              </p>
            )}
          </div>

          {/* OpenAI / Custom fields */}
          {config.imageGeneration?.provider !== "pixai" && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("common.baseUrl")}</label>
                <Input
                  disabled={!config.enabled}
                  value={config.imageGeneration?.baseURL ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      imageGeneration: {
                        ...config.imageGeneration,
                        provider: config.imageGeneration?.provider ?? "openai",
                        baseURL: e.target.value,
                      },
                    })
                  }
                  placeholder="https://api.openai.com/v1/"
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t("common.model")}</label>
                  <Input
                    disabled={!config.enabled}
                    value={config.imageGeneration?.model ?? ""}
                    onChange={(e) =>
                      onUpdate({
                        imageGeneration: {
                          ...config.imageGeneration,
                          provider: config.imageGeneration?.provider ?? "openai",
                          model: e.target.value,
                        },
                      })
                    }
                    placeholder="dall-e-3"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t("webTools.image.size")}</label>
                  <Input
                    disabled={!config.enabled}
                    value={config.imageGeneration?.size ?? ""}
                    onChange={(e) =>
                      onUpdate({
                        imageGeneration: {
                          ...config.imageGeneration,
                          provider: config.imageGeneration?.provider ?? "openai",
                          size: e.target.value,
                        },
                      })
                    }
                    placeholder="1024x1024"
                  />
                </div>
              </div>
            </>
          )}

          {/* PixAI-specific fields */}
          {config.imageGeneration?.provider === "pixai" && (
            <PixAIConfigFields
              disabled={!config.enabled}
              model={config.imageGeneration?.model ?? ""}
              pixaiConfig={config.imageGeneration?.pixaiConfig ?? {}}
              onUpdate={(updates) =>
                onUpdate({
                  imageGeneration: {
                    ...config.imageGeneration,
                    provider: "pixai",
                    ...updates,
                  },
                })
              }
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PixAIConfigFields({
  disabled,
  model,
  pixaiConfig,
  onUpdate,
}: {
  disabled: boolean;
  model: string;
  pixaiConfig: PixAIConfig;
  onUpdate: (updates: { model?: string; pixaiConfig?: PixAIConfig }) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const updatePixai = (updates: Partial<PixAIConfig>) =>
    onUpdate({ pixaiConfig: { ...pixaiConfig, ...updates } });

  return (
    <>
      {/* Model ID */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t("common.modelId")}</label>
        <Input
          disabled={disabled}
          value={model}
          onChange={(e) => onUpdate({ model: e.target.value })}
          placeholder="1935090615918113018 (Tsubaki v1.1)"
        />
        <p className="text-muted-foreground text-xs">{t("pixai.modelRecommendations")}</p>
      </div>

      {/* System Image Prompt */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t("pixai.systemImagePrompt")}</label>
        <Textarea
          disabled={disabled}
          className="border-input flex min-h-[60px] w-full rounded-md border bg-transparent px-3 py-2 text-sm disabled:opacity-50"
          value={pixaiConfig.systemImagePrompt ?? ""}
          onChange={(e) => updatePixai({ systemImagePrompt: e.target.value || undefined })}
          placeholder="masterpiece, best quality, "
          rows={2}
        />
        <p className="text-muted-foreground text-xs">{t("pixai.systemImagePromptDescription")}</p>
      </div>

      {/* Basic Settings */}
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t("pixai.basicSettings")}
        </p>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {/* API Mode */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.apiMode")}</label>
            <Select
              disabled={disabled}
              value={pixaiConfig.apiMode ?? "graphql"}
              onChange={(e) => updatePixai({ apiMode: e.target.value as "graphql" | "rest" })}
            >
              <option value="graphql">{t("pixai.graphqlRecommended")}</option>
              <option value="rest">REST</option>
            </Select>
          </div>

          {/* Seed */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.seed")}</label>
            <Input
              disabled={disabled}
              value={pixaiConfig.seed ?? ""}
              onChange={(e) => updatePixai({ seed: e.target.value || undefined })}
              placeholder={t("common.random")}
            />
            <p className="text-muted-foreground text-xs">{t("pixai.seedDescription")}</p>
          </div>

          {/* Priority */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.priority")}</label>
            <Input
              type="number"
              disabled={disabled}
              min={0}
              max={10000}
              value={pixaiConfig.priority ?? ""}
              onChange={(e) =>
                updatePixai({ priority: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="1000"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.priorityDescription")}</p>
          </div>
        </div>

        {/* Negative Prompts */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("pixai.negativePrompts")}</label>
          <Input
            disabled={disabled}
            value={pixaiConfig.negativePrompts ?? ""}
            onChange={(e) => updatePixai({ negativePrompts: e.target.value || undefined })}
            placeholder={t("pixai.negativePromptsPlaceholder")}
          />
          <p className="text-muted-foreground text-xs">{t("pixai.negativePromptsDescription")}</p>
        </div>

        {/* Width / Height / Batch Size */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.width")}</label>
            <Input
              type="number"
              disabled={disabled}
              min={1}
              max={2048}
              value={pixaiConfig.width ?? ""}
              onChange={(e) =>
                updatePixai({ width: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="832"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.widthHelp")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.height")}</label>
            <Input
              type="number"
              disabled={disabled}
              min={1}
              max={2048}
              value={pixaiConfig.height ?? ""}
              onChange={(e) =>
                updatePixai({ height: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="1472"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.heightHelp")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.batchSize")}</label>
            <Input
              type="number"
              disabled={disabled}
              min={1}
              max={4}
              value={pixaiConfig.batchSize ?? ""}
              onChange={(e) =>
                updatePixai({ batchSize: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="1"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.batchSizeHelp")}</p>
          </div>
        </div>
      </div>

      {/* Generation Settings */}
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t("pixai.generationSettings")}
        </p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.samplingSteps")}</label>
            <Input
              type="number"
              disabled={disabled}
              min={8}
              max={50}
              value={pixaiConfig.samplingSteps ?? ""}
              onChange={(e) =>
                updatePixai({
                  samplingSteps: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="20"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.samplingStepsDescription")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.cfgScale")}</label>
            <Input
              type="number"
              disabled={disabled}
              min={1.1}
              max={15}
              step={0.1}
              value={pixaiConfig.cfgScale ?? ""}
              onChange={(e) =>
                updatePixai({ cfgScale: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="5"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.cfgScaleDescription")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.clipSkip")}</label>
            <Input
              type="number"
              disabled={disabled}
              min={1}
              max={12}
              value={pixaiConfig.clipSkip ?? ""}
              onChange={(e) =>
                updatePixai({ clipSkip: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="2"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.clipSkipDescription")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.samplingMethod")}</label>
            <Input
              disabled={disabled}
              value={pixaiConfig.samplingMethod ?? ""}
              onChange={(e) => updatePixai({ samplingMethod: e.target.value || undefined })}
              placeholder="Euler"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.samplingMethodDescription")}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.inferenceProfile")}</label>
            <Select
              disabled={disabled}
              value={pixaiConfig.inferenceProfile ?? ""}
              onChange={(e) => updatePixai({ inferenceProfile: e.target.value || undefined })}
            >
              <option value="">{t("common.default")}</option>
              <option value="standard">{t("pixai.standard")}</option>
              <option value="pro">Pro</option>
              <option value="ultra">Ultra</option>
            </Select>
            <p className="text-muted-foreground text-xs">
              {t("pixai.inferenceProfileDescription")}
            </p>
          </div>
        </div>
      </div>

      {/* Toggles */}
      <div className="space-y-3">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t("pixai.switches")}
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Switch
              id="pixaiPromptHelper"
              disabled={disabled}
              checked={pixaiConfig.promptHelper ?? false}
              onCheckedChange={(promptHelper) =>
                updatePixai({ promptHelper: promptHelper || undefined })
              }
            />
            <label htmlFor="pixaiPromptHelper" className="text-sm font-medium">
              {t("pixai.promptHelper")}
            </label>
            <span className="text-muted-foreground text-xs">
              {t("pixai.promptHelperDescription")}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="pixaiLightning"
              disabled={disabled}
              checked={pixaiConfig.lightning ?? false}
              onCheckedChange={(lightning) => updatePixai({ lightning: lightning || undefined })}
            />
            <label htmlFor="pixaiLightning" className="text-sm font-medium">
              {t("pixai.lightningMode")}
            </label>
            <span className="text-muted-foreground text-xs">{t("pixai.lightningDescription")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="pixaiPrivate"
              disabled={disabled}
              checked={pixaiConfig.isPrivate ?? false}
              onCheckedChange={(isPrivate) => updatePixai({ isPrivate: isPrivate || undefined })}
            />
            <label htmlFor="pixaiPrivate" className="text-sm font-medium">
              {t("pixai.privateMode")}
            </label>
            <span className="text-muted-foreground text-xs">{t("pixai.privateDescription")}</span>
          </div>
        </div>
      </div>

      {/* Advanced (collapsible) */}
      <InlineDisclosure title={t("pixai.advancedSettings")}>
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("pixai.modelStyleKey")}</label>
            <Input
              disabled={disabled}
              value={pixaiConfig.modelStyle?.keyId ?? ""}
              onChange={(e) =>
                updatePixai({
                  modelStyle: e.target.value ? { type: "key", keyId: e.target.value } : undefined,
                })
              }
              placeholder="glossy-glass-anime"
            />
            <p className="text-muted-foreground text-xs">{t("pixai.modelStyleDescription")}</p>
          </div>
          <p className="text-muted-foreground text-xs">{t("pixai.qualityTagsDescription")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("pixai.qualityTagPrefix")}</label>
              <Input
                disabled={disabled}
                value={pixaiConfig.qualityTag?.prefix ?? ""}
                onChange={(e) => {
                  const suffix = pixaiConfig.qualityTag?.suffix ?? "";
                  if (e.target.value || suffix) {
                    updatePixai({ qualityTag: { prefix: e.target.value, suffix } });
                  } else {
                    updatePixai({ qualityTag: undefined });
                  }
                }}
                placeholder="masterpiece, best quality, "
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("pixai.qualityTagSuffix")}</label>
              <Input
                disabled={disabled}
                value={pixaiConfig.qualityTag?.suffix ?? ""}
                onChange={(e) => {
                  const prefix = pixaiConfig.qualityTag?.prefix ?? "";
                  if (prefix || e.target.value) {
                    updatePixai({ qualityTag: { prefix, suffix: e.target.value } });
                  } else {
                    updatePixai({ qualityTag: undefined });
                  }
                }}
                placeholder=""
              />
            </div>
          </div>
        </div>
      </InlineDisclosure>
    </>
  );
}
