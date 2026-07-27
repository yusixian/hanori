import { BotForm } from "@/components/bots/bot-form";
import { useCreate } from "@refinedev/core";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";

export function BotCreatePage() {
  const { t } = useTranslation("bots");
  const navigate = useNavigate();
  const { mutateAsync: create } = useCreate();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("create.title")}</h1>

      <BotForm
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
