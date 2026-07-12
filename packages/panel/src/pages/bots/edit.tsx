import { BotForm } from "@/components/bots/bot-form";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useOne, useUpdate } from "@refinedev/core";
import { useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";

export function BotEditPage() {
  const { t } = useTranslation("bots");
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();

  const { data, isLoading } = useOne<BotWithStatus>({
    resource: "bots",
    id: botId!,
    queryOptions: { enabled: !!botId },
  });

  const { mutateAsync: update } = useUpdate();

  const bot = data?.data;

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">{t("common:common.loading")}</p>;
  }

  if (!bot) {
    return <p className="text-muted-foreground text-sm">{t("dashboard.notFound")}</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("edit.title")}</h1>

      <BotForm
        isEdit
        initialData={{
          name: bot.name,
          platform: bot.platform,
          tokenMasked: bot.tokenMasked,
          adminChatIds: bot.adminChatIds,
          isActive: bot.isActive,
          webhookUrl: bot.larkWebhookConfig?.webhookUrl,
          hasSignSecret: bot.larkWebhookConfig?.hasSignSecret,
          emailForwardConfig: bot.emailForwardConfig,
        }}
        submitLabel={t("edit.submit")}
        onSubmit={async (formData) => {
          if (!botId) return;
          await update({
            resource: "bots",
            id: botId,
            values: {
              name: formData.name,
              adminChatIds: formData.adminChatIds,
              isActive: formData.isActive,
              ...(formData.token ? { token: formData.token } : {}),
              ...(formData.webhookUrl !== undefined ? { webhookUrl: formData.webhookUrl } : {}),
              ...(formData.signSecret !== undefined ? { signSecret: formData.signSecret } : {}),
              ...(formData.emailForwardConfig
                ? { emailForwardConfig: formData.emailForwardConfig }
                : {}),
            },
          });
          navigate(`/bots/${botId}`);
        }}
      />
    </div>
  );
}
