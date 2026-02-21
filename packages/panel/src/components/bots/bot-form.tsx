import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { FormEvent } from "react";
import { useState } from "react";

interface BotFormData {
  name: string;
  token: string;
  adminChatIds: number[];
  isActive: boolean;
}

interface BotFormProps {
  initialData?: {
    name: string;
    tokenMasked: string;
    adminChatIds: number[];
    isActive: boolean;
  };
  onSubmit: (data: BotFormData) => Promise<void>;
  submitLabel: string;
  isEdit?: boolean;
}

export function BotForm({ initialData, onSubmit, submitLabel, isEdit }: BotFormProps) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [token, setToken] = useState("");
  const [adminChatIds, setAdminChatIds] = useState(initialData?.adminChatIds.join(", ") ?? "");
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const ids = adminChatIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !Number.isNaN(n));

      await onSubmit({
        name,
        token,
        adminChatIds: ids,
        isActive,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle className="text-base">{isEdit ? "Edit Bot" : "Create Bot"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Bot"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Bot Token</label>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                isEdit
                  ? (initialData?.tokenMasked ?? "Leave empty to keep current")
                  : "123456:ABC-DEF..."
              }
              required={!isEdit}
            />
            {isEdit && (
              <p className="text-muted-foreground text-xs">Leave empty to keep current token</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Admin Chat IDs</label>
            <Input
              value={adminChatIds}
              onChange={(e) => setAdminChatIds(e.target.value)}
              placeholder="123456, 789012"
            />
            <p className="text-muted-foreground text-xs">Comma-separated chat IDs</p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isActive"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="border-input h-4 w-4 rounded"
            />
            <label htmlFor="isActive" className="text-sm font-medium">
              Auto-start on server launch
            </label>
          </div>

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
