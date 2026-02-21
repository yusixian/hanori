import { BotForm } from "@/components/bots/bot-form";
import { useCreate } from "@refinedev/core";
import { useNavigate } from "react-router";

export function BotCreatePage() {
  const navigate = useNavigate();
  const { mutateAsync: create } = useCreate();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Add Bot</h1>

      <BotForm
        submitLabel="Create Bot"
        onSubmit={async (data) => {
          await create({
            resource: "bots",
            values: {
              name: data.name,
              token: data.token,
              adminChatIds: data.adminChatIds,
              isActive: data.isActive,
            },
          });
          navigate("/");
        }}
      />
    </div>
  );
}
