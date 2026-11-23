export const QUOTE_COLORS = {
  dark: "#16212C",
  light: "#F0F2F5",
  ai: "#251D3A",
  purple: "#251D3A",
  blue: "#172B4D",
} as const;

export function normalizeQuoteColor(value: string): string | undefined {
  const input = value.trim().toLowerCase();
  if (Object.hasOwn(QUOTE_COLORS, input)) return QUOTE_COLORS[input as keyof typeof QUOTE_COLORS];
  return /^#[a-f0-9]{6}$/.test(input) ? input.toUpperCase() : undefined;
}

export interface QuoteRenderEntity {
  type:
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "code"
    | "pre"
    | "blockquote"
    | "highlight"
    | "text_link"
    | "url";
  offset: number;
  length: number;
}

export interface QuoteRenderAsset {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}
export interface QuoteRenderMessage {
  author: { key: string; name: string; avatar?: QuoteRenderAsset };
  text: string;
  entities?: QuoteRenderEntity[];
  media?: QuoteRenderAsset;
  reply?: { author: string; text: string };
}
export interface QuoteRenderInput {
  background: string;
  messages: QuoteRenderMessage[];
}
export interface QuoteRenderResult {
  data: Uint8Array;
  format: "webp" | "png";
  width: number;
  height: number;
}

export interface QuoteSource {
  version: 1;
  messageId: number;
  threadId: number | null;
  capturedAt: number;
  text: string;
  entities: QuoteRenderEntity[];
  author: { key: string; name: string; userId?: number };
  privacyUserIds: number[];
  replyToMessageId?: number;
  media?: { kind: "photo" | "sticker"; fileId: string; width?: number; height?: number };
  protectedContent?: boolean;
}

const entityTypes = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "pre",
  "blockquote",
  "highlight",
  "text_link",
  "url",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const boundedText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;

/** Only versioned structured sources are quotable; legacy formatted history is not source data. */
export function parseQuoteSource(value: unknown): QuoteSource | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    !positiveId(value.messageId) ||
    (value.threadId !== null && !positiveId(value.threadId)) ||
    typeof value.capturedAt !== "number" ||
    !Number.isFinite(value.capturedAt) ||
    value.capturedAt < 0 ||
    !boundedText(value.text, 32768) ||
    !record(value.author) ||
    !boundedText(value.author.key, 512) ||
    !boundedText(value.author.name, 256) ||
    (value.author.userId !== undefined && !positiveId(value.author.userId)) ||
    !Array.isArray(value.privacyUserIds) ||
    value.privacyUserIds.length > 2 ||
    !value.privacyUserIds.every(positiveId) ||
    !Array.isArray(value.entities) ||
    value.entities.length > 1000
  )
    return undefined;
  const entities: QuoteRenderEntity[] = [];
  for (const entity of value.entities) {
    if (
      !record(entity) ||
      typeof entity.type !== "string" ||
      !entityTypes.has(entity.type) ||
      typeof entity.offset !== "number" ||
      !Number.isSafeInteger(entity.offset) ||
      entity.offset < 0 ||
      !positiveId(entity.length) ||
      entity.offset + entity.length > value.text.length
    )
      return undefined;
    entities.push({
      type: entity.type as QuoteRenderEntity["type"],
      offset: entity.offset,
      length: entity.length,
    });
  }
  if (value.replyToMessageId !== undefined && !positiveId(value.replyToMessageId)) return undefined;
  let media: QuoteSource["media"];
  if (value.media !== undefined) {
    const item = value.media;
    if (
      !record(item) ||
      (item.kind !== "photo" && item.kind !== "sticker") ||
      !boundedText(item.fileId, 2048) ||
      (item.width !== undefined && !positiveId(item.width)) ||
      (item.height !== undefined && !positiveId(item.height))
    )
      return undefined;
    media = {
      kind: item.kind,
      fileId: item.fileId,
      ...(item.width !== undefined ? { width: item.width as number } : {}),
      ...(item.height !== undefined ? { height: item.height as number } : {}),
    };
  }
  if (value.protectedContent !== undefined && typeof value.protectedContent !== "boolean")
    return undefined;
  return {
    version: 1,
    messageId: value.messageId,
    threadId: value.threadId as number | null,
    capturedAt: value.capturedAt,
    text: value.text,
    entities,
    author: {
      key: value.author.key,
      name: value.author.name,
      ...(value.author.userId !== undefined ? { userId: value.author.userId as number } : {}),
    },
    privacyUserIds: [...value.privacyUserIds] as number[],
    ...(value.replyToMessageId !== undefined
      ? { replyToMessageId: value.replyToMessageId as number }
      : {}),
    ...(media ? { media } : {}),
    ...(value.protectedContent !== undefined ? { protectedContent: value.protectedContent } : {}),
  };
}

export type QuoteSourceQuery =
  | { ids: readonly number[] }
  | { anchorId: number; direction: "forward" | "backward"; limit: number };

/** Bound to a single Bot; implementations must also scope every read to chat and topic. */
export interface QuoteSourceStoreCallbacks {
  getQuoteSources(
    chatId: number,
    threadId: number | null,
    query: QuoteSourceQuery,
  ): Promise<QuoteSource[]>;
  /** Recover relationships only; callers must separately authorize every parent source. */
  getQuoteReplyTargets?(
    chatId: number,
    threadId: number | null,
    messageIds: readonly number[],
  ): Promise<Record<number, number>>;
  isQuoteOutput(chatId: number, messageId: number): Promise<boolean>;
  markQuoteOutput(chatId: number, messageId: number): Promise<void>;
  getQuoteColor(chatId: number): Promise<string | undefined>;
  setQuoteColor(chatId: number, color: string | undefined): Promise<void>;
}
