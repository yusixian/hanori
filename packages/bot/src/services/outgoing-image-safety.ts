import { Readable } from "node:stream";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_NSFW_THRESHOLD } from "@cos-tool-bot/shared";
import { InputFile, type Api, type Transformer } from "grammy";
import sharp from "sharp";
import { coverRichHtmlImages, coverRichMarkdownImages } from "../utils/rich-image-safety.js";
import {
  MAX_NSFW_IMAGE_BYTES,
  needsImageSpoiler,
  NsfwChecker,
  type NsfwLogger,
} from "./nsfw-checker.js";

type Media = {
  type: string;
  media: string | InputFile;
  has_spoiler?: boolean;
  [key: string]: unknown;
};
const MAX_DOCUMENT_BYTES = 50_000_000;

function looksLikeImage(bytes: Uint8Array): boolean {
  const header = Buffer.from(bytes);
  const hex = header.subarray(0, 4).toString("hex");
  return (
    hex.startsWith("ffd8ff") ||
    hex === "89504e47" ||
    hex === "47494638" ||
    hex.startsWith("424d") ||
    hex === "49492a00" ||
    hex === "4d4d002a" ||
    (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") ||
    header.toString("ascii", 4, 8) === "ftyp" ||
    /<svg[\s>]/i.test(header.toString("utf8"))
  );
}

export function createOutgoingImageSafety(options: {
  api: Api;
  token: string;
  checker?: NsfwChecker;
  threshold?: number;
  logger?: NsfwLogger;
}): Transformer {
  const { api, token, checker, logger } = options;
  const threshold = options.threshold ?? DEFAULT_NSFW_THRESHOLD;
  const downloader = checker ?? new NsfwChecker({ apiUrl: "" });

  async function readSource(source: string | InputFile, signal?: AbortSignal): Promise<Uint8Array> {
    if (typeof source === "string") {
      if (/^https?:\/\//i.test(source)) return downloader.readImageUrl(source, signal);
      const file = await api.raw.getFile(
        { file_id: source },
        signal as unknown as Parameters<Api["raw"]["getFile"]>[1],
      );
      if (!file.file_path || (file.file_size ?? 0) > MAX_NSFW_IMAGE_BYTES)
        throw new Error("Telegram image is unavailable or too large");
      return downloader.readImageUrl(
        `https://api.telegram.org/file/bot${token}/${file.file_path}`,
        signal,
      );
    }
    // grammY 1.x exposes toRaw; streams are one-shot, so always rebuild InputFile from bytes.
    const raw = await source.toRaw();
    if (raw instanceof Uint8Array) {
      if (raw.byteLength > MAX_NSFW_IMAGE_BYTES) throw new Error("Image exceeds NSFW size limit");
      return raw;
    }
    const stream = Readable.from(raw);
    const abort = () => stream.destroy(new Error("Image read aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.byteLength;
        if (size > MAX_NSFW_IMAGE_BYTES) throw new Error("Image exceeds NSFW size limit");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } finally {
      signal?.removeEventListener("abort", abort);
      stream.destroy();
    }
  }

  async function protectPhoto(media: Media, signal?: AbortSignal): Promise<void> {
    if (media.has_spoiler) return;
    media.has_spoiler = true;
    if (!checker) return;
    try {
      const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
      const bytes = await readSource(media.media, deadline);
      media.media = new InputFile(
        bytes,
        media.media instanceof InputFile ? media.media.filename : "image.jpg",
      );
      media.has_spoiler = needsImageSpoiler(
        await checker.checkImageBytes(bytes, signal),
        threshold,
      );
    } catch {
      signal?.throwIfAborted();
      // A consumed stream cannot be sent safely. URLs and file ids can still be sent covered.
      if (media.media instanceof InputFile)
        throw new Error("Could not read image for NSFW detection");
      logger?.("warn", "Outgoing image could not be checked; applying spoiler");
    }
  }

  async function checkDocument(
    media: Media,
    temporaryDirectories: string[],
    signal?: AbortSignal,
    requireImage = false,
  ): Promise<void> {
    const source = media.media;
    let filename = source instanceof InputFile ? source.filename : undefined;
    const download = new AbortController();
    const cancel = () => download.abort();
    const timeout = setTimeout(cancel, 10_000);
    timeout.unref();
    if (signal?.aborted) cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    const deadline = download.signal;
    let raw: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
    try {
      if (source instanceof InputFile) raw = await source.toRaw();
      else {
        let url = source;
        if (!/^https?:\/\//i.test(source)) {
          const file = await api.raw.getFile(
            { file_id: source },
            deadline as unknown as Parameters<Api["raw"]["getFile"]>[1],
          );
          if (!file.file_path) throw new Error("Document is unavailable for NSFW detection");
          filename = file.file_path.split("/").at(-1);
          url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        } else filename = new URL(source).pathname.split("/").at(-1);
        const response = await downloader.openImageUrl(url, deadline);
        raw = Readable.fromWeb(
          response.body! as import("node:stream/web").ReadableStream<Uint8Array>,
        );
      }
    } catch (error) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      throw error;
    }
    const stream = Readable.from(raw instanceof Uint8Array ? [raw] : raw);
    const iterator = stream[Symbol.asyncIterator]();
    const abort = () => stream.destroy(new Error("Document read aborted"));
    deadline.addEventListener("abort", abort, { once: true });
    try {
      deadline.throwIfAborted();
      const chunks: Uint8Array[] = [];
      let size = 0;
      // Inspect content, not filename; ordinary documents use Telegram's larger limit.
      while (size < 512) {
        const { done, value } = await iterator.next();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      const prefix = Buffer.concat(
        chunks.map((chunk) => chunk.subarray(0, 512)),
        Math.min(size, 512),
      );
      const imageHeader = looksLikeImage(prefix);
      const knownImage = /\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?|svg)$/i.test(filename ?? "");
      if (!imageHeader && !knownImage && !requireImage) {
        // Keep the exact inspected bytes replayable across Telegram rate-limit retries.
        // Disk staging bounds memory and avoids fetching different URL content on retry.
        clearTimeout(timeout);
        if (size > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds Telegram size limit");
        if (raw instanceof Uint8Array) {
          media.media = new InputFile(raw, filename);
          return;
        }
        const directory = await mkdtemp(path.join(tmpdir(), "hanori-outgoing-document-"));
        temporaryDirectories.push(directory);
        const filePath = path.join(directory, "document");
        const file = await open(filePath, "wx", 0o600);
        try {
          for (const chunk of chunks) await file.writeFile(chunk);
          for (;;) {
            const { done, value } = await iterator.next();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds Telegram size limit");
            await file.writeFile(value);
          }
          deadline.throwIfAborted();
        } finally {
          await file.close();
        }
        media.media = new InputFile(filePath, filename ?? "document");
        return;
      }
      if (size > MAX_NSFW_IMAGE_BYTES) throw new Error("Image document exceeds NSFW size limit");
      for (;;) {
        const { done, value } = await iterator.next();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_NSFW_IMAGE_BYTES) throw new Error("Image document exceeds NSFW size limit");
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks, size);
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if ((metadata.pages ?? 1) > 1)
        throw new Error("Animated image documents and stickers must use a covered photo");
      media.media = new InputFile(bytes, filename ?? `image.${metadata.format ?? "jpg"}`);
      if (!checker || needsImageSpoiler(await checker.checkImageBytes(bytes, signal), threshold)) {
        throw new Error(
          "NSFW or unverified image documents and stickers must be sent using send_photo with a spoiler",
        );
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      deadline.removeEventListener("abort", abort);
      stream.destroy();
    }
  }

  async function protectRich(value: unknown, signal?: AbortSignal): Promise<void> {
    if (!value || typeof value !== "object" || value instanceof InputFile) return;
    if (Array.isArray(value)) {
      for (const item of value) await protectRich(item, signal);
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.markdown === "string") node.markdown = coverRichMarkdownImages(node.markdown);
    if (typeof node.html === "string") node.html = coverRichHtmlImages(node.html);
    if (node.type === "photo" && node.media) await protectPhoto(node as Media, signal);
    for (const child of Object.values(node)) await protectRich(child, signal);
  }

  return async (prev, method, payload, signal) => {
    // grammY's node transport types use a legacy AbortSignal. Bridge it to native fetch.
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const nativeSignal = cancellation.signal;
    const temporaryDirectories: string[] = [];
    try {
      const body = payload as Record<string, unknown>;
      if (method === "sendPhoto") {
        const media: Media = {
          type: "photo",
          media: body.photo as string | InputFile,
          has_spoiler: body.has_spoiler as boolean | undefined,
        };
        await protectPhoto(media, nativeSignal);
        body.photo = media.media;
        body.has_spoiler = media.has_spoiler;
      } else if (method === "sendDocument") {
        const media: Media = { type: "document", media: body.document as string | InputFile };
        await checkDocument(media, temporaryDirectories, nativeSignal);
        body.document = media.media;
      } else if (method === "sendSticker") {
        const media: Media = { type: "document", media: body.sticker as string | InputFile };
        // Stickers also have no spoiler field; never send an unsafe image as a sticker.
        await checkDocument(media, temporaryDirectories, nativeSignal, true);
        body.sticker = media.media;
      } else if (method === "sendMediaGroup") {
        for (const media of body.media as Media[]) {
          if (media.type === "photo") await protectPhoto(media, nativeSignal);
          else if (media.type === "document")
            await checkDocument(media, temporaryDirectories, nativeSignal);
        }
      } else if (method === "editMessageMedia") {
        const media = body.media as Media;
        if (media.type === "photo") await protectPhoto(media, nativeSignal);
        else if (media.type === "document")
          await checkDocument(media, temporaryDirectories, nativeSignal);
      }
      if (body.rich_message) await protectRich(body.rich_message, nativeSignal);
      if (method === "sendMessage" || method === "editMessageText") {
        // Telegram fetches previews itself; these images cannot be classified before display.
        body.link_preview_options = { is_disabled: true };
      }
      nativeSignal.throwIfAborted();
      return await prev(method, payload, signal);
    } finally {
      cancellation.abort();
      signal?.removeEventListener("abort", abort);
      const cleanups = await Promise.allSettled(
        temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
      if (cleanups.some((result) => result.status === "rejected"))
        logger?.("warn", "Outgoing document temporary file cleanup failed");
    }
  };
}
