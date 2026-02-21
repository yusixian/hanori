import { BotForm } from "@/components/bots/bot-form";
import { Button } from "@/components/ui/button";
import { useCreate } from "@refinedev/core";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "react-router";

export function BotCreatePage() {
  const navigate = useNavigate();
  const { mutateAsync: create } = useCreate();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">Add Bot</h1>
      </div>

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
