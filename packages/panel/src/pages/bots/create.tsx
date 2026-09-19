import { BotForm } from "@/components/bots/bot-form";
import { useCreate } from "@refinedev/core";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useCanManageBot } from "@/hooks/use-can-manage-bot";

export function BotCreatePage() {
  const { t } = useTranslation("bots");
  const navigate = useNavigate();
  const { mutateAsync: create } = useCreate();
  const canManageBot = useCanManageBot();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("create.title")}</h1>

      <BotForm
        canManageCosInside={canManageBot}
        submitLabel={t("create.submit")}
        onSubmit={async (data) => {
          await create({
            resource: "bots",
            values: {
              name: data.name,
              platform: data.platform,
              token: data.token ?? "",
              adminChatIds: data.adminChatIds,
              isActive: data.isActive,
              miniAppEnabled: data.miniAppEnabled,
              webhookUrl: data.webhookUrl,
              signSecret: data.signSecret,
              emailForwardConfig: data.emailForwardConfig,
            },
          });
          navigate("/");
        }}
      />
    </div>
  );
}
