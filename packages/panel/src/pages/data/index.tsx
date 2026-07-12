import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch, client } from "@/lib/client";
import { triggerDownload } from "@/lib/download";
import { AlertCircle, Download, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import superjson from "superjson";

// ── Export types ──

type ExportFormat = "json" | "gzip";

interface BotOption {
  id: string;
  name: string;
}

// ── Import types ──

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

// ── Helpers ──

async function decompressGzip(buffer: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(buffer));
  writer.close();
  return new Response(ds.readable).text();
}

// ── Export Section ──

function ExportSection() {
  const { t } = useTranslation("admin");
  const [bots, setBots] = useState<BotOption[]>([]);
  const [loadingBots, setLoadingBots] = useState(true);
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");

  useEffect(() => {
    (async () => {
      try {
        const res = await client.api.bots.$get({
          query: { page: "1", limit: "100" },
        });
        const json = await res.json();
        if (json.ok) {
          setBots(
            (json.data as Array<{ id: string; name: string }>).map((b) => ({
              id: b.id,
              name: b.name,
            })),
          );
        }
      } catch (err) {
        console.error("Failed to load bots:", err);
      } finally {
        setLoadingBots(false);
      }
    })();
  }, []);

  const loadStats = useCallback(async (botId: string) => {
    if (!botId) return;
    setLoadingStats(true);
    setStats(null);
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
  }, []);

  const handleBotSelect = (botId: string) => {
    setSelectedBotId(botId);
    setStats(null);
    if (botId) loadStats(botId);
  };

  const handleExport = async () => {
    if (!selectedBotId) return;
    setExporting(true);
    try {
      const query = exportFormat === "gzip" ? "?format=gzip" : "";
      const res = await authFetch(`/api/bots/${selectedBotId}/export${query}`);
      if (!res.ok) {
        const text = await res.text();
        alert(t("data.export.failedWithReason", { error: text }));
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
      alert(t("data.export.failed"));
    } finally {
      setExporting(false);
    }
  };

  const totalExportRows = stats ? Object.values(stats).reduce((a, b) => a + b, 0) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Download className="h-5 w-5" />
          {t("data.export.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{t("data.export.description")}</p>

        <div>
          <label className="text-sm font-medium">{t("data.export.selectBot")}</label>
          <select
            value={selectedBotId}
            onChange={(e) => handleBotSelect(e.target.value)}
            disabled={loadingBots}
            className="border-input bg-background text-foreground mt-1 block w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="">
              {loadingBots ? t("data.export.loadingBots") : t("data.export.selectBotPlaceholder")}
            </option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </div>

        {selectedBotId && (
          <>
            {loadingStats ? (
              <p className="text-muted-foreground text-sm">{t("data.export.loadingStats")}</p>
            ) : stats ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("data.export.dataToExport")}</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(stats).map(([table, count]) => (
                    <Badge key={table} variant={count > 0 ? "default" : "muted"}>
                      {table}: {count}
                    </Badge>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  {t("data.export.totalRows", { count: totalExportRows })}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t("data.export.statsFailed")}</p>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={handleExport} disabled={exporting || loadingStats || !stats}>
                {exporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t("data.export.action")}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Import Section ──

function ImportSection() {
  const { t, i18n } = useTranslation("admin");
  const [manifestPreview, setManifestPreview] = useState<ManifestPreview | null>(null);
  const [importPayload, setImportPayload] = useState<unknown>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResultData | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [i18n.resolvedLanguage],
  );

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
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          text = await decompressGzip(buffer);
        } else {
          text = new TextDecoder().decode(bytes);
        }

        // Strip BOM if present
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }

        // Try plain JSON first, fall back to superjson
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(text) as Record<string, unknown>;
        } catch {
          try {
            data = superjson.parse<Record<string, unknown>>(text);
          } catch {
            setImportError(t("data.import.invalidJson"));
            return;
          }
        }

        if (!data.manifest || (data.manifest as Record<string, unknown>).version !== 1) {
          setImportError(t("data.import.unsupported"));
          return;
        }
        setManifestPreview(data.manifest as unknown as ManifestPreview);
        setImportPayload(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setImportError(t("data.import.invalidFile", { error: msg }));
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
        if (!text) {
          setImportError(t("data.import.failedNoDetails", { status: res.status }));
          return;
        }
        try {
          const parsed = superjson.parse<{ ok: false; error: string }>(text);
          setImportError(parsed.error);
        } catch {
          setImportError(t("data.import.failedWithReason", { error: text }));
        }
        return;
      }
      const json = superjson.parse<{ ok: true; data: ImportResultData }>(await res.text());
      if (json.ok) {
        setImportResult(json.data);
      }
    } catch (err) {
      if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
        setImportError(t("data.import.networkFailed"));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setImportError(t("data.import.failedWithReason", { error: msg }));
      }
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Upload className="h-5 w-5" />
          {t("data.import.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{t("data.import.description")}</p>

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
            <p className="text-sm font-medium">{t("data.import.preview")}</p>
            <div className="text-sm">
              <p>
                <span className="text-muted-foreground">{t("data.import.sourceBot")}</span>{" "}
                {manifestPreview.botName ?? t("data.import.unknown")}
              </p>
              <p>
                <span className="text-muted-foreground">{t("data.import.exported")}</span>{" "}
                {dateTimeFormatter.format(new Date(manifestPreview.exportedAt))}
              </p>
              <p>
                <span className="text-muted-foreground">{t("data.import.scope")}</span>{" "}
                {manifestPreview.scope}
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
                {t("data.import.secretsWarning")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleImport} disabled={importing}>
                {importing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {t("data.import.importAsNew")}
              </Button>
              <Button variant="outline" onClick={clearImport}>
                {t("data.import.cancel")}
              </Button>
            </div>
          </div>
        )}

        {importResult && (
          <div className="space-y-3 rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950">
            <p className="text-sm font-medium text-green-700 dark:text-green-400">
              {t("data.import.success")}
            </p>
            {importResult.importedBots.map((bot) => (
              <div key={bot.newId} className="text-sm">
                <p>{t("data.import.botCreated", { name: bot.name })}</p>
                <a href={`/bots/${bot.newId}/edit`} className="text-primary text-sm underline">
                  {t("data.import.configureToken")}
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
              {t("data.import.importAnother")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Data Page ──

export function DataPage() {
  const { t } = useTranslation("admin");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("data.title")}</h1>
      <ExportSection />
      <ImportSection />
    </div>
  );
}
