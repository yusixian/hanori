import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, UserRound } from "lucide-react";
import { useState } from "react";

export function PrivateChatWhitelistSection({
  whitelist,
  onAdd,
  onRemove,
}: {
  whitelist: number[];
  onAdd: (userId: number) => void;
  onRemove: (userId: number) => void;
}) {
  const [newUserId, setNewUserId] = useState("");

  const handleAdd = () => {
    const userId = Number(newUserId);
    if (!Number.isInteger(userId) || userId === 0) return;
    if (whitelist.includes(userId)) return;
    onAdd(userId);
    setNewUserId("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Private Chat Whitelist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          Allow specific users to chat with the bot in private messages. Whitelisted users can use
          AI replies but do NOT have admin command access (restart, backup, etc.).
        </p>

        {whitelist.length > 0 && (
          <div className="divide-y overflow-hidden rounded-lg border bg-white">
            {whitelist.map((userId) => (
              <div key={userId} className="flex min-h-12 items-center justify-between px-3 py-2">
                <span className="flex items-center gap-3 font-mono text-sm">
                  <span className="flex size-8 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                    <UserRound className="size-4" />
                  </span>
                  {userId}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-slate-400 hover:bg-red-50 hover:text-red-600"
                  onClick={() =>
                    window.confirm(`Remove user ${userId} from the whitelist?`) && onRemove(userId)
                  }
                  aria-label={`Remove user ${userId}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            id="whitelist-user-id"
            name="whitelistUserId"
            inputMode="numeric"
            autoComplete="off"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            placeholder="Telegram User ID"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button size="icon" onClick={handleAdd} aria-label="Add user">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
