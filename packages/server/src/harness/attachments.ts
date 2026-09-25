import { createHmac, timingSafeEqual } from "node:crypto";
import type { HarnessAttachment, HarnessTelegram } from "@cos-tool-bot/bot";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_PATH = "/api/harness/attachments/";
const SIGNATURE_BYTES = 16;
const CACHE_ENTRIES = 16;
const MAX_FILE_ID = 256;

export interface AttachmentImage {
  bytes: Buffer;
  mimeType: string;
}

export function attachmentKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("dev-harness:attachments").digest();
}

function signature(key: Buffer, fileId: string): Buffer {
  return createHmac("sha256", key).update(fileId).digest().subarray(0, SIGNATURE_BYTES);
}

/** `<file id>.<mac>`, both base64url: the token names one Telegram file and cannot be forged. */
export function attachmentToken(key: Buffer, fileId: string): string {
  const id = Buffer.from(fileId, "utf8").toString("base64url");
  return `${id}.${signature(key, fileId).toString("base64url")}`;
}

export function verifyAttachmentToken(key: Buffer, token: string): string | null {
  const [id, mac, extra] = token.split(".");
  if (!id || !mac || extra !== undefined) return null;
  const fileId = Buffer.from(id, "base64url").toString("utf8");
  const canonical = Buffer.from(fileId, "utf8").toString("base64url") === id;
  if (!fileId || fileId.length > MAX_FILE_ID || !canonical) return null;
  const given = Buffer.from(mac, "base64url");
  return given.length === SIGNATURE_BYTES && timingSafeEqual(given, signature(key, fileId))
    ? fileId
    : null;
}

export function detectImageMime(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function isImageAttachment(attachment: HarnessAttachment): boolean {
  return attachment.kind === "photo" || Boolean(attachment.mimeType?.startsWith("image/"));
}

/**
 * Serves `/bug` screenshots from Telegram behind signed links, so GitHub can render them in the
 * issue and the agent can download them, without the Bot token or a copy in any repository.
 */
export class HarnessAttachments {
  private readonly cache = new Map<string, AttachmentImage>();

  constructor(
    private readonly key: Buffer | null,
    private readonly baseUrl: string | null,
    private readonly telegram: () => HarnessTelegram | null,
  ) {}

  urlFor(fileId: string): string | null {
    if (!this.key || !this.baseUrl) return null;
    return new URL(attachmentToken(this.key, fileId), this.baseUrl).toString();
  }

  /** Null for a bad token, a missing file, or anything that is not an image. */
  async read(token: string): Promise<AttachmentImage | null> {
    if (!this.key) return null;
    const fileId = verifyAttachmentToken(this.key, token);
    const telegram = this.telegram();
    if (!fileId || !telegram) return null;
    const cached = this.cache.get(fileId);
    if (cached) return cached;
    const bytes = await telegram.downloadFile(fileId, MAX_ATTACHMENT_BYTES);
    const mimeType = bytes ? detectImageMime(bytes) : null;
    if (!bytes || !mimeType) return null;
    const image = { bytes, mimeType };
    this.cache.set(fileId, image);
    if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return image;
  }
}

export function createAttachments(
  secret: string | undefined,
  publicUrl: string | undefined,
  telegram: () => HarnessTelegram | null,
): HarnessAttachments {
  const baseUrl = URL.canParse(ATTACHMENT_PATH, publicUrl)
    ? new URL(ATTACHMENT_PATH, publicUrl).toString()
    : null;
  return new HarnessAttachments(secret ? attachmentKey(secret) : null, baseUrl, telegram);
}
