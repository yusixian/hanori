import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import type { PixAIConfig, WebToolsConfig } from "@cos-tool-bot/shared";

export function WebToolsSection({
  config,
  onUpdate,
}: {
  config: WebToolsConfig;
  onUpdate: (updates: Partial<WebToolsConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Web Tools</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-2">
          <Switch
            id="webToolsEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="webToolsEnabled" className="text-sm font-medium">
            Enable Web Tools
          </label>
        </div>

        {/* Search */}
        <div className="space-y-4 border-t pt-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            Web Search
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Provider</label>
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
              ariaLabel="Search provider"
              options={[
                { value: "brave", label: "Brave Search (Recommended)" },
                { value: "tavily", label: "Tavily" },
                { value: "searxng", label: "SearXNG" },
                { value: "custom", label: "Custom" },
              ]}
            />
          </div>

          {(config.search?.provider ?? "brave") === "brave" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">API Key</label>
              <Input
                type="password"
                disabled={!config.enabled}
                value={config.search?.apiKey ?? ""}
                onChange={(e) =>
                  onUpdate({
                    search: { ...config.search, provider: "brave", apiKey: e.target.value },
                  })
                }
                placeholder="Brave Search API key"
              />
              <p className="text-muted-foreground text-xs">
                Visit{" "}
                <a
                  href="https://brave.com/search/api/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  brave.com/search/api
                </a>{" "}
                to create an API key (2,000 free requests per month).
              </p>
            </div>
          )}

          {config.search?.provider === "tavily" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">API Key</label>
              <Input
                type="password"
                disabled={!config.enabled}
                value={config.search?.apiKey ?? ""}
                onChange={(e) =>
                  onUpdate({
                    search: { ...config.search, provider: "tavily", apiKey: e.target.value },
                  })
                }
                placeholder="Tavily API key"
              />
              <p className="text-muted-foreground text-xs">
                Visit{" "}
                <a href="https://tavily.com" target="_blank" rel="noreferrer" className="underline">
                  tavily.com
                </a>{" "}
                to create an API key (1,000 free requests per month).
              </p>
            </div>
          )}

          {config.search?.provider === "searxng" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Base URL</label>
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
                A self-hosted SearXNG instance is required. See{" "}
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
                <label className="text-sm font-medium">Base URL</label>
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
                <label className="text-sm font-medium">API Key</label>
                <Input
                  type="password"
                  disabled={!config.enabled}
                  value={config.search?.apiKey ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      search: { ...config.search, provider: "custom", apiKey: e.target.value },
                    })
                  }
                  placeholder="Custom search API key"
                />
              </div>
              <p className="text-muted-foreground text-xs">
                The custom API must implement a compatible POST /search endpoint.
              </p>
            </>
          )}
        </div>

        {/* Image Generation */}
        <div className="space-y-4 border-t pt-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            Image Generation
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Provider</label>
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
              ariaLabel="Image generation provider"
              options={[
                { value: "openai", label: "OpenAI" },
                { value: "custom", label: "Custom" },
                { value: "pixai", label: "PixAI" },
              ]}
            />
          </div>

          {/* Common: API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">API Key</label>
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
                  ? "PixAI API key"
                  : "Image generation API key"
              }
            />
            {config.imageGeneration?.provider === "pixai" && (
              <p className="text-muted-foreground text-xs">
                Visit{" "}
                <a
                  href="https://platform.pixai.art"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  platform.pixai.art
                </a>{" "}
                to get an API key and model ID.
              </p>
            )}
          </div>

          {/* OpenAI / Custom fields */}
          {config.imageGeneration?.provider !== "pixai" && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Base URL</label>
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
                  <label className="text-sm font-medium">Model</label>
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
                  <label className="text-sm font-medium">Size</label>
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
  const updatePixai = (updates: Partial<PixAIConfig>) =>
    onUpdate({ pixaiConfig: { ...pixaiConfig, ...updates } });

  return (
    <>
      {/* Model ID */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Model ID</label>
        <Input
          disabled={disabled}
          value={model}
          onChange={(e) => onUpdate({ model: e.target.value })}
          placeholder="1935090615918113018 (Tsubaki v1.1)"
        />
        <p className="text-muted-foreground text-xs">
          Recommended: Tsubaki v1.1 (1935090615918113018), Haruka v2 (1861558740588989558), Hoshino
          (1811528826405408057)
        </p>
      </div>

      {/* System Image Prompt */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">System Image Prompt</label>
        <Textarea
          disabled={disabled}
          className="border-input flex min-h-[60px] w-full rounded-md border bg-transparent px-3 py-2 text-sm disabled:opacity-50"
          value={pixaiConfig.systemImagePrompt ?? ""}
          onChange={(e) => updatePixai({ systemImagePrompt: e.target.value || undefined })}
          placeholder="masterpiece, best quality, "
          rows={2}
        />
        <p className="text-muted-foreground text-xs">
          Prepended to every image-generation prompt created by the AI.
        </p>
      </div>

      {/* Basic Settings */}
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Basic Settings
        </p>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {/* API Mode */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">API Mode</label>
            <Select
              disabled={disabled}
              value={pixaiConfig.apiMode ?? "graphql"}
              onChange={(e) => updatePixai({ apiMode: e.target.value as "graphql" | "rest" })}
            >
              <option value="graphql">GraphQL (Recommended)</option>
              <option value="rest">REST</option>
            </Select>
          </div>

          {/* Seed */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Seed</label>
            <Input
              disabled={disabled}
              value={pixaiConfig.seed ?? ""}
              onChange={(e) => updatePixai({ seed: e.target.value || undefined })}
              placeholder="Random"
            />
            <p className="text-muted-foreground text-xs">
              Use a fixed seed for repeatable compositions, or leave empty for random results.
            </p>
          </div>

          {/* Priority */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Priority</label>
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
            <p className="text-muted-foreground text-xs">
              Queue priority (0–10,000). Higher values run first; profiles may adjust this
              automatically.
            </p>
          </div>
        </div>

        {/* Negative Prompts */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Negative Prompts</label>
          <Input
            disabled={disabled}
            value={pixaiConfig.negativePrompts ?? ""}
            onChange={(e) => updatePixai({ negativePrompts: e.target.value || undefined })}
            placeholder="Optional (official docs suggest leaving empty)"
          />
          <p className="text-muted-foreground text-xs">
            Elements to exclude from the image. PixAI recommends leaving this empty.
          </p>
        </div>

        {/* Width / Height / Batch Size */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Width</label>
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
            <p className="text-muted-foreground text-xs">Recommended: 512–1280</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Height</label>
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
            <p className="text-muted-foreground text-xs">Common: 832×1472, 1024×1024</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Batch Size</label>
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
            <p className="text-muted-foreground text-xs">Images per generation (1–4)</p>
          </div>
        </div>
      </div>

      {/* Generation Settings */}
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Generation Settings
        </p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Sampling Steps</label>
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
            <p className="text-muted-foreground text-xs">
              More steps can add detail. Recommended: 20–30.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">CFG Scale</label>
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
            <p className="text-muted-foreground text-xs">
              Prompt adherence. High values may oversaturate; keep below 7.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Clip Skip</label>
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
            <p className="text-muted-foreground text-xs">
              CLIP layers to skip. Anime styles commonly use 2.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Sampling Method</label>
            <Input
              disabled={disabled}
              value={pixaiConfig.samplingMethod ?? ""}
              onChange={(e) => updatePixai({ samplingMethod: e.target.value || undefined })}
              placeholder="Euler"
            />
            <p className="text-muted-foreground text-xs">
              Sampling algorithm, such as Euler or DPM++ 2M Karras.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Inference Profile</label>
            <Select
              disabled={disabled}
              value={pixaiConfig.inferenceProfile ?? ""}
              onChange={(e) => updatePixai({ inferenceProfile: e.target.value || undefined })}
            >
              <option value="">Default</option>
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
              <option value="ultra">Ultra</option>
            </Select>
            <p className="text-muted-foreground text-xs">
              Generation quality tier. Ultra is faster and higher priority but uses more credits.
            </p>
          </div>
        </div>
      </div>

      {/* Toggles */}
      <div className="space-y-3">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Switches
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
              Prompt Helper
            </label>
            <span className="text-muted-foreground text-xs">
              (PixAI optimizes prompts for an additional fee)
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
              Lightning Mode
            </label>
            <span className="text-muted-foreground text-xs">(trades some quality for speed)</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="pixaiPrivate"
              disabled={disabled}
              checked={pixaiConfig.isPrivate ?? false}
              onCheckedChange={(isPrivate) => updatePixai({ isPrivate: isPrivate || undefined })}
            />
            <label htmlFor="pixaiPrivate" className="text-sm font-medium">
              Private Mode
            </label>
            <span className="text-muted-foreground text-xs">
              (keeps images private from the PixAI community)
            </span>
          </div>
        </div>
      </div>

      {/* Advanced (collapsible) */}
      <details className="space-y-4">
        <summary className="text-muted-foreground cursor-pointer text-xs font-medium tracking-wider uppercase">
          Advanced Settings
        </summary>
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Model Style Key ID</label>
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
            <p className="text-muted-foreground text-xs">
              PixAI preset style, such as glossy-glass-anime or korean-style.
            </p>
          </div>
          <p className="text-muted-foreground text-xs">
            Quality tags automatically added around the prompt.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Quality Tag Prefix</label>
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
              <label className="text-sm font-medium">Quality Tag Suffix</label>
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
      </details>
    </>
  );
}
