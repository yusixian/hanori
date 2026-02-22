import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { client } from "@/lib/client";
import { AlertCircle, Download, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import superjson from "superjson";

interface ImportResultData {
  importedBots: Array<{ oldId: string; newId: string; name: string }>;
  counts: Record<string, number>;
}

interface ManifestPreview {
  version: number;
  exportedAt: string;
  scope: string;
  botName?: string;
  tables: string[];
  counts: Record<string, number>;
}

type ExportFormat = "json" | "gzip";

async function decompressGzip(buffer: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(buffer));
  writer.close();
  return new Response(ds.readable).text();
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function BotDataTransferPage() {
  const { botId } = useParams<{ botId: string }>();

  // Export state
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");

  // Import state
  const [manifestPreview, setManifestPreview] = useState<ManifestPreview | null>(null);
  const [importPayload, setImportPayload] = useState<unknown>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResultData | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      if (exportFormat === "gzip") {
        // Use raw fetch for binary response (bypasses RPC JSON parsing)
        const token = localStorage.getItem("token");
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch(`/api/bots/${botId}/export?format=gzip`, { headers });
        if (!res.ok) {
          const text = await res.text();
          alert(`Export failed: ${text}`);
          return;
        }
        const blob = await res.blob();
        const disposition = res.headers.get("Content-Disposition");
        const filenameMatch = disposition?.match(/filename="(.+?)"/);
        const filename =
          filenameMatch?.[1] ??
          `cos-tool-bot_export_${new Date().toISOString().slice(0, 10)}.json.gz`;
        triggerDownload(blob, filename);
      } else {
        const res = await client.api.bots[":botId"].export.$get({
          param: { botId },
          query: {},
        });
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          alert(`Export failed: ${text}`);
          return;
        }
        const json = superjson.parse<
          { ok: true; data: { manifest: { botName?: string } } } | { ok: false; error: string }
        >(await res.text());
        if (!json.ok) {
          alert(`Export failed: ${json.error}`);
          return;
        }
        const blob = new Blob([JSON.stringify(json.data, null, 2)], {
          type: "application/json",
        });
        const botName = (json.data.manifest.botName ?? "bot").replace(/[^a-zA-Z0-9_-]/g, "_");
        const date = new Date().toISOString().slice(0, 10);
        triggerDownload(blob, `cos-tool-bot_${botName}_${date}.json`);
      }
    } catch (err) {
      console.error("Export failed:", err);
      alert("Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleFileSelect = (file: File) => {
    setImportResult(null);
    setImportError(null);
    setManifestPreview(null);
    setImportPayload(null);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        const bytes = new Uint8Array(buffer);

        let text: string;
        // Detect gzip magic bytes (0x1f, 0x8b)
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          text = await decompressGzip(buffer);
        } else {
          text = new TextDecoder().decode(bytes);
        }

        // Try superjson first, fall back to plain JSON for backward compatibility
        let data: Record<string, unknown>;
        try {
          data = superjson.parse<Record<string, unknown>>(text);
        } catch {
          data = JSON.parse(text) as Record<string, unknown>;
        }
        if (!data.manifest || (data.manifest as Record<string, unknown>).version !== 1) {
          setImportError("Invalid export file: unsupported format or version");
          return;
        }
        setManifestPreview(data.manifest as unknown as ManifestPreview);
        setImportPayload(data);
      } catch {
        setImportError("Invalid file: could not parse as JSON or gzip");
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleImport = async () => {
    if (!importPayload) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await client.api.bots.import.$post({
        json: importPayload as Record<string, unknown>,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        try {
          const parsed = superjson.parse<{ ok: false; error: string }>(text);
          setImportError(parsed.error);
        } catch {
          setImportError(`Import failed: ${text}`);
        }
        return;
      }
      const json = superjson.parse<{ ok: true; data: ImportResultData }>(await res.text());
      if (json.ok) {
        setImportResult(json.data);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setImportError(`Import failed: ${msg}`);
    } finally {
      setImporting(false);
    }
  };

  const clearImport = () => {
    setManifestPreview(null);
    setImportPayload(null);
    setImportResult(null);
    setImportError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const totalExportRows = stats ? Object.values(stats).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Data Transfer</h1>

      {/* Export Card */}
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

      {/* Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Upload className="h-5 w-5" />
            Import Bot Data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Import a previously exported file (.json or .json.gz). A new Bot will be created with
            the imported data. You'll need to configure the Bot Token after import.
          </p>

          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.gz"
              className="file:border-input file:bg-background file:text-foreground text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelect(f);
              }}
            />
          </div>

          {importError && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <p className="text-sm text-red-700 dark:text-red-400">{importError}</p>
            </div>
          )}

          {manifestPreview && !importResult && (
            <div className="space-y-3 rounded-md border p-4">
              <p className="text-sm font-medium">File Preview</p>
              <div className="text-sm">
                <p>
                  <span className="text-muted-foreground">Source Bot:</span>{" "}
                  {manifestPreview.botName ?? "Unknown"}
                </p>
                <p>
                  <span className="text-muted-foreground">Exported:</span>{" "}
                  {new Date(manifestPreview.exportedAt).toLocaleString()}
                </p>
                <p>
                  <span className="text-muted-foreground">Scope:</span> {manifestPreview.scope}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(manifestPreview.counts).map(([table, count]) => (
                  <Badge key={table} variant={count > 0 ? "default" : "muted"}>
                    {table}: {count}
                  </Badge>
                ))}
              </div>
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Bot Token and API Keys are not included in the export. You'll need to configure
                  them after import.
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleImport} disabled={importing}>
                  {importing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Import as New Bot
                </Button>
                <Button variant="outline" onClick={clearImport}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {importResult && (
            <div className="space-y-3 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                Import successful!
              </p>
              {importResult.importedBots.map((bot) => (
                <div key={bot.newId} className="text-sm">
                  <p>
                    Bot "<strong>{bot.name}</strong>" created.
                  </p>
                  <a href={`/bots/${bot.newId}/edit`} className="text-primary text-sm underline">
                    Configure Bot Token →
                  </a>
                </div>
              ))}
              {Object.keys(importResult.counts).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(importResult.counts).map(([table, count]) => (
                    <Badge key={table} variant="default">
                      {table}: {count}
                    </Badge>
                  ))}
                </div>
              )}
              <Button variant="outline" size="sm" onClick={clearImport}>
                Import Another
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
