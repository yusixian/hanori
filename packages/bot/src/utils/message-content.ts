import type { Message, MessageEntity, PollMedia, RichBlock, RichText } from "grammy/types";

// Order matters for Telegram's compatibility fields (animation/document and venue/location).
const CONTENT_KINDS = [
  "text",
  "rich_message",
  "animation",
  "live_photo",
  "photo",
  "video",
  "audio",
  "voice",
  "video_note",
  "document",
  "sticker",
  "story",
  "paid_media",
  "poll",
  "contact",
  "venue",
  "location",
  "dice",
  "game",
  "checklist",
] as const satisfies readonly (keyof Message)[];

export function telegramContentKind(message: Message): (typeof CONTENT_KINDS)[number] | "other" {
  return CONTENT_KINDS.find((kind) => message[kind] != null) ?? "other";
}

function textWithLinks(text: string | undefined, entities?: MessageEntity[]): string {
  if (!text) return "";
  const links =
    entities?.flatMap((entity) =>
      entity.type === "text_link" && !text.includes(entity.url) ? [entity.url] : [],
    ) ?? [];
  return [text, ...new Set(links)].join("\n");
}

function richText(text: RichText | undefined): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map(richText).join("");
  if (text.type === "custom_emoji") return text.alternative_text;
  if (text.type === "mathematical_expression") return text.expression;
  if (text.type === "anchor") return "";
  const value = richText(text.text);
  return text.type === "url" && value !== text.url ? `${value} (${text.url})` : value;
}

function richBlocks(blocks: RichBlock[], mode: "all" | "media" | "text" = "all"): string {
  const mediaOnly = mode === "media";
  return blocks
    .map((block) => {
      let body = "";
      if ("text" in block && !mediaOnly) body = richText(block.text);
      else if ("blocks" in block) body = richBlocks(block.blocks, mode);
      else if (block.type === "list")
        body = block.items
          .map((item) => `${mediaOnly ? "" : item.label} ${richBlocks(item.blocks, mode)}`.trim())
          .join("\n");
      else if (block.type === "table" && !mediaOnly)
        body = block.cells
          .map((row) => row.map((cell) => richText(cell.text)).join(" | "))
          .join("\n");
      else if (block.type === "mathematical_expression" && !mediaOnly) body = block.expression;
      else if (block.type === "map" && mode !== "text")
        body = `[位置：${block.location.latitude}, ${block.location.longitude}]`;
      else if (
        mode !== "text" &&
        ["photo", "video", "animation", "audio", "voice_note"].includes(block.type)
      )
        body = `[富文本附件 ${block.type}：未解析媒体内容]`;
      if (block.type === "details" && !mediaOnly) body = `${richText(block.summary)}\n${body}`;
      if ("credit" in block && !mediaOnly)
        body = [body, richText(block.credit)].filter(Boolean).join("\n");
      if ("caption" in block && block.caption && !mediaOnly) {
        const caption =
          block.type === "table"
            ? richText(block.caption)
            : [richText(block.caption.text), richText(block.caption.credit)]
                .filter(Boolean)
                .join("\n");
        body = [body, caption].filter(Boolean).join("\n");
      }
      return body;
    })
    .filter(Boolean)
    .join("\n");
}

/** User-visible text for trigger decisions; generated metadata must never trigger a reply. */
export function additionalMessageText(msg: Message): string {
  if (msg.rich_message) return richBlocks(msg.rich_message.blocks, "text");
  if (msg.poll)
    return [
      msg.poll.question,
      msg.poll.description,
      ...msg.poll.options.map((option) => option.text),
      msg.poll.explanation,
    ]
      .filter(Boolean)
      .join("\n");
  if (msg.checklist)
    return [msg.checklist.title, ...msg.checklist.tasks.map((task) => task.text)].join("\n");
  if (msg.game)
    return [msg.game.title, msg.game.description, msg.game.text].filter(Boolean).join("\n");
  return "";
}

function pollMedia(media: PollMedia | undefined): string {
  if (!media) return "";
  if (media.link) return `[投票链接：${media.link.url}]`;
  if (media.venue)
    return `[投票地点：${media.venue.title}；${media.venue.address}；${media.venue.location.latitude}, ${media.venue.location.longitude}]`;
  if (media.location) return `[投票位置：${media.location.latitude}, ${media.location.longitude}]`;
  return "[投票附件：未解析媒体内容]";
}

/** Text and metadata only; no media download, payment, transcription or live-location tracking. */
export function describeAdditionalMessageContent(
  msg: Message | undefined,
  selectedQuote = false,
): string {
  if (!msg) return "";
  if (msg.live_photo) return "[实况照片：动态部分未解析，静态照片沿用图片处理]";
  const media = msg.animation
    ? "动图"
    : msg.video
      ? "视频"
      : msg.audio
        ? "音频"
        : msg.voice
          ? "语音"
          : msg.video_note
            ? "视频笔记"
            : undefined;
  if (media) return `[${media}：未解析媒体内容，请勿声称已观看或收听]`;
  if (msg.story) {
    const chat = msg.story.chat;
    const source =
      "title" in chat ? chat.title : [chat.first_name, chat.last_name].filter(Boolean).join(" ");
    return `[Story：来源 ${source}${"username" in chat && chat.username ? ` (@${chat.username})` : ""}，chat_id=${chat.id}，story_id=${msg.story.id}；未解析 Story 内容]`;
  }
  if (msg.paid_media)
    return `[付费媒体：${msg.paid_media.paid_media.length} 项，${msg.paid_media.star_count} Stars；未购买或解析媒体内容]`;
  if (msg.rich_message)
    return `[富文本消息]\n${richBlocks(msg.rich_message.blocks, selectedQuote ? "media" : "all")}`.trim();
  if (msg.poll) {
    if (selectedQuote) return "[投票]";
    const poll = msg.poll;
    return [
      `[投票：${poll.is_closed ? "已结束" : "进行中"}，收到时共 ${poll.total_voter_count} 票]`,
      textWithLinks(poll.question, poll.question_entities),
      textWithLinks(poll.description, poll.description_entities),
      ...poll.options.map(
        (option, index) =>
          `${index + 1}. ${textWithLinks(option.text, option.text_entities)}（收到时票数字段：${option.voter_count}，0 也可能表示未知）${pollMedia(option.media)}`,
      ),
      textWithLinks(poll.explanation, poll.explanation_entities),
      pollMedia(poll.media),
      pollMedia(poll.explanation_media),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (msg.contact)
    return selectedQuote
      ? "[联系人]"
      : `[联系人：${[msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ")}，电话 ${msg.contact.phone_number}]`;
  if (msg.venue)
    return selectedQuote
      ? "[地点]"
      : `[地点：${msg.venue.title}；${msg.venue.address}；${msg.venue.location.latitude}, ${msg.venue.location.longitude}]`;
  if (msg.location)
    return `[${msg.location.live_period ? "实时位置（收到时快照，未持续追踪）" : "位置"}：${msg.location.latitude}, ${msg.location.longitude}]`;
  if (msg.dice) return `[骰子：${msg.dice.emoji}，结果 ${msg.dice.value}]`;
  if (msg.game)
    return selectedQuote
      ? "[游戏]"
      : `[游戏：${msg.game.title}]\n${msg.game.description}\n${textWithLinks(msg.game.text, msg.game.text_entities)}\n[游戏附件：未解析媒体内容]`;
  if (msg.checklist)
    return selectedQuote
      ? "[清单]"
      : `[清单：${textWithLinks(msg.checklist.title, msg.checklist.title_entities)}]\n${msg.checklist.tasks.map((task) => `${task.completion_date ? "[x]" : "[ ]"} ${textWithLinks(task.text, task.text_entities)}`).join("\n")}`;
  return "";
}
