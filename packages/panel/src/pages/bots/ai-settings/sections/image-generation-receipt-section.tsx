import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH,
  IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH,
  type ImageGenerationReceiptConfig,
} from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function ImageGenerationReceiptSection({
  config,
  onUpdate,
}: {
  config: Required<ImageGenerationReceiptConfig>;
  onUpdate: (updates: Partial<ImageGenerationReceiptConfig>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("imageGenerationReceipt.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="image-generation-prompt-preview-length" className="text-sm font-medium">
            {t("imageGenerationReceipt.promptPreviewLength")}
          </label>
          <Input
            id="image-generation-prompt-preview-length"
            type="number"
            min={0}
            max={IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH}
            value={config.promptPreviewLength}
            onChange={(event) => onUpdate({ promptPreviewLength: Number(event.target.value) })}
          />
          <p className="text-muted-foreground text-xs">
            {t("imageGenerationReceipt.promptPreviewLengthDescription", {
              max: IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH,
            })}
          </p>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="image-generation-truncation-notice" className="text-sm font-medium">
                {t("imageGenerationReceipt.truncationNotice")}
              </label>
              <p className="text-muted-foreground text-xs">
                {t("imageGenerationReceipt.truncationNoticeDescription")}
              </p>
            </div>
            <Switch
              id="image-generation-truncation-notice"
              checked={config.truncationNoticeEnabled}
              onCheckedChange={(truncationNoticeEnabled) => onUpdate({ truncationNoticeEnabled })}
            />
          </div>
          <Input
            aria-label={t("imageGenerationReceipt.truncationNoticeText")}
            disabled={!config.truncationNoticeEnabled}
            maxLength={IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH}
            value={config.truncationNoticeText}
            onChange={(event) => onUpdate({ truncationNoticeText: event.target.value })}
          />
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor="image-generation-album-notice" className="text-sm font-medium">
                {t("imageGenerationReceipt.albumNotice")}
              </label>
              <p className="text-muted-foreground text-xs">
                {t("imageGenerationReceipt.albumNoticeDescription")}
              </p>
            </div>
            <Switch
              id="image-generation-album-notice"
              checked={config.albumNoticeEnabled}
              onCheckedChange={(albumNoticeEnabled) => onUpdate({ albumNoticeEnabled })}
            />
          </div>
          <Input
            aria-label={t("imageGenerationReceipt.albumNoticeText")}
            disabled={!config.albumNoticeEnabled}
            maxLength={IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH}
            value={config.albumNoticeText}
            onChange={(event) => onUpdate({ albumNoticeText: event.target.value })}
          />
        </div>

        <p className="text-muted-foreground text-xs">
          {t("imageGenerationReceipt.defaultFallback", {
            max: IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH,
          })}
        </p>
      </CardContent>
    </Card>
  );
}
