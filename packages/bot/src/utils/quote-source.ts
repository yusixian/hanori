import type { QuoteRenderEntity, QuoteSource, UserPrivacyCallbacks } from "@cos-tool-bot/shared";
import type { Message, MessageEntity, User } from "grammy/types";

const HIDDEN = "[剧透已隐藏]";
const STYLES = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "pre",
  "blockquote",
  "expandable_blockquote",
  "text_link",
  "url",
]);
type SourceReason =
  | "privacy"
  | "protected"
  | "unsupported"
  | "quote_output"
  | "command"
  | "invalid_excerpt"
  | "invalid_spoiler"
  | "scope";
export type QuoteSourceCapture = { source: QuoteSource } | { reason: SourceReason };
interface Excerpt {
  text: string;
  position?: number;
}

function boundary(text: string, offset: number): boolean {
  return (
    Number.isInteger(offset) &&
    offset >= 0 &&
    offset <= text.length &&
    !(
      offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[offset]!)
    )
  );
}
function excerptRange(text: string, excerpt?: Excerpt): [number, number] {
  if (!excerpt) return [0, text.length];
  const start = excerpt.position ?? text.indexOf(excerpt.text);
  const end = start + excerpt.text.length;
  const boundaries = new Set([
    0,
    text.length,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (part) => part.index,
    ),
  ]);
  if (
    !excerpt.text ||
    start < 0 ||
    text.slice(start, end) !== excerpt.text ||
    !boundaries.has(start) ||
    !boundaries.has(end)
  )
    throw new Error("invalid_excerpt");
  return [start, end];
}

/** Telegram and JavaScript both use UTF-16 offsets; only renderer transport gets sanitized text. */
export function normalizeQuoteText(
  text: string,
  entities: readonly MessageEntity[] = [],
  excerpt?: Excerpt,
): { text: string; entities: QuoteRenderEntity[] } {
  const [left, right] = excerptRange(text, excerpt);
  const valid = entities.filter((entity) => {
    const ok =
      entity.length > 0 &&
      boundary(text, entity.offset) &&
      boundary(text, entity.offset + entity.length);
    if (!ok && entity.type === "spoiler") throw new Error("invalid_spoiler");
    return ok;
  });
  const hidden: Array<[number, number]> = [];
  for (const entity of valid
    .filter((e) => e.type === "spoiler")
    .sort((a, b) => a.offset - b.offset)) {
    const a = Math.max(left, entity.offset),
      b = Math.min(right, entity.offset + entity.length);
    if (a >= b) continue;
    const previous = hidden.at(-1);
    if (previous && a <= previous[1]) previous[1] = Math.max(previous[1], b);
    else hidden.push([a, b]);
  }
  let output = "",
    cursor = left;
  const runs: Array<{ start: number; end: number; output: number }> = [];
  for (const [a, b] of [...hidden, [right, right] as [number, number]]) {
    if (cursor < a) {
      runs.push({ start: cursor, end: a, output: output.length });
      output += text.slice(cursor, a);
    }
    if (a < b) output += HIDDEN;
    cursor = b;
  }
  const styles: QuoteRenderEntity[] = [];
  for (const entity of valid) {
    if (!STYLES.has(entity.type)) continue;
    for (const run of runs) {
      const a = Math.max(run.start, entity.offset),
        b = Math.min(run.end, entity.offset + entity.length);
      if (a < b)
        styles.push({
          type: (entity.type === "expandable_blockquote"
            ? "blockquote"
            : entity.type) as QuoteRenderEntity["type"],
          offset: run.output + a - run.start,
          length: b - a,
        });
    }
  }
  return { text: output, entities: styles };
}

export function quoteSourceExcerpt(
  source: QuoteSource,
  text: string,
  position?: number,
): QuoteSource {
  const [start, end] = excerptRange(source.text, { text, position });
  return {
    ...source,
    text: source.text.slice(start, end),
    entities: source.entities.flatMap((entity) => {
      const a = Math.max(start, entity.offset),
        b = Math.min(end, entity.offset + entity.length);
      return a < b ? [{ ...entity, offset: a - start, length: b - a }] : [];
    }),
    media: undefined,
  };
}

export async function isQuoteSourceAllowed(
  source: QuoteSource,
  privacy?: UserPrivacyCallbacks,
): Promise<boolean> {
  if (source.protectedContent) return false;
  for (const id of source.privacyUserIds) {
    if (privacy && (await privacy.getMode(id)) === "off") return false;
    const memoryReset = privacy?.getContextResetAt?.(id);
    const persistedReset = await privacy?.getQuoteResetAt?.(id);
    const resetAt =
      memoryReset === undefined ? persistedReset : Math.max(memoryReset, persistedReset ?? 0);
    if (resetAt !== undefined && source.capturedAt <= resetAt) return false;
  }
  return true;
}

function displayName(user: Pick<User, "first_name" | "last_name">): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 256);
}

export async function captureQuoteSource(
  message: Message,
  options: {
    chatId: number;
    threadId: number | null;
    botUserId?: number;
    fallbackAuthor?: User;
    excerpt?: Excerpt;
    chatProtected?: boolean;
  },
  privacy?: UserPrivacyCallbacks,
): Promise<QuoteSourceCapture> {
  if (
    message.chat?.id !== options.chatId ||
    (message.is_topic_message ? (message.message_thread_id ?? null) : null) !== options.threadId
  )
    return { reason: "scope" };
  if (message.has_protected_content || options.chatProtected) return { reason: "protected" };
  const from = message.from ?? options.fallbackAuthor;
  const raw = message.text ?? message.caption ?? "";
  if (/^\/q(?:color)?(?:@\w+)?(?:\s|$)/i.test(raw)) return { reason: "command" };
  const privacyUserIds = from && !from.is_bot ? [from.id] : [];
  let author: QuoteSource["author"] | undefined = from
    ? { key: `user:${from.id}`, name: displayName(from), userId: from.id }
    : undefined;
  if (message.sender_chat)
    author = {
      key: `chat:${message.sender_chat.id}`,
      name: "title" in message.sender_chat ? (message.sender_chat.title ?? "匿名来源") : "匿名来源",
    };
  const origin = message.forward_origin;
  if (origin?.type === "user") {
    author = {
      key: `user:${origin.sender_user.id}`,
      name: displayName(origin.sender_user),
      userId: origin.sender_user.id,
    };
    if (!origin.sender_user.is_bot && !privacyUserIds.includes(origin.sender_user.id))
      privacyUserIds.push(origin.sender_user.id);
  } else if (origin?.type === "hidden_user") {
    author = { key: `hidden:${message.message_id}`, name: origin.sender_user_name.slice(0, 256) };
  } else if (origin?.type === "chat" || origin?.type === "channel") {
    const chat = origin.type === "chat" ? origin.sender_chat : origin.chat;
    author = {
      key: `chat:${chat.id}`,
      name: ("title" in chat ? (chat.title ?? "转发来源") : "转发来源").slice(0, 256),
    };
  }
  if (!author) return { reason: "unsupported" };
  for (const id of privacyUserIds)
    if (privacy && (await privacy.getMode(id)) === "off") return { reason: "privacy" };
  let content: ReturnType<typeof normalizeQuoteText>;
  try {
    content = normalizeQuoteText(
      raw,
      message.entities ?? message.caption_entities ?? [],
      options.excerpt,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "invalid_excerpt" || error.message === "invalid_spoiler")
    )
      return { reason: error.message };
    throw error;
  }
  let media: QuoteSource["media"];
  if (message.has_media_spoiler) content.text = [content.text, HIDDEN].filter(Boolean).join("\n");
  else if (!options.excerpt) {
    const photo = message.photo?.at(-1);
    if (photo)
      media = { kind: "photo", fileId: photo.file_id, width: photo.width, height: photo.height };
    else if (message.sticker && !message.sticker.is_animated && !message.sticker.is_video)
      media = {
        kind: "sticker",
        fileId: message.sticker.file_id,
        width: message.sticker.width,
        height: message.sticker.height,
      };
  }
  if (!content.text.trim() && !media) return { reason: "unsupported" };
  if (content.text.length > 32768) return { reason: "unsupported" };
  const dates = [message.date, message.forward_origin?.date].filter(
    (date): date is number => typeof date === "number" && Number.isFinite(date) && date > 0,
  );
  const capturedAt = dates.length ? Math.min(...dates) * 1000 : 0;
  const source: QuoteSource = {
    version: 1,
    messageId: message.message_id,
    threadId: options.threadId,
    capturedAt,
    ...content,
    author,
    privacyUserIds,
    ...(media ? { media } : {}),
    ...(message.reply_to_message ? { replyToMessageId: message.reply_to_message.message_id } : {}),
  };
  return (await isQuoteSourceAllowed(source, privacy)) ? { source } : { reason: "privacy" };
}

/** Production supplies a reentrant multi-user lock; stripped metadata never changes public history. */
export async function withQuoteSourcePrivacy<T>(
  source: QuoteSource | undefined,
  privacy: UserPrivacyCallbacks | undefined,
  operation: (allowed: QuoteSource | undefined) => Promise<T>,
): Promise<T> {
  const run = async () =>
    operation(source && (await isQuoteSourceAllowed(source, privacy)) ? source : undefined);
  return source && privacy?.runExclusiveMany
    ? privacy.runExclusiveMany(source.privacyUserIds, run)
    : run();
}
