import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  HardDrive,
  Loader2,
  Plus,
  Settings,
  Trash2,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// ── Types ──

interface BackupRecord {
  id: number;
  filename: string;
  sizeBytes: number;
  durationMs: number;
  remoteUrl: string | null;
  remoteProvider: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

type StorageType = "local" | "webdav" | "s3";

interface BackupConfigData {
  storage: {
    type: StorageType;
    url?: string;
    username?: string;
    encryptedPassword?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    encryptedSecretKey?: string;
    prefix?: string;
  };
  filePrefix?: string;
  retention?: {
    maxCount?: number;
  };
}

// ── Helpers ──

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Create Backup Section ──

function CreateBackupSection({ onCreated }: { onCreated: () => void }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await client.api.backup.$post();
      const json = await res.json();
      if (json.ok) {
        setSuccess(`Backup created: ${json.data.filename} (${formatBytes(json.data.sizeBytes)})`);
        onCreated();
      } else {
        setError(json.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create backup");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Plus className="h-5 w-5" />
          Create Backup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Create a full database backup (pg_dump, gzipped). If remote storage is configured, the
          backup will also be uploaded.
        </p>
        <Button onClick={handleCreate} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {creating ? "Creating backup..." : "Create Backup"}
        </Button>
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}
        {success && (
          <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <p className="text-sm text-green-700 dark:text-green-400">{success}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Backup History Section ──

function BackupHistorySection({
  records,
  loading,
  onRefresh,
}: {
  records: BackupRecord[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const handleDownload = async (record: BackupRecord) => {
    setDownloadingId(record.id);
    try {
      const token = localStorage.getItem("token");
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`/api/backup/${record.id}/download`, { headers });
      if (!res.ok) {
        alert("Download failed");
        return;
      }
      const blob = await res.blob();
      triggerDownload(blob, record.filename);
    } catch {
      alert("Download failed");
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this backup? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      const res = await client.api.backup[":id"].$delete({ param: { id: String(id) } });
      const json = await res.json();
      if (!json.ok) alert("Delete failed: " + json.error);
      onRefresh();
    } catch {
      alert("Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <HardDrive className="h-5 w-5" />
          Backup History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">Loading...</span>
          </div>
        ) : records.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">No backups yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="pr-4 pb-2 font-medium">Filename</th>
                  <th className="pr-4 pb-2 font-medium">Size</th>
                  <th className="pr-4 pb-2 font-medium">Duration</th>
                  <th className="pr-4 pb-2 font-medium">Status</th>
                  <th className="pr-4 pb-2 font-medium">Remote</th>
                  <th className="pr-4 pb-2 font-medium">Created</th>
                  <th className="pb-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="border-b last:border-0">
                    <td className="max-w-48 truncate py-2 pr-4 font-mono text-xs">
                      {record.filename}
                    </td>
                    <td className="py-2 pr-4">{formatBytes(record.sizeBytes)}</td>
                    <td className="py-2 pr-4">{formatDuration(record.durationMs)}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={record.status === "completed" ? "default" : "destructive"}>
                        {record.status}
                      </Badge>
                      {record.error && (
                        <span
                          className="ml-1 cursor-help text-xs text-red-500"
                          title={record.error}
                        >
                          !
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {record.remoteProvider ? (
                        <Badge variant="muted">{record.remoteProvider}</Badge>
                      ) : (
                        <span className="text-muted-foreground">local</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {new Date(record.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        {record.status === "completed" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownload(record)}
                            disabled={downloadingId === record.id}
                          >
                            {downloadingId === record.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Download className="h-3 w-3" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(record.id)}
                          disabled={deletingId === record.id}
                        >
                          {deletingId === record.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Storage Config Section ──

function StorageConfigSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [storageType, setStorageType] = useState<StorageType>("local");
  const [filePrefix, setFilePrefix] = useState("cos-tool-bot");
  const [maxCount, setMaxCount] = useState("");

  // WebDAV fields
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUsername, setWebdavUsername] = useState("");
  const [webdavPassword, setWebdavPassword] = useState("");

  // S3 fields
  const [s3Bucket, setS3Bucket] = useState("");
  const [s3Region, setS3Region] = useState("");
  const [s3Endpoint, setS3Endpoint] = useState("");
  const [s3AccessKeyId, setS3AccessKeyId] = useState("");
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState("");
  const [s3Prefix, setS3Prefix] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await client.api.backup.config.$get();
        const json = await res.json();
        if (json.ok && json.data) {
          const cfg = json.data as unknown as BackupConfigData;
          setStorageType(cfg.storage.type);
          setFilePrefix(cfg.filePrefix ?? "cos-tool-bot");
          setMaxCount(cfg.retention?.maxCount ? String(cfg.retention.maxCount) : "");

          if (cfg.storage.type === "webdav") {
            setWebdavUrl(cfg.storage.url ?? "");
            setWebdavUsername(cfg.storage.username ?? "");
            setWebdavPassword(cfg.storage.encryptedPassword ?? "");
          } else if (cfg.storage.type === "s3") {
            setS3Bucket(cfg.storage.bucket ?? "");
            setS3Region(cfg.storage.region ?? "");
            setS3Endpoint(cfg.storage.endpoint ?? "");
            setS3AccessKeyId(cfg.storage.accessKeyId ?? "");
            setS3SecretAccessKey(cfg.storage.encryptedSecretKey ?? "");
            setS3Prefix(cfg.storage.prefix ?? "");
          }
        }
      } catch {
        // No config yet, use defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const buildPayload = () => {
    const retention = maxCount ? { maxCount: Number(maxCount) } : undefined;

    if (storageType === "webdav") {
      return {
        storage: {
          type: "webdav" as const,
          url: webdavUrl,
          username: webdavUsername,
          password: webdavPassword,
        },
        filePrefix: filePrefix || undefined,
        retention,
      };
    } else if (storageType === "s3") {
      return {
        storage: {
          type: "s3" as const,
          bucket: s3Bucket,
          region: s3Region,
          endpoint: s3Endpoint || undefined,
          accessKeyId: s3AccessKeyId,
          secretAccessKey: s3SecretAccessKey,
          prefix: s3Prefix || undefined,
        },
        filePrefix: filePrefix || undefined,
        retention,
      };
    }
    return {
      storage: { type: "local" as const },
      filePrefix: filePrefix || undefined,
      retention,
    };
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await client.api.backup.config.$put({ json: buildPayload() });
      const json = await res.json();
      if (json.ok) {
        setSuccess("Configuration saved");
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError("error" in json ? String(json.error) : "Failed to save");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const payload = buildPayload();
      const res = await client.api.backup.config.test.$post({ json: { storage: payload.storage } });
      const json = await res.json();
      if (json.ok) {
        setTestResult(json.data as { ok: boolean; error?: string });
      } else {
        setTestResult({ ok: false, error: "error" in json ? String(json.error) : "Test failed" });
      }
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Loading configuration...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Settings className="h-5 w-5" />
          Storage Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Storage type */}
        <div>
          <label className="mb-1 block text-sm font-medium">Storage Type</label>
          <div className="flex gap-3">
            {(["local", "webdav", "s3"] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="storageType"
                  value={t}
                  checked={storageType === t}
                  onChange={() => setStorageType(t)}
                />
                {t === "local" ? "Local Only" : t === "webdav" ? "WebDAV" : "S3"}
              </label>
            ))}
          </div>
        </div>

        {/* WebDAV fields */}
        {storageType === "webdav" && (
          <div className="space-y-3 rounded-md border p-3">
            <div>
              <label className="mb-1 block text-sm font-medium">WebDAV URL</label>
              <Input
                value={webdavUrl}
                onChange={(e) => setWebdavUrl(e.target.value)}
                placeholder="https://example.com/dav/backups"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Username</label>
              <Input
                value={webdavUsername}
                onChange={(e) => setWebdavUsername(e.target.value)}
                placeholder="username"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Password</label>
              <Input
                type="password"
                value={webdavPassword}
                onChange={(e) => setWebdavPassword(e.target.value)}
                placeholder="password"
              />
            </div>
          </div>
        )}

        {/* S3 fields */}
        {storageType === "s3" && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Bucket</label>
                <Input
                  value={s3Bucket}
                  onChange={(e) => setS3Bucket(e.target.value)}
                  placeholder="my-backups"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Region</label>
                <Input
                  value={s3Region}
                  onChange={(e) => setS3Region(e.target.value)}
                  placeholder="us-east-1"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Endpoint (optional)</label>
              <Input
                value={s3Endpoint}
                onChange={(e) => setS3Endpoint(e.target.value)}
                placeholder="https://s3.example.com (for MinIO/R2)"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Access Key ID</label>
                <Input
                  value={s3AccessKeyId}
                  onChange={(e) => setS3AccessKeyId(e.target.value)}
                  placeholder="AKIA..."
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Secret Access Key</label>
                <Input
                  type="password"
                  value={s3SecretAccessKey}
                  onChange={(e) => setS3SecretAccessKey(e.target.value)}
                  placeholder="secret"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Prefix (optional)</label>
              <Input
                value={s3Prefix}
                onChange={(e) => setS3Prefix(e.target.value)}
                placeholder="backups/"
              />
            </div>
          </div>
        )}

        {/* General settings */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium">File Prefix</label>
            <Input
              value={filePrefix}
              onChange={(e) => setFilePrefix(e.target.value)}
              placeholder="cos-tool-bot"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Max Backups (0 = unlimited)</label>
            <Input
              type="number"
              min="0"
              value={maxCount}
              onChange={(e) => setMaxCount(e.target.value)}
              placeholder="0"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Settings className="h-4 w-4" />
            )}
            Save
          </Button>
          {storageType !== "local" && (
            <Button variant="outline" onClick={handleTest} disabled={testing}>
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wifi className="h-4 w-4" />
              )}
              Test Connection
            </Button>
          )}
        </div>

        {/* Feedback */}
        {testResult && (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 ${
              testResult.ok
                ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950"
                : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950"
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            )}
            <p
              className={`text-sm ${testResult.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
            >
              {testResult.ok ? "Connection successful" : `Connection failed: ${testResult.error}`}
            </p>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}
        {success && (
          <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <p className="text-sm text-green-700 dark:text-green-400">{success}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Backup Page ──

export function BackupPage() {
  const [records, setRecords] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.api.backup.$get();
      const json = await res.json();
      if (json.ok) {
        setRecords(json.data as unknown as BackupRecord[]);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Backup</h1>
      <CreateBackupSection onCreated={loadRecords} />
      <BackupHistorySection records={records} loading={loading} onRefresh={loadRecords} />
      <StorageConfigSection />
    </div>
  );
}
