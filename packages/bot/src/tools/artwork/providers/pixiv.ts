import type {
  ArtworkImage,
  ArtworkInfo,
  ArtworkProvider,
  ArtworkProviderConfig,
} from "../types.js";

// Pixiv AJAX API response types (internal)

interface PixivIllustResponse {
  error: boolean;
  message: string;
  body: {
    illustId: string;
    illustTitle: string;
    illustComment: string;
    userId: string;
    userName: string;
    xRestrict: number; // 0=SFW, 1=R18, 2=R18G
    aiType: number; // 0=not AI, 1=assisted, 2=AI generated
    tags: {
      tags: Array<{
        tag: string;
        translation?: Record<string, string>;
      }>;
    };
    width: number;
    height: number;
    urls: {
      thumb?: string;
      small?: string;
      regular?: string;
      original?: string;
    };
  };
}

interface PixivPagesResponse {
  error: boolean;
  body: Array<{
    urls: {
      thumb_mini: string;
      small: string;
      regular: string;
      original: string;
    };
    width: number;
    height: number;
  }>;
}

const PIXIV_URL_PATTERN = /pixiv\.net\/(?:en\/)?(?:artworks|i)\/(\d+)/;

export class PixivProvider implements ArtworkProvider {
  name = "pixiv";

  match(url: string): string | null {
    const m = url.match(PIXIV_URL_PATTERN);
    return m ? m[1]! : null;
  }

  async fetch(postId: string, config: ArtworkProviderConfig): Promise<ArtworkInfo> {
    if (!config.pixivCookie) {
      throw new Error(
        "Pixiv cookie is not configured. Please set the Pixiv Cookie in bot settings.",
      );
    }

    const headers: Record<string, string> = {
      Referer: "https://www.pixiv.net/",
      Cookie: config.pixivCookie,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };

    // Fetch illust info + pages in parallel
    const [illustRes, pagesRes] = await Promise.all([
      fetch(`https://www.pixiv.net/ajax/illust/${postId}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(`https://www.pixiv.net/ajax/illust/${postId}/pages`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    ]);

    if (!illustRes.ok) throw new Error(`Pixiv API error: HTTP ${illustRes.status}`);
    if (!pagesRes.ok) throw new Error(`Pixiv pages API error: HTTP ${pagesRes.status}`);

    const illustData = (await illustRes.json()) as PixivIllustResponse;
    const pagesData = (await pagesRes.json()) as PixivPagesResponse;

    if (illustData.error) throw new Error(`Pixiv API error: ${illustData.message}`);

    const body = illustData.body;

    // Process tags: prefer Chinese translation, then English, then original
    const tags = body.tags.tags.map((t) => {
      if (t.translation?.zh) return t.translation.zh;
      if (t.translation?.zh_tw) return t.translation.zh_tw;
      if (t.translation?.en) return t.translation.en;
      return t.tag;
    });

    // Build images from pages
    const images: ArtworkImage[] = pagesData.body.map((page) => ({
      thumbnailUrl: page.urls.regular,
      originalUrl: page.urls.original,
      width: page.width,
      height: page.height,
    }));

    return {
      platform: "pixiv",
      postUrl: `https://www.pixiv.net/artworks/${postId}`,
      postId,
      title: body.illustTitle,
      description: body.illustComment
        ? body.illustComment.replace(/<[^>]+>/g, "").slice(0, 500)
        : undefined,
      author: {
        name: body.userName,
        id: body.userId,
        profileUrl: `https://www.pixiv.net/users/${body.userId}`,
      },
      images,
      tags,
      isNSFW: body.xRestrict > 0,
      isAI: body.aiType >= 2,
    };
  }

  getImageHeaders(): Record<string, string> {
    return { Referer: "https://www.pixiv.net/" };
  }
}
