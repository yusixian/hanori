import { BotForm } from "@/components/bots/bot-form";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useOne, useUpdate } from "@refinedev/core";
import { useNavigate, useParams } from "react-router";

export function BotEditPage() {
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
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }

  if (!bot) {
    return <p className="text-muted-foreground text-sm">Bot not found</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Edit Bot</h1>

      <BotForm
        isEdit
        initialData={{
          name: bot.name,
          tokenMasked: bot.tokenMasked,
          adminChatIds: bot.adminChatIds,
          isActive: bot.isActive,
        }}
        submitLabel="Save Changes"
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
            },
          });
          navigate(`/bots/${botId}`);
        }}
      />
    </div>
  );
}
