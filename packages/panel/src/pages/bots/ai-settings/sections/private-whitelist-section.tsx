import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectMenu } from "@/components/ui/select-menu";
import { Plus, Trash2, UserRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function PrivateChatWhitelistSection({
  whitelist,
  accessMode,
  onAccessModeChange,
  onAdd,
  onRemove,
}: {
  whitelist: number[];
  accessMode: "all" | "admin" | "allowlist";
  onAccessModeChange: (mode: "all" | "admin" | "allowlist") => void;
  onAdd: (userId: number) => void;
  onRemove: (userId: number) => void;
}) {
  const [newUserId, setNewUserId] = useState("");
  const { t } = useTranslation("aiSettings");

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
        <CardTitle className="text-base">{t("privateWhitelist.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">{t("privateWhitelist.description")}</p>

        <div className="space-y-1.5">
          <label htmlFor="private-chat-access" className="text-sm font-medium">
            {t("privateWhitelist.accessMode")}
          </label>
          <SelectMenu
            id="private-chat-access"
            value={accessMode}
            onValueChange={(value) => onAccessModeChange(value as "all" | "admin" | "allowlist")}
            ariaLabel={t("privateWhitelist.accessMode")}
            options={[
              { value: "all", label: t("privateWhitelist.accessAll") },
              { value: "admin", label: t("privateWhitelist.accessAdmin") },
              { value: "allowlist", label: t("privateWhitelist.accessAllowlist") },
            ]}
          />
        </div>

        {accessMode === "allowlist" && whitelist.length > 0 && (
          <div className="divide-y overflow-hidden rounded-lg border bg-white">
            {whitelist.map((userId) => (
              <div key={userId} className="flex min-h-12 items-center justify-between px-3 py-2">
                <span className="flex items-center gap-3 font-mono text-sm">
                  <span className="bg-surface-subtle text-muted-foreground flex size-8 items-center justify-center rounded-full">
                    <UserRound className="size-4" />
                  </span>
                  {userId}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:bg-danger-soft hover:text-destructive"
                  onClick={() =>
                    window.confirm(t("privateWhitelist.removeConfirm", { user: userId })) &&
                    onRemove(userId)
                  }
                  aria-label={t("privateWhitelist.removeAria", { user: userId })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {accessMode === "allowlist" && (
          <div className="flex gap-2">
            <Input
              id="whitelist-user-id"
              name="whitelistUserId"
              inputMode="numeric"
              autoComplete="off"
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              placeholder={t("privateWhitelist.userIdPlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
            <Button size="icon" onClick={handleAdd} aria-label={t("privateWhitelist.addAria")}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
