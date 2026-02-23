import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AiGroupOverride } from "@cos-tool-bot/shared";
import { Plus } from "lucide-react";
import { useState } from "react";
import { GroupOverrideRow } from "../components/group-override-row";

export function GroupOverridesSection({
  overrides,
  onAdd,
  onUpdate,
  onRemove,
}: {
  overrides: Record<string, AiGroupOverride>;
  onAdd: (chatId: number, chatTitle?: string) => void;
  onUpdate: (key: string, updates: Partial<AiGroupOverride>) => void;
  onRemove: (key: string) => void;
}) {
  const [newChatId, setNewChatId] = useState("");
  const [newChatTitle, setNewChatTitle] = useState("");

  const handleAdd = () => {
    const chatId = Number(newChatId);
    if (Number.isNaN(chatId) || chatId === 0) return;
    if (overrides[String(chatId)]) return;
    onAdd(chatId, newChatTitle || undefined);
    setNewChatId("");
    setNewChatTitle("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Group Overrides</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          Configure per-group AI behavior. "Allow All Users" lets everyone in the group trigger the
          bot; when off, only admins can use it.
        </p>
        {Object.entries(overrides).map(([key, override]) => (
          <GroupOverrideRow
            key={key}
            groupKey={key}
            override={override}
            onUpdate={(updates) => onUpdate(key, updates)}
            onRemove={() => onRemove(key)}
          />
        ))}

        <div className="border-t pt-4">
          <p className="mb-2 text-sm font-medium">Add Group</p>
          <div className="flex gap-2">
            <Input
              value={newChatId}
              onChange={(e) => setNewChatId(e.target.value)}
              placeholder="Chat ID (e.g. -1001234567)"
              className="flex-1"
            />
            <Input
              value={newChatTitle}
              onChange={(e) => setNewChatTitle(e.target.value)}
              placeholder="Title (optional)"
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={handleAdd}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            Use @RawDataBot on Telegram to find a group's chat ID
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
