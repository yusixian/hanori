import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { SelectMenu } from "@/components/ui/select-menu";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/ui/code-block";
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
    providers.find((p) => p.id === activeProviderId)?.label ??
    activeProviderId ??
    "Active provider";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Image OCR and descriptions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          When enabled, the bot uses AI to describe incoming images and adds the result to the
          conversation context for later summaries and replies.
        </p>

        <div className="flex items-center gap-2">
          <Switch
            id="ocrEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <Label htmlFor="ocrEnabled">Enable image descriptions</Label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-provider">Provider</Label>
            <SelectMenu
              id="ocr-provider"
              value={config.providerId ?? "default"}
              onValueChange={(value) =>
                onUpdate({ providerId: value === "default" ? undefined : value })
              }
              ariaLabel="OCR provider"
              options={[
                { value: "default", label: `Default (${activeLabel})` },
                ...providers.map((provider) => ({
                  value: provider.id,
                  label: `${provider.label} (${provider.providerFormat})`,
                })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ocr-model-id">Model ID</Label>
            <Input
              id="ocr-model-id"
              name="ocrModelId"
              autoComplete="off"
              spellCheck={false}
              placeholder="Leave empty to use the provider default"
              value={config.modelId ?? ""}
              onChange={(e) => onUpdate({ modelId: e.target.value || undefined })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-images-per-message">Images per message</Label>
            <NumberInput
              id="ocr-images-per-message"
              name="ocrImagesPerMessage"
              min={0}
              placeholder={`Default: ${DEFAULT_MAX_IMAGES_PER_MESSAGE}`}
              value={config.maxImagesPerMessage ?? ""}
              onValueChange={(maxImagesPerMessage) => onUpdate({ maxImagesPerMessage })}
            />
            <p className="text-muted-foreground text-xs">
              Additional images keep a placeholder but skip OCR.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ocr-cooldown">Cooldown (seconds)</Label>
            <NumberInput
              id="ocr-cooldown"
              name="ocrCooldownSeconds"
              min={0}
              placeholder={`Default: ${DEFAULT_OCR_COOLDOWN_SECONDS}`}
              value={config.cooldownSeconds ?? ""}
              onValueChange={(cooldownSeconds) => onUpdate({ cooldownSeconds })}
            />
            <p className="text-muted-foreground text-xs">
              Time between OCR requests in the same group. Use 0 for no rate limit.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-description-length">Maximum description length</Label>
            <NumberInput
              id="ocr-description-length"
              name="ocrDescriptionLength"
              min={10}
              placeholder={`Default: ${DEFAULT_OCR_MAX_DESCRIPTION_LENGTH}`}
              value={config.maxDescriptionLength ?? ""}
              onValueChange={(maxDescriptionLength) => onUpdate({ maxDescriptionLength })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ocr-timeout">Request timeout (milliseconds)</Label>
            <NumberInput
              id="ocr-timeout"
              name="ocrTimeoutMs"
              min={1000}
              placeholder={`Default: ${DEFAULT_OCR_TIMEOUT_MS}`}
              value={config.timeoutMs ?? ""}
              onValueChange={(timeoutMs) => onUpdate({ timeoutMs })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="ocr-system-prompt">System prompt (optional)</Label>
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
              View default
            </button>
          </div>
          {showDefault && <CodeBlock>{DEFAULT_OCR_PROMPT}</CodeBlock>}
          <Textarea
            id="ocr-system-prompt"
            name="ocrSystemPrompt"
            autoComplete="off"
            placeholder={DEFAULT_OCR_PROMPT}
            value={config.systemPrompt ?? ""}
            onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
            rows={3}
          />
          <p className="text-muted-foreground text-xs">Leave empty to use the default.</p>
        </div>
      </CardContent>
    </Card>
  );
}
