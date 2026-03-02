import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";
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
          <div className="space-y-2">
            {whitelist.map((userId) => (
              <div
                key={userId}
                className="bg-muted flex items-center justify-between rounded-md px-3 py-2"
              >
                <span className="font-mono text-sm">{userId}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onRemove(userId)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            placeholder="Telegram User ID"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button variant="outline" size="icon" onClick={handleAdd}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
