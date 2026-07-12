import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { authFetch, client } from "@/lib/client";
import { triggerDownload } from "@/lib/download";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BackupRecord, BackupStorageType } from "@cos-tool-bot/shared";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  HardDrive,
  Loader2,
  Plus,
  Settings,
  Trash2,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Helpers ──

function formatBytes(bytes: number, locale?: string): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const value = Number((bytes / Math.pow(k, i)).toFixed(1));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${sizes[i]}`;
}

// ── Create Backup Section ──

function CreateBackupSection({ onCreated }: { onCreated: () => void }) {
  const { t, i18n } = useTranslation("admin");
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
        setSuccess(
          t("backup.create.success", {
            filename: json.data.filename,
            size: formatBytes(json.data.sizeBytes, i18n.resolvedLanguage),
          }),
        );
        onCreated();
      } else {
        setError(json.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("backup.create.failed"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Plus className="h-5 w-5" />
          {t("backup.create.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">{t("backup.create.description")}</p>
        <Button onClick={handleCreate} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {creating ? t("backup.create.creating") : t("backup.create.action")}
        </Button>
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-900 bg-red-950 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}
        {success && (
          <div className="flex items-start gap-2 rounded-md border border-green-900 bg-green-950 p-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <p className="text-sm text-emerald-600">{success}</p>
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
  const { t, i18n } = useTranslation("admin");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [i18n.resolvedLanguage],
  );

  const handleDownload = async (record: BackupRecord) => {
    setDownloadingId(record.id);
    try {
      const res = await authFetch(`/api/backup/${record.id}/download`);
      if (!res.ok) {
        alert(t("backup.history.downloadFailed"));
        return;
      }
      const blob = await res.blob();
      triggerDownload(blob, record.filename);
    } catch {
      alert(t("backup.history.downloadFailed"));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t("backup.history.deleteConfirm"))) return;
    setDeletingId(id);
    try {
      const res = await client.api.backup[":id"].$delete({ param: { id: String(id) } });
      const json = await res.json();
      if (!json.ok) {
        alert(t("backup.history.deleteFailedWithReason", { error: json.error }));
      }
      onRefresh();
    } catch {
      alert(t("backup.history.deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <HardDrive className="h-5 w-5" />
          {t("backup.history.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">{t("backup.history.loading")}</span>
          </div>
        ) : records.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">{t("backup.history.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="pr-4 pb-2 font-medium">{t("backup.history.filename")}</th>
                  <th className="pr-4 pb-2 font-medium">{t("backup.history.size")}</th>
                  <th className="pr-4 pb-2 font-medium">{t("backup.history.duration")}</th>
                  <th className="pr-4 pb-2 font-medium">{t("backup.history.status")}</th>
                  <th className="pr-4 pb-2 font-medium">{t("backup.history.remote")}</th>
                  <th className="pr-4 pb-2 font-medium">{t("backup.history.created")}</th>
                  <th className="pb-2 font-medium">{t("backup.history.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="border-b last:border-0">
                    <td className="max-w-48 truncate py-2 pr-4 font-mono text-xs">
                      {record.filename}
                    </td>
                    <td className="py-2 pr-4">
                      {formatBytes(record.sizeBytes, i18n.resolvedLanguage)}
                    </td>
                    <td className="py-2 pr-4">{formatDuration(record.durationMs)}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={record.status === "completed" ? "default" : "destructive"}>
                        {t(`backup.history.${record.status}`)}
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
                        <span className="text-muted-foreground">{t("backup.history.local")}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {dateTimeFormatter.format(new Date(record.createdAt))}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        {record.status === "completed" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownload(record)}
                            disabled={downloadingId === record.id}
                            title={t("backup.history.download")}
                            aria-label={t("backup.history.download")}
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
                          title={t("backup.history.delete")}
                          aria-label={t("backup.history.delete")}
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

interface StorageFormState {
  storageType: BackupStorageType;
  filePrefix: string;
  maxCount: string;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3Prefix: string;
  s3ForcePathStyle: boolean;
  s3StorageClass: string;
  s3ServerSideEncryption: string;
  s3SseKmsKeyId: string;
  showAdvanced: boolean;
}

const initialFormState: StorageFormState = {
  storageType: "local",
  filePrefix: "cos-tool-bot",
  maxCount: "",
  webdavUrl: "",
  webdavUsername: "",
  webdavPassword: "",
  s3Bucket: "",
  s3Region: "",
  s3Endpoint: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  s3Prefix: "",
  s3ForcePathStyle: false,
  s3StorageClass: "",
  s3ServerSideEncryption: "",
  s3SseKmsKeyId: "",
  showAdvanced: false,
};

type StorageFormAction =
  | {
      type: "SET_FIELD";
      field: keyof StorageFormState;
      value: StorageFormState[keyof StorageFormState];
    }
  | { type: "LOAD"; state: Partial<StorageFormState> };

function storageFormReducer(state: StorageFormState, action: StorageFormAction): StorageFormState {
  switch (action.type) {
    case "SET_FIELD":
      return { ...state, [action.field]: action.value };
    case "LOAD":
      return { ...state, ...action.state };
  }
}

function StorageConfigSection() {
  const { t } = useTranslation("admin");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, dispatch] = useReducer(storageFormReducer, initialFormState);

  const setField = <K extends keyof StorageFormState>(field: K, value: StorageFormState[K]) =>
    dispatch({ type: "SET_FIELD", field, value });

  useEffect(() => {
    (async () => {
      try {
        const res = await client.api.backup.config.$get();
        const json = await res.json();
        if (json.ok && json.data) {
          const cfg = json.data;
          const patch: Partial<StorageFormState> = {
            storageType: cfg.storage.type,
            filePrefix: cfg.filePrefix ?? "cos-tool-bot",
            maxCount: cfg.retention?.maxCount ? String(cfg.retention.maxCount) : "",
          };

          if (cfg.storage.type === "webdav") {
            patch.webdavUrl = cfg.storage.url;
            patch.webdavUsername = cfg.storage.username;
            patch.webdavPassword = cfg.storage.encryptedPassword;
          } else if (cfg.storage.type === "s3") {
            patch.s3Bucket = cfg.storage.bucket;
            patch.s3Region = cfg.storage.region;
            patch.s3Endpoint = cfg.storage.endpoint ?? "";
            patch.s3AccessKeyId = cfg.storage.accessKeyId;
            patch.s3SecretAccessKey = cfg.storage.encryptedSecretKey;
            patch.s3Prefix = cfg.storage.prefix ?? "";
            patch.s3ForcePathStyle = cfg.storage.forcePathStyle ?? false;
            patch.s3StorageClass = cfg.storage.storageClass ?? "";
            patch.s3ServerSideEncryption = cfg.storage.serverSideEncryption ?? "";
            patch.s3SseKmsKeyId = cfg.storage.sseKmsKeyId ?? "";
            if (
              cfg.storage.forcePathStyle ||
              cfg.storage.storageClass ||
              cfg.storage.serverSideEncryption ||
              cfg.storage.sseKmsKeyId
            ) {
              patch.showAdvanced = true;
            }
          }
          dispatch({ type: "LOAD", state: patch });
        }
      } catch (err) {
        console.error("Failed to load backup config:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const buildPayload = () => {
    const retention = form.maxCount ? { maxCount: Number(form.maxCount) } : undefined;

    if (form.storageType === "webdav") {
      return {
        storage: {
          type: "webdav" as const,
          url: form.webdavUrl,
          username: form.webdavUsername,
          password: form.webdavPassword,
        },
        filePrefix: form.filePrefix || undefined,
        retention,
      };
    } else if (form.storageType === "s3") {
      return {
        storage: {
          type: "s3" as const,
          bucket: form.s3Bucket,
          region: form.s3Region,
          endpoint: form.s3Endpoint || undefined,
          accessKeyId: form.s3AccessKeyId,
          secretAccessKey: form.s3SecretAccessKey,
          prefix: form.s3Prefix || undefined,
          forcePathStyle: form.s3ForcePathStyle || undefined,
          storageClass: (form.s3StorageClass || undefined) as "STANDARD" | undefined,
          serverSideEncryption: (form.s3ServerSideEncryption || undefined) as "AES256" | undefined,
          sseKmsKeyId: form.s3SseKmsKeyId || undefined,
        },
        filePrefix: form.filePrefix || undefined,
        retention,
      };
    }
    return {
      storage: { type: "local" as const },
      filePrefix: form.filePrefix || undefined,
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
        setSuccess(t("backup.storage.saved"));
        setTimeout(() => setSuccess(null), 3000);
      } else {
        setError("error" in json ? String(json.error) : t("backup.storage.saveFailed"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("backup.storage.saveFailed"));
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
        setTestResult({
          ok: false,
          error: "error" in json ? String(json.error) : t("backup.storage.testFailed"),
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : t("backup.storage.testFailed"),
      });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">{t("backup.storage.loading")}</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Settings className="h-5 w-5" />
          {t("backup.storage.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Storage type */}
        <div>
          <label className="mb-1 block text-sm font-medium">{t("backup.storage.type")}</label>
          <RadioGroup
            value={form.storageType}
            onValueChange={(value) => setField("storageType", value as BackupStorageType)}
            className="flex gap-3"
          >
            {(["local", "webdav", "s3"] as const).map((storageType) => (
              <label key={storageType} className="flex items-center gap-1.5 text-sm">
                <RadioGroupItem value={storageType} />
                {storageType === "local"
                  ? t("backup.storage.localOnly")
                  : storageType === "webdav"
                    ? "WebDAV"
                    : "S3"}
              </label>
            ))}
          </RadioGroup>
        </div>

        {/* WebDAV fields */}
        {form.storageType === "webdav" && (
          <div className="space-y-3 rounded-md border p-3">
            <div>
              <label htmlFor="webdav-url" className="mb-1 block text-sm font-medium">
                {t("backup.storage.webdavUrl")}
              </label>
              <Input
                id="webdav-url"
                value={form.webdavUrl}
                onChange={(e) => setField("webdavUrl", e.target.value)}
                placeholder="https://example.com/dav/backups"
              />
            </div>
            <div>
              <label htmlFor="webdav-username" className="mb-1 block text-sm font-medium">
                {t("backup.storage.username")}
              </label>
              <Input
                id="webdav-username"
                value={form.webdavUsername}
                onChange={(e) => setField("webdavUsername", e.target.value)}
                placeholder="username"
              />
            </div>
            <div>
              <label htmlFor="webdav-password" className="mb-1 block text-sm font-medium">
                {t("backup.storage.password")}
              </label>
              <Input
                id="webdav-password"
                type="password"
                value={form.webdavPassword}
                onChange={(e) => setField("webdavPassword", e.target.value)}
                placeholder="password"
              />
            </div>
          </div>
        )}

        {/* S3 fields */}
        {form.storageType === "s3" && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="s3-bucket" className="mb-1 block text-sm font-medium">
                  {t("backup.storage.bucket")}
                </label>
                <Input
                  id="s3-bucket"
                  value={form.s3Bucket}
                  onChange={(e) => setField("s3Bucket", e.target.value)}
                  placeholder="my-backups"
                />
              </div>
              <div>
                <label htmlFor="s3-region" className="mb-1 block text-sm font-medium">
                  {t("backup.storage.region")}
                </label>
                <Input
                  id="s3-region"
                  value={form.s3Region}
                  onChange={(e) => setField("s3Region", e.target.value)}
                  placeholder="us-east-1"
                />
              </div>
            </div>
            <div>
              <label htmlFor="s3-endpoint" className="mb-1 block text-sm font-medium">
                {t("backup.storage.endpointOptional")}
              </label>
              <Input
                id="s3-endpoint"
                value={form.s3Endpoint}
                onChange={(e) => setField("s3Endpoint", e.target.value)}
                placeholder="https://s3.example.com (for MinIO/R2)"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="s3-access-key" className="mb-1 block text-sm font-medium">
                  {t("backup.storage.accessKeyId")}
                </label>
                <Input
                  id="s3-access-key"
                  value={form.s3AccessKeyId}
                  onChange={(e) => setField("s3AccessKeyId", e.target.value)}
                  placeholder="AKIA..."
                />
              </div>
              <div>
                <label htmlFor="s3-secret-key" className="mb-1 block text-sm font-medium">
                  {t("backup.storage.secretAccessKey")}
                </label>
                <Input
                  id="s3-secret-key"
                  type="password"
                  value={form.s3SecretAccessKey}
                  onChange={(e) => setField("s3SecretAccessKey", e.target.value)}
                  placeholder="secret"
                />
              </div>
            </div>
            <div>
              <label htmlFor="s3-prefix" className="mb-1 block text-sm font-medium">
                {t("backup.storage.prefixOptional")}
              </label>
              <Input
                id="s3-prefix"
                value={form.s3Prefix}
                onChange={(e) => setField("s3Prefix", e.target.value)}
                placeholder="backups/"
              />
            </div>

            {/* Advanced Options */}
            <div className="border-t pt-3">
              <button
                type="button"
                onClick={() => setField("showAdvanced", !form.showAdvanced)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm font-medium transition-colors"
              >
                {form.showAdvanced ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                {t("backup.storage.advancedOptions")}
              </button>
              {form.showAdvanced && (
                <div className="mt-3 space-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={form.s3ForcePathStyle}
                      onCheckedChange={(checked) => setField("s3ForcePathStyle", checked)}
                    />
                    <span className="font-medium">{t("backup.storage.forcePathStyle")}</span>
                    <span className="text-muted-foreground">
                      {t("backup.storage.forcePathStyleHint")}
                    </span>
                  </label>
                  <div>
                    <label htmlFor="s3-storage-class" className="mb-1 block text-sm font-medium">
                      {t("backup.storage.storageClass")}
                    </label>
                    <Input
                      id="s3-storage-class"
                      value={form.s3StorageClass}
                      onChange={(e) => setField("s3StorageClass", e.target.value)}
                      placeholder="STANDARD"
                    />
                  </div>
                  <div>
                    <label htmlFor="s3-sse" className="mb-1 block text-sm font-medium">
                      {t("backup.storage.serverSideEncryption")}
                    </label>
                    <Input
                      id="s3-sse"
                      value={form.s3ServerSideEncryption}
                      onChange={(e) => setField("s3ServerSideEncryption", e.target.value)}
                      placeholder="AES256 or aws:kms"
                    />
                  </div>
                  {form.s3ServerSideEncryption === "aws:kms" && (
                    <div>
                      <label htmlFor="s3-kms-key" className="mb-1 block text-sm font-medium">
                        {t("backup.storage.kmsKeyId")}
                      </label>
                      <Input
                        id="s3-kms-key"
                        value={form.s3SseKmsKeyId}
                        onChange={(e) => setField("s3SseKmsKeyId", e.target.value)}
                        placeholder="arn:aws:kms:..."
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* General settings */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="backup-file-prefix" className="mb-1 block text-sm font-medium">
              {t("backup.storage.filePrefix")}
            </label>
            <Input
              id="backup-file-prefix"
              value={form.filePrefix}
              onChange={(e) => setField("filePrefix", e.target.value)}
              placeholder="cos-tool-bot"
            />
          </div>
          <div>
            <label htmlFor="backup-max-count" className="mb-1 block text-sm font-medium">
              {t("backup.storage.maxBackups")}
            </label>
            <Input
              id="backup-max-count"
              type="number"
              min="0"
              value={form.maxCount}
              onChange={(e) => setField("maxCount", e.target.value)}
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
            {t("backup.storage.save")}
          </Button>
          {form.storageType !== "local" && (
            <Button variant="outline" onClick={handleTest} disabled={testing}>
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wifi className="h-4 w-4" />
              )}
              {t("backup.storage.testConnection")}
            </Button>
          )}
        </div>

        {/* Feedback */}
        {testResult && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-md border p-3",
              testResult.ok ? "border-green-900 bg-green-950" : "border-red-900 bg-red-950",
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            )}
            <p className={cn("text-sm", testResult.ok ? "text-emerald-600" : "text-red-600")}>
              {testResult.ok
                ? t("backup.storage.connectionSuccessful")
                : t("backup.storage.connectionFailed", {
                    error: testResult.error ?? t("backup.storage.testFailed"),
                  })}
            </p>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-900 bg-red-950 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}
        {success && (
          <div className="flex items-start gap-2 rounded-md border border-green-900 bg-green-950 p-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <p className="text-sm text-emerald-600">{success}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Backup Page ──

export function BackupPage() {
  const { t } = useTranslation("admin");
  const [records, setRecords] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.api.backup.$get();
      const json = await res.json();
      if (json.ok) {
        setRecords(json.data);
      }
    } catch (err) {
      console.error("Failed to load backup records:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("backup.title")}</h1>
      <CreateBackupSection onCreated={loadRecords} />
      <BackupHistorySection records={records} loading={loading} onRefresh={loadRecords} />
      <StorageConfigSection />
    </div>
  );
}
