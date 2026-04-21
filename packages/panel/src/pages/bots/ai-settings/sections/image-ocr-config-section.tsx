import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AiProviderEntryPublic, ImageOcrConfig } from "@cos-tool-bot/shared";
import {
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_OCR_COOLDOWN_SECONDS,
  DEFAULT_OCR_MAX_DESCRIPTION_LENGTH,
  DEFAULT_OCR_PROMPT,
  DEFAULT_OCR_TIMEOUT_MS,
} from "@cos-tool-bot/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

export function ImageOcrConfigSection({
  config,
  providers,
  activeProviderId,
  onUpdate,
}: {
  config: ImageOcrConfig;
  providers: AiProviderEntryPublic[];
  activeProviderId?: string;
  onUpdate: (updates: Partial<ImageOcrConfig>) => void;
}) {
  const [showDefault, setShowDefault] = useState(false);
  const activeLabel =
    providers.find((p) => p.id === activeProviderId)?.label ?? activeProviderId ?? "主 Provider";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">图片 OCR / 描述</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          启用后，bot 收到图片时会调用 AI 生成一句简短描述，并写入上下文（形如
          <code className="bg-muted mx-1 rounded px-1 py-0.5">[收到图片 123KB | 描述: …]</code>
          ），供后续总结/回复参考。
        </p>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="ocrEnabled"
            checked={config.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            className="border-input h-4 w-4 rounded"
          />
          <label htmlFor="ocrEnabled" className="text-sm font-medium">
            启用图片描述
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Provider</label>
            <select
              className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
              value={config.providerId ?? ""}
              onChange={(e) => onUpdate({ providerId: e.target.value || undefined })}
            >
              <option value="">默认（{activeLabel}）</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.providerFormat})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">模型 ID</label>
            <Input
              placeholder="留空 = 所选 Provider 默认模型"
              value={config.modelId ?? ""}
              onChange={(e) => onUpdate({ modelId: e.target.value || undefined })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">单条消息最多识别图片数</label>
            <Input
              type="number"
              min={0}
              placeholder={`默认 ${DEFAULT_MAX_IMAGES_PER_MESSAGE}`}
              value={config.maxImagesPerMessage ?? ""}
              onChange={(e) =>
                onUpdate({
                  maxImagesPerMessage: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
            <p className="text-muted-foreground text-xs">超过此数的图片跳过 OCR，仍保留占位。</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">冷却时间 (秒)</label>
            <Input
              type="number"
              min={0}
              placeholder={`默认 ${DEFAULT_OCR_COOLDOWN_SECONDS}`}
              value={config.cooldownSeconds ?? ""}
              onChange={(e) =>
                onUpdate({
                  cooldownSeconds: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
            <p className="text-muted-foreground text-xs">
              同一群聊上次 OCR 之后的冷却窗口。设为 0 表示不限速。
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">描述最大长度 (字符)</label>
            <Input
              type="number"
              min={10}
              placeholder={`默认 ${DEFAULT_OCR_MAX_DESCRIPTION_LENGTH}`}
              value={config.maxDescriptionLength ?? ""}
              onChange={(e) =>
                onUpdate({
                  maxDescriptionLength: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">调用超时 (毫秒)</label>
            <Input
              type="number"
              min={1000}
              placeholder={`默认 ${DEFAULT_OCR_TIMEOUT_MS}`}
              value={config.timeoutMs ?? ""}
              onChange={(e) =>
                onUpdate({
                  timeoutMs: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">系统 Prompt (可选)</label>
            <button
              type="button"
              onClick={() => setShowDefault((v) => !v)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            >
              {showDefault ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              查看默认
            </button>
          </div>
          {showDefault && (
            <div className="bg-muted rounded-md p-3 text-xs">
              <pre className="font-mono break-words whitespace-pre-wrap">{DEFAULT_OCR_PROMPT}</pre>
            </div>
          )}
          <textarea
            className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder={DEFAULT_OCR_PROMPT}
            value={config.systemPrompt ?? ""}
            onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
            rows={3}
          />
          <p className="text-muted-foreground text-xs">留空 = 使用默认。</p>
        </div>
      </CardContent>
    </Card>
  );
}
