import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Send,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { CollectionForm } from "./rss-collection-form";
import { FeedList } from "./rss-feed-list";
import { ItemList } from "./rss-item-list";

interface CollectionWithFeeds extends RssCollectionRecord {
  feeds?: RssFeedRecord[];
}

export function BotRssPage() {
  const { botId } = useParams<{ botId: string }>();
  const [collections, setCollections] = useState<CollectionWithFeeds[]>([]);
  const [loading, setLoading] = useState(true);
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
    try {
      const res = await client.api.bots[":botId"].rss.collections.$get({
        param: { botId },
      });
      const json = await res.json();
      if (json.ok) setCollections(json.data);
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
      showToast("error", err instanceof Error ? err.message : "Operation failed");
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
        showToast("success", `Fetched ${json.newItems} new items`);
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
        triggered ? "AI digest triggered" : "No new items to digest",
      );
    });
  };

  if (loading) return <p className="text-muted-foreground text-sm">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">RSS Collections</h1>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4" />
          New Collection
        </Button>
      </div>

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
          className={`text-sm ${toast.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}
        >
          {toast.message}
          <Button
            size="sm"
            variant="ghost"
            className="ml-2 h-auto p-0 underline"
            onClick={() => setToast(null)}
          >
            Dismiss
          </Button>
        </p>
      )}

      {collections.length === 0 && !showCreate && (
        <p className="text-muted-foreground text-sm">No RSS collections yet.</p>
      )}

      {collections.map((col) => (
        <Card key={col.id}>
          <CardHeader className="cursor-pointer" onClick={() => expandCollection(col.id)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {expandedId === col.id ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <CardTitle className="text-base">{col.name}</CardTitle>
                <Badge variant={col.isActive ? "default" : "muted"}>
                  {col.isActive ? "Active" : "Paused"}
                </Badge>
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Clock className="h-3 w-3" />
                  UTC {String(col.digestHour).padStart(2, "0")}:
                  {String(col.digestMinute).padStart(2, "0")}
                </span>
              </div>
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => toggleActive(col)}
                  title={col.isActive ? "Pause" : "Resume"}
                >
                  {col.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => pollCollection(col.id)}
                  title="Fetch now"
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
                  title="Trigger AI digest"
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
                  title={confirmDelete === col.id ? "Click again to confirm" : "Delete"}
                >
                  <Trash2 className={`h-4 w-4 ${confirmDelete === col.id ? "" : "text-red-500"}`} />
                </Button>
              </div>
            </div>
            {col.description && (
              <p className="text-muted-foreground mt-1 text-sm">{col.description}</p>
            )}
          </CardHeader>

          {expandedId === col.id && (
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Settings</h3>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingId(editingId === col.id ? null : col.id)}
                >
                  <Pencil className="h-3 w-3" />
                  {editingId === col.id ? "Cancel" : "Edit"}
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
