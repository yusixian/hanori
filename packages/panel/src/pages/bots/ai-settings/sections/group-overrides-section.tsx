import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AiGroupOverride } from "@cos-tool-bot/shared";
import { Plus } from "lucide-react";
import { useState } from "react";
import { GroupOverrideRow } from "../components/group-override-row";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation("aiSettings");

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
        <CardTitle className="text-base">{t("groupOverrides.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">{t("groupOverrides.description")}</p>
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
          <p className="mb-2 text-sm font-medium">{t("groupOverrides.addGroup")}</p>
          <div className="flex gap-2">
            <Input
              value={newChatId}
              onChange={(e) => setNewChatId(e.target.value)}
              placeholder={t("groupOverrides.chatIdPlaceholder")}
              className="flex-1"
            />
            <Input
              value={newChatTitle}
              onChange={(e) => setNewChatTitle(e.target.value)}
              placeholder={t("groupOverrides.titlePlaceholder")}
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={handleAdd}>
              <Plus className="h-4 w-4" />
              {t("common.add")}
            </Button>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{t("groupOverrides.chatIdHelp")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
