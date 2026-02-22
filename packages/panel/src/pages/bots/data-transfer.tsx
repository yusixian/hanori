import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { client } from "@/lib/client";
import { Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import superjson from "superjson";

type ExportFormat = "json" | "gzip";

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function BotExportPage() {
  const { botId } = useParams<{ botId: string }>();

  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");

  const loadStats = useCallback(async () => {
    if (!botId) return;
    setLoadingStats(true);
    try {
      const res = await client.api.bots[":botId"].export.stats.$get({
        param: { botId },
      });
      if (!res.ok) {
        console.error("Failed to load export stats:", await res.text().catch(() => res.statusText));
        return;
      }
      const json = superjson.parse<{ ok: true; data: Record<string, number> }>(await res.text());
      if (json.ok) {
        setStats(json.data);
      }
    } catch (err) {
      console.error("Failed to load export stats:", err);
    } finally {
      setLoadingStats(false);
    }
  }, [botId]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleExport = async () => {
    if (!botId) return;
    setExporting(true);
    try {
      const token = localStorage.getItem("token");
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const query = exportFormat === "gzip" ? "?format=gzip" : "";
      const res = await fetch(`/api/bots/${botId}/export${query}`, { headers });
      if (!res.ok) {
        const text = await res.text();
        alert(`Export failed: ${text}`);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      const filenameMatch = disposition?.match(/filename="(.+?)"/);
      const date = new Date().toISOString().slice(0, 10);
      const ext = exportFormat === "gzip" ? ".json.gz" : ".json";
      const filename = filenameMatch?.[1] ?? `cos-tool-bot_export_${date}${ext}`;
      triggerDownload(blob, filename);
    } catch (err) {
      console.error("Export failed:", err);
      alert("Export failed");
    } finally {
      setExporting(false);
    }
  };

  const totalExportRows = stats ? Object.values(stats).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Export Data</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Download className="h-5 w-5" />
            Export Bot Data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Export this bot's configuration and associated data. Choose JSON for readability or Gzip
            for smaller file size. Sensitive data (Bot Token, API Keys) will be excluded.
          </p>

          {loadingStats ? (
            <p className="text-muted-foreground text-sm">Loading stats...</p>
          ) : stats ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Data to export:</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(stats).map(([table, count]) => (
                  <Badge key={table} variant={count > 0 ? "default" : "muted"}>
                    {table}: {count}
                  </Badge>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">{totalExportRows} total rows</p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Failed to load export stats.</p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleExport} disabled={exporting || loadingStats}>
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Export
            </Button>
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              className="border-input bg-background text-foreground rounded-md border px-3 py-1.5 text-sm"
            >
              <option value="json">JSON</option>
              <option value="gzip">Gzip (.json.gz)</option>
            </select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
