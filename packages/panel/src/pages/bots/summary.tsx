import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CodeBlock } from "@/components/ui/code-block";
import { client } from "@/lib/client";
import type { ChatSummaryRecord, SummaryConfigRecord } from "@cos-tool-bot/shared";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { SummaryConfigForm } from "./summary-config-form";
import { useTranslation } from "react-i18next";

function formatDate(iso: string, locale: string | undefined) {
  return new Date(iso).toLocaleString(locale, { hour12: false });
}

function HistoryDetailModal({
  record,
  onClose,
}: {
  record: ChatSummaryRecord;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("bots");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg border p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {t("summary.detailTitle", {
              chatId: record.chatId,
              date: formatDate(record.createdAt, i18n.resolvedLanguage),
            })}
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="text-muted-foreground mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>
            {t("summary.trigger")}:{" "}
            {record.trigger === "manual" ? t("summary.manual") : t("summary.scheduled")}
          </span>
          <span>{t("summary.messageCount", { count: record.messageCount })}</span>
          <span>{t("summary.model", { model: record.modelId })}</span>
          {record.promptTokens != null && (
            <span>{t("summary.promptTokens", { count: record.promptTokens })}</span>
          )}
          {record.completionTokens != null && (
            <span>{t("summary.completionTokens", { count: record.completionTokens })}</span>
          )}
          {record.durationMs != null && (
            <span>{t("summary.duration", { duration: record.durationMs })}</span>
          )}
        </div>
        {record.errorMessage ? (
          <p className="text-sm text-red-500">{record.errorMessage}</p>
        ) : (
          <CodeBlock className="max-h-none text-sm">{record.content}</CodeBlock>
        )}
      </div>
    </div>
  );
}

function SummaryConfigList({ botId, onChanged }: { botId: string; onChanged?: () => void }) {
  const { t, i18n } = useTranslation("bots");
  const [configs, setConfigs] = useState<SummaryConfigRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await client.api.bots[":botId"].summary.configs.$get({ param: { botId } });
      const json = await res.json();
      if (json.ok) setConfigs(json.data);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const doAction = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : t("rss.operationFailed"));
    } finally {
      setBusy(null);
    }
  };

  const deleteConfig = async (id: number) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    await doAction(`del-${id}`, async () => {
      await client.api.bots[":botId"].summary.configs[":id"].$delete({
        param: { botId, id: String(id) },
      });
      showToast("success", t("summary.deleted"));
      await fetchConfigs();
      onChanged?.();
    });
  };

  const triggerNow = async (id: number) => {
    await doAction(`trigger-${id}`, async () => {
      const res = await client.api.bots[":botId"].summary.configs[":id"].trigger.$post({
        param: { botId, id: String(id) },
        json: { mode: { kind: "default" } },
      });
      const json = await res.json();
      if (json.ok && json.data.ok) {
        showToast("success", t("summary.triggered"));
        onChanged?.();
      } else {
        showToast(
          "error",
          json.ok && json.data.reason ? json.data.reason : t("summary.triggerFailed"),
        );
      }
    });
  };

  if (loading) return <p className="text-muted-foreground text-sm">{t("common:common.loading")}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("summary.configList")}</h2>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4" />
          {t("summary.addConfig")}
        </Button>
      </div>

      {showCreate && (
        <SummaryConfigForm
          botId={botId}
          onSaved={() => {
            setShowCreate(false);
            fetchConfigs();
            onChanged?.();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {toast && (
        <p
          className={`text-sm ${toast.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}
        >
          {toast.message}
          <Button
            size="sm"
            variant="ghost"
            className="ml-2 h-auto p-0 underline"
            onClick={() => setToast(null)}
          >
            {t("common:common.close")}
          </Button>
        </p>
      )}

      {configs.length === 0 && !showCreate && (
        <p className="text-muted-foreground text-sm">{t("summary.noConfigs")}</p>
      )}

      {configs.map((cfg) => (
        <Card key={cfg.id}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="font-mono text-base">
                  {t("summary.chatTitle", { chatId: cfg.chatId })}
                </CardTitle>
                <Badge variant={cfg.isActive ? "default" : "muted"}>
                  {cfg.isActive ? t("common:common.enabled") : t("common:common.disabled")}
                </Badge>
                {cfg.scheduleHour != null && cfg.scheduleMinute != null && (
                  <span className="text-muted-foreground text-xs">
                    {t("summary.scheduledAt")} {String(cfg.scheduleHour).padStart(2, "0")}:
                    {String(cfg.scheduleMinute).padStart(2, "0")}
                  </span>
                )}
                <span className="text-muted-foreground text-xs">
                  {t("summary.windowHours", { count: cfg.windowHours })}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t("summary.access")}:{" "}
                  {cfg.accessMode === "all" ? t("summary.form.everyone") : t("summary.admins")}
                </span>
              </div>
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setEditingId(editingId === cfg.id ? null : cfg.id)}
                  title={t("common:common.edit")}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => triggerNow(cfg.id)}
                  title={t("summary.triggerNow")}
                >
                  {busy === `trigger-${cfg.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant={confirmDelete === cfg.id ? "destructive" : "ghost"}
                  disabled={busy !== null}
                  onClick={() => deleteConfig(cfg.id)}
                  title={confirmDelete === cfg.id ? t("rss.clickAgain") : t("common:common.delete")}
                >
                  <Trash2 className={`h-4 w-4 ${confirmDelete === cfg.id ? "" : "text-red-500"}`} />
                </Button>
              </div>
            </div>
            <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 text-xs">
              {cfg.lastManualAt && (
                <span>
                  {t("summary.lastManual")}: {formatDate(cfg.lastManualAt, i18n.resolvedLanguage)}
                </span>
              )}
              {cfg.lastScheduledAt && (
                <span>
                  {t("summary.lastScheduled")}:{" "}
                  {formatDate(cfg.lastScheduledAt, i18n.resolvedLanguage)}
                </span>
              )}
              {cfg.modelId && <span>{t("summary.model", { model: cfg.modelId })}</span>}
            </div>
          </CardHeader>

          {editingId === cfg.id && (
            <CardContent>
              <SummaryConfigForm
                botId={botId}
                config={cfg}
                onSaved={() => {
                  setEditingId(null);
                  fetchConfigs();
                  onChanged?.();
                }}
                onCancel={() => setEditingId(null)}
              />
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  );
}

function SummaryHistoryList({ botId }: { botId: string }) {
  const { t, i18n } = useTranslation("bots");
  const [history, setHistory] = useState<ChatSummaryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [filterChatId, setFilterChatId] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<ChatSummaryRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const query: Record<string, string> = {
        page: String(page),
        limit: String(limit),
      };
      if (filterChatId) query.chatId = filterChatId;
      const res = await client.api.bots[":botId"].summary.history.$get({
        param: { botId },
        query,
      });
      const json = await res.json();
      if (json.ok) {
        setHistory(json.data as ChatSummaryRecord[]);
        setTotal(json.total);
      }
    } finally {
      setLoading(false);
    }
  }, [botId, page, limit, filterChatId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const deleteHistory = async (id: number) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    setBusy(id);
    try {
      await client.api.bots[":botId"].summary.history[":id"].$delete({
        param: { botId, id: String(id) },
      });
      await fetchHistory();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("summary.history")}</h2>
        <Button size="sm" variant="outline" onClick={fetchHistory} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="number"
          placeholder={t("summary.filterChatId")}
          className="w-40"
          value={filterChatId}
          onChange={(e) => {
            setFilterChatId(e.target.value);
            setPage(1);
          }}
        />
        {filterChatId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilterChatId("");
              setPage(1);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {history.length === 0 && !loading && (
        <p className="text-muted-foreground text-sm">{t("summary.noHistory")}</p>
      )}

      <div className="space-y-2">
        {history.map((rec) => (
          <Card key={rec.id}>
            <CardContent className="flex items-center justify-between py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">
                    {t("summary.chatTitle", { chatId: rec.chatId })}
                  </span>
                  <Badge variant={rec.errorMessage ? "destructive" : "default"}>
                    {rec.errorMessage ? t("summary.failed") : t("summary.succeeded")}
                  </Badge>
                  <Badge variant="muted">
                    {rec.trigger === "manual" ? t("summary.manual") : t("summary.scheduled")}
                  </Badge>
                </div>
                <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-xs">
                  <span>{formatDate(rec.createdAt, i18n.resolvedLanguage)}</span>
                  <span>{t("summary.messageCountValue", { count: rec.messageCount })}</span>
                  <span>{rec.modelId}</span>
                </div>
                {rec.errorMessage && (
                  <p className="mt-1 truncate text-xs text-red-500">{rec.errorMessage}</p>
                )}
              </div>
              <div className="ml-2 flex shrink-0 items-center gap-1">
                {!rec.errorMessage && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedRecord(rec)}
                    title={t("summary.viewContent")}
                  >
                    {t("summary.view")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={confirmDelete === rec.id ? "destructive" : "ghost"}
                  disabled={busy === rec.id}
                  onClick={() => deleteHistory(rec.id)}
                  title={confirmDelete === rec.id ? t("rss.clickAgain") : t("common:common.delete")}
                >
                  {busy === rec.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2
                      className={`h-4 w-4 ${confirmDelete === rec.id ? "" : "text-red-500"}`}
                    />
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground text-sm">
            {t("summary.pagination", { page, totalPages, total })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {selectedRecord && (
        <HistoryDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
      )}
    </div>
  );
}

export function BotSummaryPage() {
  const { t } = useTranslation("bots");
  const { botId } = useParams<{ botId: string }>();
  const [historyKey, setHistoryKey] = useState(0);

  if (!botId) return <p className="text-muted-foreground text-sm">{t("dashboard.notFound")}</p>;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t("summary.title")}</h1>

      <SummaryConfigList botId={botId} onChanged={() => setHistoryKey((k) => k + 1)} />

      <div className="border-t pt-4">
        <SummaryHistoryList key={historyKey} botId={botId} />
      </div>
    </div>
  );
}
