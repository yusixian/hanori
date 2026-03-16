import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { McpServerPreset } from "@cos-tool-bot/shared";
import { Loader2 } from "lucide-react";

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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quick Start from Preset</CardTitle>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {form.mode === "create" ? "Add MCP Server" : "Edit MCP Server"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={form.name}
              onChange={(e) => onFormChange({ ...form, name: e.target.value })}
              placeholder="My MCP Server"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Transport</label>
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
          <label className="text-sm font-medium">URL</label>
          <Input
            value={form.url}
            onChange={(e) => onFormChange({ ...form, url: e.target.value })}
            placeholder="https://mcp-server.example.com/sse"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Description</label>
          <Input
            value={form.description}
            onChange={(e) => onFormChange({ ...form, description: e.target.value })}
            placeholder="Optional description"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Headers (JSON)</label>
          <textarea
            className="border-input min-h-[80px] w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
            value={form.headers}
            onChange={(e) => onFormChange({ ...form, headers: e.target.value })}
            placeholder='{"Authorization": "Bearer YOUR_API_KEY"}'
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Tool Name Prefix</label>
            <Input
              value={form.toolNamePrefix}
              onChange={(e) => onFormChange({ ...form, toolNamePrefix: e.target.value })}
              placeholder="mcp (default)"
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="border-input h-4 w-4 rounded"
                checked={form.isActive}
                onChange={(e) => onFormChange({ ...form, isActive: e.target.checked })}
              />
              <span className="text-sm font-medium">Active</span>
            </label>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={onSave} disabled={saving || !form.name || !form.url}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {form.mode === "create" ? "Add" : "Save"}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
