/** Unified artwork info returned by all providers */
export interface ArtworkInfo {
  platform: string;
  postUrl: string;
  postId: string;
  title?: string;
  description?: string;
  author: {
    name: string;
    id: string;
    username?: string;
    profileUrl?: string;
  };
  images: ArtworkImage[];
  tags: string[];
  isNSFW: boolean;
  isAI?: boolean;
}

export interface ArtworkImage {
  thumbnailUrl: string;
  originalUrl: string;
  width: number;
  height: number;
}

/** Provider interface — each platform implements this */
export interface ArtworkProvider {
  name: string;
  /** Check if URL belongs to this platform, return postId or null */
  match(url: string): string | null;
  /** Fetch artwork info */
  fetch(postId: string, config: ArtworkProviderConfig): Promise<ArtworkInfo>;
  /** Extra headers needed for image fetching (e.g. Pixiv referer), null if Telegram can pull directly */
  getImageHeaders?(): Record<string, string> | null;
}

/** Config passed to providers from ArtworkToolsConfig */
export interface ArtworkProviderConfig {
  pixivCookie?: string;
}
