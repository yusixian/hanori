import { rssCollections, rssFeeds, rssItems } from "@cos-tool-bot/database";
import type { RssCollectionRecord, RssFeedRecord, RssItemRecord } from "@cos-tool-bot/shared";

export function mapCollectionRecord(row: typeof rssCollections.$inferSelect): RssCollectionRecord {
  return {
    id: row.id,
    botId: row.botId,
    chatId: row.chatId,
    name: row.name,
    description: row.description,
    digestPrompt: row.digestPrompt,
    isActive: row.isActive,
    digestHour: row.digestHour,
    digestMinute: row.digestMinute,
    lastDigestAt: row.lastDigestAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export function mapFeedRecord(row: typeof rssFeeds.$inferSelect): RssFeedRecord {
  return {
    id: row.id,
    collectionId: row.collectionId,
    feedUrl: row.feedUrl,
    title: row.title,
    lastFetchAt: row.lastFetchAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapItemRecord(row: typeof rssItems.$inferSelect): RssItemRecord {
  return {
    id: row.id,
    feedId: row.feedId,
    guid: row.guid,
    title: row.title,
    link: row.link,
    summary: row.summary,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    fetchedAt: row.fetchedAt.toISOString(),
    digestedAt: row.digestedAt?.toISOString() ?? null,
  };
}

interface DigestItem {
  title: string;
  link: string;
  summary: string | null;
  publishedAt: Date | null;
  feedTitle: string;
}

const DEFAULT_DIGEST_PROMPT = `请按以下要求生成摘要：
1. 对每条内容逐一展开，提炼核心要点（用列表形式），保留关键数据、人名、产品名
2. 每条摘要必须附上原文链接，格式：标题 + 链接 + 要点列表
3. 使用 multi_message 工具分段发送，每 2-3 条为一段，让阅读更自然
4. 第一段用简短的开场白引入，最后一段可以加简短的总结或点评
5. 将完整摘要保存到文件 rss/{{slug}}/{{date}}.md
6. 完成所有摘要后，调用 mark_rss_read 工具标记该合集已读`;

export function buildDigestEventDescription(
  collection: typeof rssCollections.$inferSelect,
  items: DigestItem[],
): string {
  const maxDisplay = 30;
  const displayed = items.slice(0, maxDisplay);
  const lines = displayed.map((item, i) => {
    const timeStr = item.publishedAt ? formatRelativeTime(item.publishedAt) : "unknown";
    return `${i + 1}. [${item.title}](${item.link})${item.summary ? `\n   ${item.summary.slice(0, 200)}` : ""}\n   来源：${item.feedTitle} | ${timeStr}`;
  });

  let desc = `RSS 合集「${collection.name}」有 ${items.length} 条新内容需要总结。\n`;
  if (collection.description) {
    desc += `总结要求：${collection.description}\n`;
  }
  desc += `\n以下是最新 ${Math.min(items.length, maxDisplay)} 条：\n${lines.join("\n")}`;
  if (items.length > maxDisplay) {
    desc += `\n\n（还有 ${items.length - maxDisplay} 条，可通过 check_rss 工具获取更多）`;
  }

  const slug = slugify(collection.name);
  const date = formatDate(new Date());
  const prompt = (collection.digestPrompt || DEFAULT_DIGEST_PROMPT)
    .replace(/\{\{slug\}\}/g, slug)
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{name\}\}/g, collection.name);
  desc += `\n\n${prompt}`;
  return desc;
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Safe under JS single-threaded model: `idx = i++` completes synchronously before `await`.
export async function pooledMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
