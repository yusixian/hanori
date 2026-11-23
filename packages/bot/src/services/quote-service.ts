import {
  QUOTE_COLORS,
  UserPrivacyBusyError,
  normalizeQuoteColor,
  type QuoteRenderInput,
  type QuoteRenderResult,
  type QuoteRenderMessage,
  type QuoteRenderAsset,
  type QuoteSource,
  type QuoteSourceStoreCallbacks,
  type UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import { Api, InputFile } from "grammy";
import sharp from "sharp";
import { isQuoteSourceAllowed, quoteSourceExcerpt } from "../utils/quote-source.js";
import { readBoundedImage } from "../utils/read-bounded-image.js";
import { createOutgoingImageSafety } from "./outgoing-image-safety.js";

export interface QuoteDependencies {
  store: QuoteSourceStoreCallbacks;
  renderer: {
    available(): Promise<boolean>;
    render(input: QuoteRenderInput, signal?: AbortSignal): Promise<QuoteRenderResult>;
  };
}
export class QuoteError extends Error {
  constructor(
    message: string,
    readonly english = "The quote could not be created.",
  ) {
    super(message);
  }
}
export interface QuoteRequest {
  chatId: number;
  threadId: number | null;
  userId: number;
  messageIds?: readonly number[];
  anchorId?: number;
  count?: number;
  liveSources?: readonly QuoteSource[];
  snapshotOnly?: boolean;
  quoteText?: string;
  includeReplyPreview?: boolean;
  color?: string;
  replyToMessageId?: number;
  signal?: AbortSignal;
  locale?: "en" | "zh";
}
interface QuoteServiceOptions {
  api: Api;
  privacy?: UserPrivacyCallbacks;
  getBufferedSources?: (
    chatId: number,
    threadId: number | null,
  ) => readonly QuoteSource[] | Promise<readonly QuoteSource[]>;
  /** Separate non-retrying transport, injectable for tests. */
  deliveryApi?: Api;
  safety?: Omit<Parameters<typeof createOutgoingImageSafety>[0], "api" | "token">;
  fetchImpl?: typeof fetch;
}

function preview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let output = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text,
  )) {
    if (output.length + segment.length > limit - 1) break;
    output += segment;
  }
  return output + "…";
}

/** All callers share source validation, asset limits and a non-retrying delivery. */
export class QuoteService {
  private readonly delivery: Api;
  private readonly shutdown = new AbortController();
  private readonly avatars = new Map<number, { at: number; asset: QuoteRenderAsset }>();
  constructor(
    readonly deps: QuoteDependencies,
    private readonly options: QuoteServiceOptions,
  ) {
    this.delivery = options.deliveryApi ?? new Api(options.api.token, options.api.options);
    if (!options.deliveryApi && options.safety)
      this.delivery.config.use(
        createOutgoingImageSafety({
          ...options.safety,
          api: this.delivery,
          token: options.api.token,
        }),
      );
  }
  available() {
    return this.deps.renderer.available().catch(() => false);
  }
  close() {
    this.shutdown.abort();
    this.avatars.clear();
  }
  async send(input: QuoteRequest) {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(30_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const telegramSignal = signal as unknown as Parameters<Api["getChat"]>[1];
    signal.throwIfAborted();
    if (!(await this.available()))
      throw new QuoteError("语录渲染服务暂不可用。", "The quote renderer is unavailable.");
    if ((await this.options.privacy?.getMode(input.userId)) === "off")
      throw new QuoteError(
        "隐私 off 模式不能生成语录。",
        "Quotes are disabled in privacy off mode.",
      );
    const chat = await this.options.api.getChat(input.chatId, telegramSignal);
    if (chat.has_protected_content)
      throw new QuoteError(
        "受保护聊天中的消息不能制作语录。",
        "Protected chat content cannot be quoted.",
      );
    const live = [
      ...(input.snapshotOnly
        ? []
        : ((await this.options.getBufferedSources?.(input.chatId, input.threadId)) ?? [])),
      ...(input.liveSources ?? []),
    ].filter((source) => source.threadId === input.threadId);
    const requestedCount = input.messageIds?.length ?? Math.abs(input.count ?? 1);
    if (requestedCount < 1 || requestedCount > 10 || !Number.isInteger(requestedCount))
      throw new QuoteError("每次只能引用 1–10 条消息。");
    const query = input.messageIds
      ? { ids: input.messageIds }
      : {
          anchorId: input.anchorId!,
          direction: (input.count ?? 1) < 0 ? ("backward" as const) : ("forward" as const),
          limit: requestedCount,
        };
    if (!input.messageIds && (!input.anchorId || !Number.isInteger(input.anchorId)))
      throw new QuoteError("请回复要引用的消息。");
    const liveIds = new Set(live.map((source) => source.messageId));
    const liveOnly = input.messageIds
      ? input.messageIds.every((id) => liveIds.has(id))
      : requestedCount === 1 && liveIds.has(input.anchorId!);
    const stored =
      input.snapshotOnly || liveOnly
        ? []
        : await this.deps.store.getQuoteSources(input.chatId, input.threadId, query);
    const byId = new Map([...stored, ...live].map((source) => [source.messageId, source]));
    let sources: QuoteSource[];
    if (input.messageIds) {
      if (new Set(input.messageIds).size !== requestedCount)
        throw new QuoteError("消息 ID 不能重复。");
      sources = input.messageIds.map((id) => byId.get(id)).filter((s): s is QuoteSource => !!s);
      if (sources.length !== requestedCount)
        throw new QuoteError(
          "部分消息没有可用的真实语录来源。",
          "Some messages have no available quote source.",
        );
    } else {
      const backward = (input.count ?? 1) < 0;
      sources = [...byId.values()].filter((source) =>
        backward ? source.messageId <= input.anchorId! : source.messageId >= input.anchorId!,
      );
      sources.sort((a, b) => (backward ? b.messageId - a.messageId : a.messageId - b.messageId));
      sources = sources.slice(0, requestedCount);
      if (!sources.some((source) => source.messageId === input.anchorId))
        throw new QuoteError("被回复消息不可引用。", "The replied message cannot be quoted.");
    }
    sources.sort((a, b) => a.messageId - b.messageId);
    if (input.includeReplyPreview && !input.snapshotOnly) {
      const missing = sources.filter((source) => !source.replyToMessageId);
      const targets = missing.length
        ? await this.deps.store.getQuoteReplyTargets?.(
            input.chatId,
            input.threadId,
            missing.map((source) => source.messageId),
          )
        : undefined;
      sources = sources.map((source) => {
        const parent =
          source.replyToMessageId ??
          live.find(
            (candidate) => candidate.messageId === source.messageId && candidate.replyToMessageId,
          )?.replyToMessageId ??
          targets?.[source.messageId];
        return parent ? { ...source, replyToMessageId: parent } : source;
      });
    }
    const parentIds = [
      ...new Set(sources.flatMap((s) => (s.replyToMessageId ? [s.replyToMessageId] : []))),
    ];
    const parents =
      !input.snapshotOnly && input.includeReplyPreview && parentIds.length
        ? await this.deps.store.getQuoteSources(input.chatId, input.threadId, { ids: parentIds })
        : [];
    const parentMap = new Map([...parents, ...live].map((s) => [s.messageId, s]));
    const ids = [
      ...new Set([
        input.userId,
        ...sources.flatMap((s) => s.privacyUserIds),
        ...[...parentMap.values()]
          .filter((s) => parentIds.includes(s.messageId))
          .flatMap((s) => s.privacyUserIds),
      ]),
    ].sort((a, b) => a - b);
    const operation = async () => {
      if ((await this.options.privacy?.getMode(input.userId)) === "off")
        throw new QuoteError("隐私 off 模式不能生成语录。");
      for (const source of sources) {
        if (
          !(await isQuoteSourceAllowed(source, this.options.privacy)) ||
          (await this.deps.store.isQuoteOutput(input.chatId, source.messageId))
        )
          throw new QuoteError(
            "消息受隐私或保护限制，或已经是生成的语录。",
            "A source is private, protected, or already a generated quote.",
          );
      }
      if (input.quoteText !== undefined) {
        if (sources.length !== 1) throw new QuoteError("选段只支持单条消息。");
        try {
          sources = [quoteSourceExcerpt(sources[0]!, input.quoteText)];
        } catch {
          throw new QuoteError(
            "选段不是原文中的有效片段。",
            "The quote must be an exact excerpt of the original message.",
          );
        }
      }
      let background =
        input.color === undefined
          ? await this.deps.store.getQuoteColor(input.chatId)
          : normalizeQuoteColor(input.color);
      if (input.color !== undefined && !background)
        throw new QuoteError("配色必须为预设名称或 #RRGGBB。", "Choose a preset or #RRGGBB color.");
      background ??= QUOTE_COLORS.dark;
      let assetBytes = 0;
      const asset = async (fileId: string, avatar = false) => {
        const file = await this.options.api.getFile(fileId, telegramSignal);
        const limit = avatar ? 1024 * 1024 : 8 * 1024 * 1024;
        if (!file.file_path || (file.file_size ?? 0) > limit)
          throw new QuoteError("图片不可用或文件过大。", "An image is unavailable or too large.");
        const segments = file.file_path.split("/");
        if (segments.some((part) => !part || part === "." || part === ".."))
          throw new QuoteError("图片路径无效。");
        const url = `https://api.telegram.org/file/bot${this.options.api.token}/${segments.map(encodeURIComponent).join("/")}`;
        const response = await (this.options.fetchImpl ?? fetch)(url, {
          signal,
          redirect: "error",
        });
        const bytes = await readBoundedImage(response, limit, "Quote image too large");
        assetBytes += bytes.length;
        if (assetBytes > 24 * 1024 * 1024) throw new QuoteError("引用图片总大小超过 24 MiB。");
        const normalized = await sharp(bytes, { limitInputPixels: 16_000_000, animated: false })
          .rotate()
          .resize(avatar ? 128 : 1024, avatar ? 128 : 1024, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
        signal.throwIfAborted();
        return { base64: normalized.toString("base64"), mimeType: "image/png" as const };
      };
      const messages: QuoteRenderMessage[] = [];
      let previewUnavailable =
        !!input.includeReplyPreview && sources.some((source) => !source.replyToMessageId);
      for (const source of sources) {
        signal.throwIfAborted();
        const message: QuoteRenderMessage = {
          author: { key: source.author.key, name: preview(source.author.name, 256) },
          text: source.text,
          entities: source.entities,
        };
        if (source.media) message.media = await asset(source.media.fileId);
        const userId = source.author.userId;
        if (userId !== undefined) {
          const cached = this.avatars.get(userId);
          if (cached && Date.now() - cached.at < 5 * 60_000) {
            this.avatars.delete(userId);
            this.avatars.set(userId, cached);
            message.author.avatar = cached.asset;
          } else {
            this.avatars.delete(userId);
            try {
              const photos = await this.options.api.getUserProfilePhotos(
                userId,
                { limit: 1 },
                telegramSignal,
              );
              const photo = photos.photos[0]?.[0];
              if (photo) {
                message.author.avatar = await asset(photo.file_id, true);
                if (this.avatars.size >= 64) this.avatars.delete(this.avatars.keys().next().value!);
                this.avatars.set(userId, { at: Date.now(), asset: message.author.avatar });
              }
            } catch {
              signal.throwIfAborted(); /* Missing avatars use the renderer's colored fallback. */
            }
          }
        }
        if (input.includeReplyPreview && source.replyToMessageId) {
          const parent = parentMap.get(source.replyToMessageId);
          if (
            parent &&
            parent.threadId === input.threadId &&
            (await isQuoteSourceAllowed(parent, this.options.privacy)) &&
            !(await this.deps.store.isQuoteOutput(input.chatId, parent.messageId))
          )
            message.reply = {
              author: preview(parent.author.name, 256),
              text: preview(parent.text, 180),
            };
          else previewUnavailable = true;
        }
        messages.push(message);
      }
      const output = await this.deps.renderer.render({ background, messages }, signal);
      signal.throwIfAborted();
      if ((await this.options.privacy?.getMode(input.userId)) === "off")
        throw new QuoteError("隐私 off 模式不能生成语录。");
      for (const source of sources)
        if (!(await isQuoteSourceAllowed(source, this.options.privacy)))
          throw new QuoteError("消息隐私设置已改变，请重新操作。");
      await this.delivery.sendChatAction(
        input.chatId,
        output.format === "webp" ? "choose_sticker" : "upload_document",
        { message_thread_id: input.threadId ?? undefined },
        telegramSignal,
      );
      signal.throwIfAborted();
      const common = {
        message_thread_id: input.threadId ?? undefined,
        reply_parameters: input.replyToMessageId
          ? { message_id: input.replyToMessageId }
          : undefined,
      };
      const notice =
        [
          sources.length < requestedCount
            ? input.locale === "en"
              ? `Only ${sources.length}/${requestedCount} quotable local messages were available.`
              : `仅找到 ${sources.length}/${requestedCount} 条可引用的本地消息。`
            : undefined,
          previewUnavailable
            ? input.locale === "en"
              ? "Some parent previews could not be read: a message may have no parent, its reply relationship may not be saved, or the parent may be unavailable."
              : "部分消息未找到可用父预览：可能没有父回复、未保存回复关系，或父消息不可读取。"
            : undefined,
        ]
          .filter(Boolean)
          .join("\n") || undefined;
      const sent =
        output.format === "webp"
          ? await this.delivery.sendSticker(
              input.chatId,
              new InputFile(output.data, "quote.webp"),
              common,
              telegramSignal,
            )
          : await this.delivery.sendDocument(
              input.chatId,
              new InputFile(output.data, "quote.png"),
              {
                ...common,
                caption: [
                  input.locale === "en"
                    ? "Sent as a PNG document to keep long text readable."
                    : "内容较长，已发送 PNG 文件以保持可读性。",
                  notice,
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
              telegramSignal,
            );
      let receiptSaved = true;
      try {
        await this.deps.store.markQuoteOutput(input.chatId, sent.message_id);
      } catch {
        receiptSaved = false;
      }
      return {
        messageId: sent.message_id,
        format: output.format,
        count: sources.length,
        requestedCount,
        notice: output.format === "webp" ? notice : undefined,
        receiptSaved,
      };
    };
    const privacy = this.options.privacy;
    if (privacy?.runExclusiveMany) {
      try {
        return await privacy.runExclusiveMany(ids, operation, { waitIfBusy: false });
      } catch (error) {
        if (error instanceof UserPrivacyBusyError)
          throw new QuoteError(
            "引用作者正在处理其他请求，请稍后重试；尚未发送语录。",
            "A quote author is busy. Please try later; no quote was sent.",
          );
        throw error;
      }
    }
    if (privacy)
      throw new QuoteError("语录隐私锁暂不可用。", "Quote privacy protection is unavailable.");
    return operation();
  }
}
