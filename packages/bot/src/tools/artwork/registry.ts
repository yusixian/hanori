import type { ArtworkProvider } from "./types.js";
import { PixivProvider } from "./providers/pixiv.js";
import { TwitterProvider } from "./providers/twitter.js";

const providers: ArtworkProvider[] = [new PixivProvider(), new TwitterProvider()];

/** Match URL to a provider and extract postId */
export function matchProvider(url: string): { provider: ArtworkProvider; postId: string } | null {
  for (const p of providers) {
    const postId = p.match(url);
    if (postId) return { provider: p, postId };
  }
  return null;
}

/** Get all registered platform names (for prompts) */
export function getSupportedPlatforms(): string[] {
  return providers.map((p) => p.name);
}
