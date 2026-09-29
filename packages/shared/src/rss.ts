export interface RssCollectionRecord {
  id: number;
  botId: string;
  chatId: number;
  name: string;
  description: string | null;
  digestPrompt: string | null;
  isActive: boolean;
  digestHour: number;
  digestMinute: number;
  maxDigestItems: number | null;
  lastDigestAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface RssFeedRecord {
  id: number;
  collectionId: number;
  feedUrl: string;
  title: string;
  maxDigestItems: number | null;
  lastFetchAt: string | null;
  createdAt: string;
}

export interface RssItemRecord {
  id: number;
  feedId: number;
  guid: string;
  title: string;
  link: string;
  summary: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  digestedAt: string | null;
}
