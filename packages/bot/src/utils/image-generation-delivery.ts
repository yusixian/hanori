import type { ImageGenerationRequestSnapshot } from "@cos-tool-bot/shared";

export const TELEGRAM_MEDIA_CAPTION_LIMIT = 1024;

export interface ImageGenerationCaptionInput {
  prompt: string;
  imageCount: number;
  presetKey?: string;
  requestSnapshot?: ImageGenerationRequestSnapshot;
}

export interface FormattedImageGenerationCaption {
  html: string;
  plainTextLength: number;
  truncated: boolean;
}

const TRUNCATION_NOTICE =
  "⚠️ Prompt 过长，当前内容已截断。点击下方「查看任务详情」查看并复制完整 Prompt。";

export function formatImageGenerationCaption(
  input: ImageGenerationCaptionInput,
): FormattedImageGenerationCaption {
  const headerParts = [`🎨 生成完成 · ${input.imageCount} 张`];
  const width = input.requestSnapshot?.width;
  const height = input.requestSnapshot?.height;
  if (width && height) headerParts.push(`${width}×${height}`);
  if (input.presetKey) {
    const presetKey = input.presetKey.trim();
    headerParts.push(presetKey.length > 80 ? `${takeUtf16(presetKey, 79)}…` : presetKey);
  }
  const header = headerParts.join(" · ");
  const prompt = input.prompt.trim();
  const fullPlainLength = header.length + 2 + prompt.length;
  if (fullPlainLength <= TELEGRAM_MEDIA_CAPTION_LIMIT) {
    return {
      html: `<b>${escapeTelegramHtml(header)}</b>\n\n<blockquote expandable>${escapeTelegramHtml(prompt)}</blockquote>`,
      plainTextLength: fullPlainLength,
      truncated: false,
    };
  }

  const fixedLength = header.length + 2 + 1 + 2 + TRUNCATION_NOTICE.length;
  const promptBudget = Math.max(0, TELEGRAM_MEDIA_CAPTION_LIMIT - fixedLength);
  const excerpt = takeUtf16(prompt, promptBudget);
  return {
    html: `<b>${escapeTelegramHtml(header)}</b>\n\n<blockquote expandable>${escapeTelegramHtml(excerpt)}…</blockquote>\n\n${escapeTelegramHtml(TRUNCATION_NOTICE)}`,
    plainTextLength: header.length + 2 + excerpt.length + 1 + 2 + TRUNCATION_NOTICE.length,
    truncated: true,
  };
}

function takeUtf16(value: string, maxUnits: number): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > maxUnits) break;
    result += character;
  }
  return result;
}

function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
