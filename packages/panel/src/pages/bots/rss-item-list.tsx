import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import type { RssItemRecord } from "@cos-tool-bot/shared";
import { BookMarked, BookOpen, ExternalLink, Loader2, MailOpen } from "lucide-react";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

export function ItemList({
  botId,
  collectionId,
  items,
  total,
  busy,
  onAction,
  onRefresh,
}: {
  botId: string;
  collectionId: number;
  items: RssItemRecord[];
  total: number;
  busy: string | null;
  onAction: (key: string, fn: () => Promise<void>) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const hasDigested = items.some((i) => i.digestedAt);
  const hasUndigested = items.some((i) => !i.digestedAt);

  const markAll = () =>
    onAction(`mark-all-${collectionId}`, async () => {
      await client.api.bots[":botId"].rss.collections[":id"]["mark-digest"].$post({
        param: { botId, id: String(collectionId) },
      });
      await onRefresh();
    });

  const unmarkAll = () =>
    onAction(`unmark-all-${collectionId}`, async () => {
      await client.api.bots[":botId"].rss.collections[":id"]["unmark-digest"].$post({
        param: { botId, id: String(collectionId) },
      });
      await onRefresh();
    });

  const unmarkItem = (itemId: number) =>
    onAction(`unmark-${itemId}`, async () => {
      await client.api.bots[":botId"].rss.collections[":id"]["unmark-items"].$post({
        param: { botId, id: String(collectionId) },
        json: { itemIds: [itemId] },
      });
      await onRefresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Recent Items ({total} total)</h3>
        <div className="flex gap-2">
          {hasUndigested && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={markAll}
              title="Mark all as read"
            >
              {busy === `mark-all-${collectionId}` ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <BookMarked className="h-3 w-3" />
              )}
              Mark All Read
            </Button>
          )}
          {hasDigested && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={unmarkAll}
              title="Mark all as unread"
            >
              {busy === `unmark-all-${collectionId}` ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <BookOpen className="h-3 w-3" />
              )}
              Mark All Unread
            </Button>
          )}
        </div>
      </div>
      <div className="divide-y rounded border">
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between px-3 py-2">
            <div className="min-w-0 flex-1">
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm font-medium hover:underline"
              >
                {item.title}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              {item.summary && (
                <p className="text-muted-foreground truncate text-xs">{item.summary}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {item.digestedAt && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto px-1.5 py-0.5"
                  disabled={busy !== null}
                  onClick={() => unmarkItem(item.id)}
                  title="Mark as unread"
                >
                  <MailOpen className="h-3 w-3" />
                  <Badge variant="muted" className="text-[10px]">
                    digested
                  </Badge>
                </Button>
              )}
              <span className="text-muted-foreground text-xs whitespace-nowrap">
                {item.publishedAt ? fmtDate(item.publishedAt) : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
