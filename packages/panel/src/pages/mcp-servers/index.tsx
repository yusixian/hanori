import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { client } from "@/lib/client";
import type {
  McpServerPreset,
  McpServerRecord,
  McpServerStatus,
  McpServerToolInfo,
} from "@cos-tool-bot/shared";
import {
  ChevronDown,
  ChevronUp,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type FormState, McpServerForm, PresetPicker, emptyForm } from "./mcp-server-form";

type ServerWithStatus = McpServerRecord & { status: McpServerStatus };

export function McpServersPage() {
  const [servers, setServers] = useState<ServerWithStatus[]>([]);
  const [presets, setPresets] = useState<McpServerPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState<Set<number>>(new Set());

  const loadServers = useCallback(async () => {
    try {
      const res = await client.api["mcp-servers"].$get();
      const json = await res.json();
      if (json.ok) setServers(json.data as ServerWithStatus[]);
    } catch {
      setServers([]);
      setMessage({ type: "error", text: "Failed to load MCP servers" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
    client.api["mcp-servers"].presets
      .$get()
      .then((res) => res.json())
      .then((json) => {
        if (json.ok) setPresets(json.data);
      })
      .catch((err) => console.error("Failed to load MCP presets", err));
  }, [loadServers]);

  const handlePresetSelect = (preset: McpServerPreset) => {
    const headerObj = preset.headerTemplate ?? {};
    setForm({
      mode: "create",
      name: preset.name,
      description: preset.description,
      transport: preset.transport,
      url: preset.url,
      headers: Object.keys(headerObj).length > 0 ? JSON.stringify(headerObj, null, 2) : "",
      toolNamePrefix: "",
      isActive: true,
      presetId: preset.id,
    });
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      let headers: Record<string, string> | undefined;
      if (form.headers.trim()) {
        try {
          headers = JSON.parse(form.headers);
        } catch {
          setMessage({ type: "error", text: "Headers must be valid JSON" });
          setSaving(false);
          return;
        }
      }

      if (form.mode === "create") {
        const res = await client.api["mcp-servers"].$post({
          json: {
            name: form.name,
            description: form.description || undefined,
            transport: form.transport,
            url: form.url,
            headers,
            isActive: form.isActive,
            presetId: form.presetId ?? undefined,
            toolNamePrefix: form.toolNamePrefix || undefined,
          },
        });
        const json = await res.json();
        if (!json.ok) {
          setMessage({ type: "error", text: "error" in json ? String(json.error) : "Failed" });
          return;
        }
      } else if (form.id != null) {
        const clearHeaders = form.hadHeaders && !form.headers.trim() && !headers;
        const res = await client.api["mcp-servers"][":id"].$patch({
          param: { id: String(form.id) },
          json: {
            name: form.name,
            description: form.description || undefined,
            transport: form.transport,
            url: form.url,
            headers,
            clearHeaders: clearHeaders || undefined,
            isActive: form.isActive,
            toolNamePrefix: form.toolNamePrefix || undefined,
          },
        });
        const json = await res.json();
        if (!json.ok) {
          setMessage({ type: "error", text: "error" in json ? String(json.error) : "Failed" });
          return;
        }
      }

      setForm(null);
      setMessage({
        type: "success",
        text: form.mode === "create" ? "Server added" : "Server updated",
      });
      await loadServers();
    } catch {
      setMessage({ type: "error", text: "Failed to save" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this MCP server?")) return;
    try {
      await client.api["mcp-servers"][":id"].$delete({ param: { id: String(id) } });
      await loadServers();
    } catch {
      setMessage({ type: "error", text: "Failed to delete" });
    }
  };

  const handleConnect = async (id: number) => {
    try {
      await client.api["mcp-servers"][":id"].connect.$post({ param: { id: String(id) } });
      await loadServers();
      setMessage({
        type: "success",
        text: "Connected. Restart bots using this server to pick up tool changes.",
      });
    } catch {
      setMessage({ type: "error", text: "Failed to connect" });
    }
  };

  const handleDisconnect = async (id: number) => {
    try {
      await client.api["mcp-servers"][":id"].disconnect.$post({ param: { id: String(id) } });
      await loadServers();
      setMessage({
        type: "success",
        text: "Disconnected. Restart bots using this server to remove stale tools.",
      });
    } catch {
      setMessage({ type: "error", text: "Failed to disconnect" });
    }
  };

  const toggleTools = (id: number) => {
    setToolsExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) return <p className="text-muted-foreground text-sm">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="h-6 w-6" />
          <h1 className="text-2xl font-bold">MCP Servers</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadServers}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setForm({ ...emptyForm })}>
            <Plus className="h-4 w-4" />
            Add Server
          </Button>
        </div>
      </div>

      {message && (
        <div
          className={`rounded-md p-3 text-sm ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}
        >
          {message.text}
        </div>
      )}

      {form?.mode === "create" && !form.presetId && (
        <PresetPicker presets={presets} onSelect={handlePresetSelect} />
      )}

      {form && (
        <McpServerForm
          form={form}
          saving={saving}
          onFormChange={setForm}
          onSave={handleSave}
          onCancel={() => setForm(null)}
        />
      )}

      {servers.length === 0 && !form && (
        <Card>
          <CardContent className="py-12 text-center">
            <Plug className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
            <p className="text-muted-foreground text-sm">
              No MCP servers configured. Add one to extend your bot's capabilities.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {servers.map((server) => (
          <Card key={server.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{server.name}</span>
                    <Badge variant={server.status.connected ? "success" : "destructive"}>
                      {server.status.connected ? "Connected" : "Disconnected"}
                    </Badge>
                    {server.status.toolCount > 0 && (
                      <Badge variant="muted">
                        <Wrench className="mr-1 h-3 w-3" />
                        {server.status.toolCount} tools
                      </Badge>
                    )}
                    {!server.isActive && <Badge variant="warning">Inactive</Badge>}
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {server.transport.toUpperCase()} &middot; {server.url}
                  </div>
                  {server.description && (
                    <div className="text-muted-foreground mt-0.5 text-xs">{server.description}</div>
                  )}
                  {server.status.error && (
                    <div className="mt-1 text-xs text-red-500">{server.status.error}</div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {server.status.toolCount > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => toggleTools(server.id)}>
                      {toolsExpanded.has(server.id) ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                  {server.status.connected ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDisconnect(server.id)}
                      title="Disconnect"
                    >
                      <Unplug className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleConnect(server.id)}
                      title="Connect"
                    >
                      <PlugZap className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setForm({
                        mode: "edit",
                        id: server.id,
                        name: server.name,
                        description: server.description ?? "",
                        transport: server.transport,
                        url: server.url,
                        headers: "",
                        toolNamePrefix: server.toolNamePrefix ?? "",
                        isActive: server.isActive,
                        presetId: server.presetId,
                        hadHeaders: server.hasHeaders,
                      })
                    }
                    title="Edit"
                  >
                    <Wrench className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(server.id)}
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {toolsExpanded.has(server.id) && server.status.tools.length > 0 && (
                <ToolList tools={server.status.tools} />
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ToolList({ tools }: { tools: McpServerToolInfo[] }) {
  return (
    <div className="mt-3 border-t pt-3">
      <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
        Available Tools
      </p>
      <div className="space-y-2">
        {tools.map((tool) => (
          <div key={tool.name} className="bg-muted/50 rounded-md p-2">
            <div className="text-sm font-medium">{tool.name}</div>
            {tool.description && (
              <div className="text-muted-foreground mt-0.5 text-xs">{tool.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
