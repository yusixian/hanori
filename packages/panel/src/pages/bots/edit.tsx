import { BotForm } from "@/components/bots/bot-form";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

export function BotEditPage() {
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const [bot, setBot] = useState<BotWithStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBot = useCallback(async () => {
    if (!botId) return;
    try {
      const res = await client.api.bots[":botId"].$get({ param: { botId } });
      const json = await res.json();
      if (json.ok) setBot(json.data as BotWithStatus);
    } catch (err) {
      console.error("Failed to fetch bot", err);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    fetchBot();
  }, [fetchBot]);

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading...</p>;
  }

  if (!bot) {
    return <p className="text-muted-foreground text-sm">Bot not found</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to={`/bots/${botId}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">Edit Bot</h1>
      </div>

      <BotForm
        isEdit
        initialData={{
          name: bot.name,
          tokenMasked: bot.tokenMasked,
          adminChatIds: bot.adminChatIds,
          isActive: bot.isActive,
        }}
        submitLabel="Save Changes"
        onSubmit={async (data) => {
          if (!botId) return;
          await client.api.bots[":botId"].$put({
            param: { botId },
            json: {
              name: data.name,
              adminChatIds: data.adminChatIds,
              isActive: data.isActive,
              ...(data.token ? { token: data.token } : {}),
            },
          });
          navigate(`/bots/${botId}`);
        }}
      />
    </div>
  );
}
