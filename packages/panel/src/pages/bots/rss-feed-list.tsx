import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import type { RssFeedRecord } from "@cos-tool-bot/shared";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString();
}

export function FeedList({
  botId,
  collectionId,
  feeds,
  onChanged,
}: {
  botId: string;
  collectionId: number;
  feeds: RssFeedRecord[];
  onChanged: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [feedUrl, setFeedUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  const addFeed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedUrl) return;
    setAdding(true);
    setError(null);
    try {
      await client.api.bots[":botId"].rss.collections[":id"].feeds.$post({
        param: { botId, id: String(collectionId) },
        json: { feedUrl },
      });
      setFeedUrl("");
      setShowAdd(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add feed");
    } finally {
      setAdding(false);
    }
  };

  const removeFeed = async (feedId: number) => {
    if (confirmRemove !== feedId) {
      setConfirmRemove(feedId);
      setTimeout(() => setConfirmRemove(null), 3000);
      return;
    }
    setConfirmRemove(null);
    try {
      await client.api.bots[":botId"].rss.collections[":id"].feeds[":feedId"].$delete({
        param: { botId, id: String(collectionId), feedId: String(feedId) },
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove feed");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Feeds ({feeds.length})</h3>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          {showAdd ? "Cancel" : "Add Feed"}
        </Button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {showAdd && (
        <form onSubmit={addFeed} className="flex gap-2">
          <Input
            placeholder="RSS/Atom feed URL"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            className="flex-1"
            required
          />
          <Button type="submit" size="sm" disabled={adding}>
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
          </Button>
        </form>
      )}

      {feeds.length > 0 && (
        <div className="divide-y rounded border">
          {feeds.map((feed) => (
            <div key={feed.id} className="flex items-center justify-between px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{feed.title}</p>
                <p className="text-muted-foreground truncate text-xs">{feed.feedUrl}</p>
              </div>
              <div className="flex items-center gap-2">
                {feed.lastFetchAt && (
                  <span className="text-muted-foreground text-xs">
                    {fmtDateTime(feed.lastFetchAt)}
                  </span>
                )}
                <Button
                  size="sm"
                  variant={confirmRemove === feed.id ? "destructive" : "ghost"}
                  onClick={() => removeFeed(feed.id)}
                  title={confirmRemove === feed.id ? "Click again to confirm" : "Remove"}
                >
                  <Trash2
                    className={`h-3 w-3 ${confirmRemove === feed.id ? "" : "text-red-500"}`}
                  />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
