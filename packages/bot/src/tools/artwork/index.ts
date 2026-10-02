import type { ArtworkToolsConfig, TimeoutConfig } from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { tool } from "ai";
import { InputFile } from "grammy";
import type { Api } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import { z } from "zod";
import type { OnceGuardContext } from "../utils.js";
import { wrapOnce, zodToAiSchema } from "../utils.js";
import { matchProvider, getSupportedPlatforms } from "./registry.js";
import type { ArtworkInfo } from "./types.js";

export { getSupportedPlatforms } from "./registry.js";

export interface ArtworkToolsOptions {
  api: Api;
  chatId: number;
  recentBotMessageIds: number[];
  config: ArtworkToolsConfig;
  onceGuard?: OnceGuardContext;
  timeoutConfig?: TimeoutConfig;
  unifiedSearchEnabled?: boolean;
}

export function createArtworkTools(options: ArtworkToolsOptions): Record<string, Tool> {
  const { api, chatId, recentBotMessageIds, config, onceGuard, timeoutConfig } = options;
  const imageDownloadMs = timeoutConfig?.imageDownloadMs ?? DEFAULT_TIMEOUT_CONFIG.imageDownloadMs;
  const artworkLookup =
    options.unifiedSearchEnabled === true
      ? "search(scope=artwork, query=作品URL)"
      : "fetch_artwork_info";

  // Cache last fetched artwork for send_artwork to look up provider headers
  let lastArtworkInfo: ArtworkInfo | undefined;

  const tools: Record<string, Tool> = {
    fetch_artwork_info: tool({
      description:
        "从 URL 获取作品信息（支持 Pixiv、Twitter/X）。自动识别平台并返回标题、作者、图片列表、标签等。这类作品链接用它而不是 fetch_webpage 或 web_search：它返回结构化信息和可直接交给 send_artwork 的图片。imageCount 为 0 表示该推文没有可发送的图片，改用文字描述。",
      inputSchema: zodToAiSchema(
        z.object({
          url: z.string().describe("作品 URL（如 pixiv.net/artworks/xxx 或 x.com/.../status/xxx）"),
        }),
      ),
      execute: async ({ url }) => {
        try {
          const match = matchProvider(url);
          if (!match) {
            return {
              error: `不支持的 URL。当前支持的平台: ${getSupportedPlatforms().join(", ")}`,
            };
          }

          const { provider, postId } = match;
          const info = await provider.fetch(postId, {
            pixivCookie: config.pixivCookie,
            timeoutConfig,
          });

          // Cache for send_artwork
          lastArtworkInfo = info;

          return {
            platform: info.platform,
            postUrl: info.postUrl,
            title: info.title,
            description: info.description,
            author: info.author,
            imageCount: info.images.length,
            images: info.images.map((img, i) => ({
              index: i,
              width: img.width,
              height: img.height,
            })),
            tags: info.tags,
            isNSFW: info.isNSFW,
            isAI: info.isAI,
          };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    send_artwork: tool({
      description: `发送作品图片。在调用 ${artworkLookup} 后使用。支持单图/多图发送，可设置 NSFW 遮罩。`,
      inputSchema: zodToAiSchema(
        z.object({
          caption: z.string().optional().describe("图片说明文字（支持 HTML 格式）"),
          image_indices: z
            .array(z.number())
            .optional()
            .describe("要发送的图片索引（默认全部），从 0 开始"),
          has_spoiler: z
            .boolean()
            .optional()
            .describe("是否添加剧透/NSFW 遮罩（对 NSFW 内容建议开启）"),
          use_original: z
            .boolean()
            .optional()
            .describe("是否发送原图（默认否，发送中等质量缩略图）"),
        }),
      ),
      execute: async ({ caption, image_indices, has_spoiler, use_original }) => {
        try {
          if (!lastArtworkInfo) {
            return { error: `请先调用 ${artworkLookup} 获取作品信息` };
          }

          const info = lastArtworkInfo;
          const match = matchProvider(info.postUrl);
          const headers = match?.provider.getImageHeaders?.() ?? null;

          // Select images by indices or all
          let selectedImages = info.images;
          if (image_indices && image_indices.length > 0) {
            selectedImages = image_indices
              .filter((i) => i >= 0 && i < info.images.length)
              .map((i) => info.images[i]!);
          }

          if (selectedImages.length === 0) {
            return { error: "没有可发送的图片" };
          }

          // Limit to 10 (Telegram media group max)
          if (selectedImages.length > 10) {
            selectedImages = selectedImages.slice(0, 10);
          }

          const spoiler = has_spoiler ?? false;

          // Helper: get image source (Buffer via fetch or URL string)
          const getImageSource = async (url: string) => {
            if (headers) {
              const res = await fetch(url, {
                headers: {
                  ...headers,
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
                signal: AbortSignal.timeout(imageDownloadMs),
              });
              if (!res.ok) throw new Error(`Failed to download image: HTTP ${res.status}`);
              const buffer = Buffer.from(await res.arrayBuffer());
              return new InputFile(buffer, "image.jpg");
            }
            return url;
          };

          if (selectedImages.length === 1) {
            const img = selectedImages[0]!;
            const url = use_original ? img.originalUrl : img.thumbnailUrl;
            const source = await getImageSource(url);
            const sent = await api.sendPhoto(chatId, source, {
              caption,
              parse_mode: "HTML",
              has_spoiler: spoiler,
            });
            recentBotMessageIds.push(sent.message_id);
            return { success: true, messageId: sent.message_id };
          }

          // Multiple images → media group
          const media: InputMediaPhoto[] = await Promise.all(
            selectedImages.map(async (img, i) => {
              const url = use_original ? img.originalUrl : img.thumbnailUrl;
              const source = await getImageSource(url);
              return {
                type: "photo" as const,
                media: source,
                caption: i === 0 ? caption : undefined,
                parse_mode: i === 0 && caption ? ("HTML" as const) : undefined,
                has_spoiler: spoiler,
              };
            }),
          );

          const sent = await api.sendMediaGroup(chatId, media);
          for (const msg of sent) {
            recentBotMessageIds.push(msg.message_id);
          }
          return { success: true, messageCount: sent.length };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),
  };

  // Wrap send_artwork with once guard
  if (onceGuard) {
    const t = tools.send_artwork;
    if (t && "execute" in t && typeof t.execute === "function") {
      t.execute = wrapOnce("send_artwork", onceGuard, t.execute);
    }
  }

  return tools;
}
