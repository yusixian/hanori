import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { client } from "@/lib/client";
import type { RssCollectionRecord, RssFeedRecord, RssItemRecord } from "@cos-tool-bot/shared";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Send,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { CollectionForm } from "./rss-collection-form";
import { FeedList } from "./rss-feed-list";
import { ItemList } from "./rss-item-list";
import { useTranslation } from "react-i18next";

interface CollectionWithFeeds extends RssCollectionRecord {
  feeds?: RssFeedRecord[];
}

export function BotRssPage() {
  const { t } = useTranslation("bots");
  const { botId } = useParams<{ botId: string }>();
  const [collections, setCollections] = useState<CollectionWithFeeds[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [itemsMap, setItemsMap] = useState<
    Record<number, { items: RssItemRecord[]; total: number }>
  >({});
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchCollections = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await client.api.bots[":botId"].rss.collections.$get({
        param: { botId },
      });
      const json = await res.json();
      if (!json.ok) throw new Error("Unable to load RSS collections");
      setCollections(json.data);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  const refreshCollection = async (id: number) => {
    if (!botId) return;
    const [detailRes, itemsRes] = await Promise.all([
      client.api.bots[":botId"].rss.collections[":id"].$get({
        param: { botId, id: String(id) },
      }),
      client.api.bots[":botId"].rss.collections[":id"].items.$get({
        param: { botId, id: String(id) },
        query: { limit: "20", offset: "0" },
      }),
    ]);
    const detail = await detailRes.json();
    const itemsJson = await itemsRes.json();
    if (detail.ok) {
      setCollections((prev) =>
        prev.map((c) => (c.id === id ? { ...detail.data, feeds: detail.data.feeds } : c)),
      );
    }
    if (itemsJson.ok) {
      setItemsMap((prev) => ({
        ...prev,
        [id]: { items: itemsJson.data.items, total: itemsJson.data.totalCount },
      }));
    }
  };

  const expandCollection = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      setEditingId(null);
      return;
    }
    setExpandedId(id);
    setEditingId(null);
    await refreshCollection(id);
  };

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

  const toggleActive = async (col: CollectionWithFeeds) => {
    if (!botId) return;
    await doAction(`toggle-${col.id}`, async () => {
      await client.api.bots[":botId"].rss.collections[":id"].$patch({
        param: { botId, id: String(col.id) },
        json: { isActive: !col.isActive },
      });
      await fetchCollections();
    });
  };

  const deleteCollection = async (id: number) => {
    if (!botId) return;
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    await doAction(`del-${id}`, async () => {
      await client.api.bots[":botId"].rss.collections[":id"].$delete({
        param: { botId, id: String(id) },
      });
      if (expandedId === id) setExpandedId(null);
      await fetchCollections();
    });
  };

  const pollCollection = async (id: number) => {
    if (!botId) return;
    await doAction(`poll-${id}`, async () => {
      const res = await client.api.bots[":botId"].rss.collections[":id"].poll.$post({
        param: { botId, id: String(id) },
      });
      const json = await res.json();
      if (json.ok) {
        showToast("success", t("rss.fetchedItems", { count: json.newItems }));
        if (expandedId === id) await refreshCollection(id);
      }
    });
  };

  const triggerDigest = async (id: number) => {
    if (!botId) return;
    await doAction(`digest-${id}`, async () => {
      const res = await client.api.bots[":botId"].rss.collections[":id"].digest.$post({
        param: { botId, id: String(id) },
      });
      const json = await res.json();
      const triggered = json.ok && json.triggered;
      showToast(
        triggered ? "success" : "error",
        triggered ? t("rss.digestTriggered") : t("rss.noItemsToDigest"),
      );
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t("rss.title")}</h1>
          <p className="text-muted-foreground mt-2 max-w-prose text-sm leading-6">
            {t("rss.description")}
          </p>
        </div>
        {collections.length > 0 && !showCreate && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            {t("rss.newCollection")}
          </Button>
        )}
      </div>

      {loading && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("common:common.loading")}
        </p>
      )}
      {loadFailed && (
        <div
          role="alert"
          className="bg-danger-soft text-destructive flex flex-wrap items-center justify-between gap-3 rounded-xl p-4 text-sm"
        >
          <p>{t("rss.loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void fetchCollections()}>
            {t("common:common.retry")}
          </Button>
        </div>
      )}

      {showCreate && botId && (
        <CollectionForm
          botId={botId}
          onSaved={() => {
            setShowCreate(false);
            fetchCollections();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {toast && (
        <p
          className={`text-sm ${toast.type === "error" ? "text-destructive" : "text-success dark:text-success"}`}
        >
          {toast.message}
          <Button
            size="sm"
            variant="ghost"
            className="ml-2 h-auto p-0 underline"
            onClick={() => setToast(null)}
          >
            {t("rss.dismiss")}
          </Button>
        </p>
      )}

      {!loading && !loadFailed && collections.length === 0 && !showCreate && (
        <EmptyState icon={Rss} title={t("rss.emptyTitle")} description={t("rss.emptyDescription")}>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-4" />
            {t("rss.newCollection")}
          </Button>
        </EmptyState>
      )}

      {collections.map((col) => (
        <Card key={col.id}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <button
                type="button"
                className="focus-visible:ring-ring flex min-h-10 min-w-[min(100%,20rem)] flex-1 items-start gap-2 rounded-lg text-left focus-visible:ring-2 focus-visible:outline-none"
                onClick={() => void expandCollection(col.id)}
                aria-expanded={expandedId === col.id}
                aria-controls={expandedId === col.id ? `rss-collection-${col.id}` : undefined}
              >
                {expandedId === col.id ? (
                  <ChevronDown className="mt-1 size-4 shrink-0" />
                ) : (
                  <ChevronRight className="mt-1 size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 space-y-2">
                  <span className="block text-base leading-6 font-semibold [overflow-wrap:anywhere]">
                    {col.name}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={col.isActive ? "default" : "muted"}>
                      {col.isActive ? t("rss.active") : t("rss.paused")}
                    </Badge>
                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                      <Clock className="h-3 w-3" />
                      UTC {String(col.digestHour).padStart(2, "0")}:
                      {String(col.digestMinute).padStart(2, "0")}
                    </span>
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => toggleActive(col)}
                  title={col.isActive ? t("rss.pause") : t("rss.resume")}
                >
                  {col.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => pollCollection(col.id)}
                  title={t("rss.fetchNow")}
                >
                  {busy === `poll-${col.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => triggerDigest(col.id)}
                  title={t("rss.triggerDigest")}
                >
                  {busy === `digest-${col.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant={confirmDelete === col.id ? "destructive" : "ghost"}
                  disabled={busy !== null}
                  onClick={() => deleteCollection(col.id)}
                  title={confirmDelete === col.id ? t("rss.clickAgain") : t("common:common.delete")}
                >
                  <Trash2
                    className={`h-4 w-4 ${confirmDelete === col.id ? "" : "text-destructive"}`}
                  />
                </Button>
              </div>
            </div>
            {col.description && (
              <p className="text-muted-foreground mt-1 text-sm">{col.description}</p>
            )}
          </CardHeader>

          {expandedId === col.id && (
            <CardContent id={`rss-collection-${col.id}`} className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{t("rss.settings")}</h3>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingId(editingId === col.id ? null : col.id)}
                >
                  <Pencil className="h-3 w-3" />
                  {editingId === col.id ? t("common:common.cancel") : t("common:common.edit")}
                </Button>
              </div>

              {editingId === col.id && (
                <CollectionForm
                  botId={botId!}
                  collection={col}
                  onSaved={() => {
                    setEditingId(null);
                    refreshCollection(col.id);
                    fetchCollections();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              )}

              <FeedList
                botId={botId!}
                collectionId={col.id}
                feeds={col.feeds ?? []}
                onChanged={() => refreshCollection(col.id)}
              />

              {(itemsMap[col.id]?.items.length ?? 0) > 0 && (
                <ItemList
                  botId={botId!}
                  collectionId={col.id}
                  items={itemsMap[col.id]!.items}
                  total={itemsMap[col.id]!.total}
                  busy={busy}
                  onAction={doAction}
                  onRefresh={() => refreshCollection(col.id)}
                />
              )}
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  );
}
