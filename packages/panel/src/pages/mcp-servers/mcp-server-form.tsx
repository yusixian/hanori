import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { McpServerPreset } from "@cos-tool-bot/shared";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface FormState {
  mode: "create" | "edit";
  id?: number;
  name: string;
  description: string;
  transport: "sse" | "streamable-http";
  url: string;
  headers: string;
  toolNamePrefix: string;
  isActive: boolean;
  presetId: string | null;
  hadHeaders?: boolean;
}

export const emptyForm: FormState = {
  mode: "create",
  name: "",
  description: "",
  transport: "sse",
  url: "",
  headers: "",
  toolNamePrefix: "",
  isActive: true,
  presetId: null,
};

export function PresetPicker({
  presets,
  onSelect,
}: {
  presets: McpServerPreset[];
  onSelect: (preset: McpServerPreset) => void;
}) {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("mcp.preset.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="hover:bg-accent rounded-lg border p-3 text-left transition-colors"
              onClick={() => onSelect(p)}
            >
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-muted-foreground mt-1 text-xs">{p.description}</div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function McpServerForm({
  form,
  saving,
  onFormChange,
  onSave,
  onCancel,
}: {
  form: FormState;
  saving: boolean;
  onFormChange: (form: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {form.mode === "create" ? t("mcp.form.addTitle") : t("mcp.form.editTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("mcp.form.name")}</label>
            <Input
              value={form.name}
              onChange={(e) => onFormChange({ ...form, name: e.target.value })}
              placeholder={t("mcp.form.namePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("mcp.form.transport")}</label>
            <Select
              className="w-full"
              value={form.transport}
              onChange={(e) =>
                onFormChange({ ...form, transport: e.target.value as "sse" | "streamable-http" })
              }
            >
              <option value="sse">SSE</option>
              <option value="streamable-http">Streamable HTTP</option>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("mcp.form.url")}</label>
          <Input
            value={form.url}
            onChange={(e) => onFormChange({ ...form, url: e.target.value })}
            placeholder="https://mcp-server.example.com/sse"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("mcp.form.description")}</label>
          <Input
            value={form.description}
            onChange={(e) => onFormChange({ ...form, description: e.target.value })}
            placeholder={t("mcp.form.descriptionPlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("mcp.form.headers")}</label>
          <Textarea
            className="border-input min-h-[80px] w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
            value={form.headers}
            onChange={(e) => onFormChange({ ...form, headers: e.target.value })}
            placeholder='{"Authorization": "Bearer YOUR_API_KEY"}'
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("mcp.form.toolNamePrefix")}</label>
            <Input
              value={form.toolNamePrefix}
              onChange={(e) => onFormChange({ ...form, toolNamePrefix: e.target.value })}
              placeholder={t("mcp.form.prefixPlaceholder")}
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={form.isActive}
                onCheckedChange={(isActive) => onFormChange({ ...form, isActive })}
              />
              <span className="text-sm font-medium">{t("mcp.form.active")}</span>
            </label>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={onSave} disabled={saving || !form.name || !form.url}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {form.mode === "create" ? t("mcp.form.add") : t("mcp.form.save")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("mcp.form.cancel")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
