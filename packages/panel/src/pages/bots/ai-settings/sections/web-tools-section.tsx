import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
          <input
            type="checkbox"
            id="webToolsEnabled"
            checked={config.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            className="border-input h-4 w-4 rounded"
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
            <select
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled}
              value={config.search?.provider ?? "brave"}
              onChange={(e) =>
                onUpdate({
                  search: {
                    ...config.search,
                    provider: e.target.value as NonNullable<WebToolsConfig["search"]>["provider"],
                  },
                })
              }
            >
              <option value="brave">Brave Search (Recommended)</option>
              <option value="tavily">Tavily</option>
              <option value="searxng">SearXNG</option>
              <option value="custom">Custom</option>
            </select>
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
                前往{" "}
                <a
                  href="https://brave.com/search/api/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  brave.com/search/api
                </a>{" "}
                注册获取 API Key（免费额度 2000 次/月）
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
                前往{" "}
                <a href="https://tavily.com" target="_blank" rel="noreferrer" className="underline">
                  tavily.com
                </a>{" "}
                注册获取 API Key（免费额度 1000 次/月）
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
                需自行部署 SearXNG 实例，参见{" "}
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
                自定义搜索 API，需实现兼容的 POST /search 接口
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
            <select
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm disabled:opacity-50"
              disabled={!config.enabled}
              value={config.imageGeneration?.provider ?? "openai"}
              onChange={(e) =>
                onUpdate({
                  imageGeneration: {
                    ...config.imageGeneration,
                    provider: e.target.value as "openai" | "custom" | "pixai",
                  },
                })
              }
            >
              <option value="openai">OpenAI</option>
              <option value="custom">Custom</option>
              <option value="pixai">PixAI</option>
            </select>
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
                前往{" "}
                <a
                  href="https://platform.pixai.art"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  platform.pixai.art
                </a>{" "}
                获取 API Key 和模型 ID
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
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Model ID</label>
        <Input
          disabled={disabled}
          value={model}
          onChange={(e) => onUpdate({ model: e.target.value })}
          placeholder="1935090615918113018 (Tsubaki v1.1)"
        />
        <p className="text-muted-foreground text-xs">
          推荐: Tsubaki v1.1 (1935090615918113018), Haruka v2 (1861558740588989558), Hoshino
          (1811528826405408057)
        </p>
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Negative Prompts</label>
        <Input
          disabled={disabled}
          value={pixaiConfig.negativePrompts ?? ""}
          onChange={(e) => updatePixai({ negativePrompts: e.target.value || undefined })}
          placeholder="Optional (official docs suggest leaving empty)"
        />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Width</label>
          <Input
            type="number"
            disabled={disabled}
            min={512}
            max={1280}
            value={pixaiConfig.width ?? ""}
            onChange={(e) =>
              updatePixai({ width: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="768"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Height</label>
          <Input
            type="number"
            disabled={disabled}
            min={512}
            max={1280}
            value={pixaiConfig.height ?? ""}
            onChange={(e) =>
              updatePixai({ height: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="1280"
          />
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
        </div>
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
          <p className="text-muted-foreground text-xs">建议 &lt; 7</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="pixaiPromptHelper"
          disabled={disabled}
          checked={pixaiConfig.promptHelper ?? false}
          onChange={(e) => updatePixai({ promptHelper: e.target.checked || undefined })}
          className="border-input h-4 w-4 rounded"
        />
        <label htmlFor="pixaiPromptHelper" className="text-sm font-medium">
          Prompt Helper
        </label>
        <span className="text-muted-foreground text-xs">(需额外扣费)</span>
      </div>
    </>
  );
}
