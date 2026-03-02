import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import type {
  ArtworkImage,
  ArtworkInfo,
  ArtworkProvider,
  ArtworkProviderConfig,
} from "../types.js";

// FxTwitter API response types (internal)

interface FxTwitterResponse {
  code: number;
  message: string;
  tweet?: {
    id: string;
    text: string;
    url: string;
    author: {
      id: string;
      name: string;
      screen_name: string;
      avatar_url: string;
    };
    media?: {
      photos?: Array<{
        url: string;
        width: number;
        height: number;
      }>;
    };
    possibly_sensitive?: boolean;
  };
}

const TWITTER_URL_PATTERN = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/;

export class TwitterProvider implements ArtworkProvider {
  name = "twitter";

  match(url: string): string | null {
    const m = url.match(TWITTER_URL_PATTERN);
    return m ? m[1]! : null;
  }

  async fetch(postId: string, config: ArtworkProviderConfig): Promise<ArtworkInfo> {
    const fetchTimeout = config.timeoutConfig?.fetchPageMs ?? DEFAULT_TIMEOUT_CONFIG.fetchPageMs;
    const res = await fetch(`https://api.fxtwitter.com/placeholder/status/${postId}`, {
      headers: {
        "User-Agent": "CosToolBot/1.0",
      },
      signal: AbortSignal.timeout(fetchTimeout),
    });

    if (!res.ok) throw new Error(`FxTwitter API error: HTTP ${res.status}`);

    const data = (await res.json()) as FxTwitterResponse;
    if (data.code !== 200 || !data.tweet) {
      throw new Error(`FxTwitter API error: ${data.message}`);
    }

    const tweet = data.tweet;
    const photos = tweet.media?.photos ?? [];

    const images: ArtworkImage[] = photos.map((photo) => ({
      thumbnailUrl: `${photo.url}?name=medium`,
      originalUrl: `${photo.url}?name=orig`,
      width: photo.width,
      height: photo.height,
    }));

    return {
      platform: "twitter",
      postUrl: tweet.url,
      postId,
      title: undefined,
      description: tweet.text?.slice(0, 500),
      author: {
        name: tweet.author.name,
        id: tweet.author.id,
        username: tweet.author.screen_name,
        profileUrl: `https://x.com/${tweet.author.screen_name}`,
      },
      images,
      tags: [],
      isNSFW: tweet.possibly_sensitive ?? false,
    };
  }

  getImageHeaders(): null {
    return null;
  }
}
