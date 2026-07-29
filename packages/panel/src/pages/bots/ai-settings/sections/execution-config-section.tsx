import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "react-i18next";
import { type AiExecutionConfigDraft, validateExecutionConfig } from "../execution-config";

export function ExecutionConfigSection({
  config,
  onUpdate,
}: {
  config: AiExecutionConfigDraft;
  onUpdate: (config: AiExecutionConfigDraft) => void;
}) {
  const { t } = useTranslation("aiSettings");
  const errors = validateExecutionConfig(config);
  const textLength = config.queueNotice.text.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("execution.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-muted-foreground text-xs">{t("execution.description")}</p>

        <div className="space-y-1.5">
          <Label htmlFor="max-concurrent-replies">{t("execution.maxConcurrentReplies")}</Label>
          <NumberInput
            id="max-concurrent-replies"
            name="maxConcurrentReplies"
            min={1}
            max={32}
            value={config.maxConcurrentReplies ?? ""}
            onValueChange={(maxConcurrentReplies) => onUpdate({ ...config, maxConcurrentReplies })}
            aria-invalid={errors.maxConcurrentReplies ? true : undefined}
            aria-describedby={
              errors.maxConcurrentReplies
                ? "max-concurrent-replies-error"
                : "max-concurrent-replies-description"
            }
          />
          <p id="max-concurrent-replies-description" className="text-muted-foreground text-xs">
            {t("execution.maxConcurrentRepliesDescription")}
          </p>
          {errors.maxConcurrentReplies && (
            <p id="max-concurrent-replies-error" role="alert" className="text-destructive text-xs">
              {t("execution.validation.maxConcurrentReplies")}
            </p>
          )}
        </div>

        <div className="space-y-4 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="queue-notice-enabled">{t("execution.queueNotice")}</Label>
              <p className="text-muted-foreground text-xs">
                {t("execution.queueNoticeDescription")}
              </p>
            </div>
            <Switch
              id="queue-notice-enabled"
              checked={config.queueNotice.enabled}
              onCheckedChange={(enabled) =>
                onUpdate({
                  ...config,
                  queueNotice: { ...config.queueNotice, enabled },
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="queue-notice-text">{t("execution.queueNoticeText")}</Label>
              <span className="text-muted-foreground text-xs">{textLength}/200</span>
            </div>
            <Textarea
              id="queue-notice-text"
              name="queueNoticeText"
              rows={3}
              maxLength={200}
              disabled={!config.queueNotice.enabled}
              value={config.queueNotice.text}
              onChange={(event) =>
                onUpdate({
                  ...config,
                  queueNotice: { ...config.queueNotice, text: event.target.value },
                })
              }
              aria-invalid={errors.queueNoticeText ? true : undefined}
              aria-describedby={
                errors.queueNoticeText ? "queue-notice-text-error" : "queue-notice-text-description"
              }
            />
            <p id="queue-notice-text-description" className="text-muted-foreground text-xs">
              {t("execution.queueNoticeTextDescription")}
            </p>
            {errors.queueNoticeText && (
              <p id="queue-notice-text-error" role="alert" className="text-destructive text-xs">
                {t(`execution.validation.queueNoticeText.${errors.queueNoticeText}`)}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
