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
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation("aiSettings");
  const activeLabel =
    providers.find((p) => p.id === activeProviderId)?.label ??
    activeProviderId ??
    t("imageOcr.activeProvider");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("imageOcr.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">{t("imageOcr.description")}</p>

        <div className="flex items-center gap-2">
          <Switch
            id="ocrEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <Label htmlFor="ocrEnabled">{t("imageOcr.enable")}</Label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-provider">{t("common.provider")}</Label>
            <SelectMenu
              id="ocr-provider"
              value={config.providerId ?? "default"}
              onValueChange={(value) =>
                onUpdate({ providerId: value === "default" ? undefined : value })
              }
              ariaLabel={t("imageOcr.providerAria")}
              options={[
                {
                  value: "default",
                  label: t("imageOcr.defaultProvider", { provider: activeLabel }),
                },
                ...providers.map((provider) => ({
                  value: provider.id,
                  label: `${provider.label} (${provider.providerFormat})`,
                })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ocr-model-id">{t("common.modelId")}</Label>
            <Input
              id="ocr-model-id"
              name="ocrModelId"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("imageOcr.modelPlaceholder")}
              value={config.modelId ?? ""}
              onChange={(e) => onUpdate({ modelId: e.target.value || undefined })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-images-per-message">{t("imageOcr.imagesPerMessage")}</Label>
            <NumberInput
              id="ocr-images-per-message"
              name="ocrImagesPerMessage"
              min={0}
              placeholder={t("common.defaultValue", { value: DEFAULT_MAX_IMAGES_PER_MESSAGE })}
              value={config.maxImagesPerMessage ?? ""}
              onValueChange={(maxImagesPerMessage) => onUpdate({ maxImagesPerMessage })}
            />
            <p className="text-muted-foreground text-xs">
              {t("imageOcr.imagesPerMessageDescription")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ocr-cooldown">{t("imageOcr.cooldown")}</Label>
            <NumberInput
              id="ocr-cooldown"
              name="ocrCooldownSeconds"
              min={0}
              placeholder={t("common.defaultValue", { value: DEFAULT_OCR_COOLDOWN_SECONDS })}
              value={config.cooldownSeconds ?? ""}
              onValueChange={(cooldownSeconds) => onUpdate({ cooldownSeconds })}
            />
            <p className="text-muted-foreground text-xs">{t("imageOcr.cooldownDescription")}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-description-length">{t("imageOcr.maxDescriptionLength")}</Label>
            <NumberInput
              id="ocr-description-length"
              name="ocrDescriptionLength"
              min={10}
              placeholder={t("common.defaultValue", {
                value: DEFAULT_OCR_MAX_DESCRIPTION_LENGTH,
              })}
              value={config.maxDescriptionLength ?? ""}
              onValueChange={(maxDescriptionLength) => onUpdate({ maxDescriptionLength })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ocr-timeout">{t("imageOcr.timeout")}</Label>
            <NumberInput
              id="ocr-timeout"
              name="ocrTimeoutMs"
              min={1000}
              placeholder={t("common.defaultValue", { value: DEFAULT_OCR_TIMEOUT_MS })}
              value={config.timeoutMs ?? ""}
              onValueChange={(timeoutMs) => onUpdate({ timeoutMs })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="ocr-system-prompt">{t("imageOcr.systemPrompt")}</Label>
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
              {t("imageOcr.viewDefault")}
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
          <p className="text-muted-foreground text-xs">{t("imageOcr.defaultPromptHelp")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
