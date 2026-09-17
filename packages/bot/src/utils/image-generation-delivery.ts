import {
  resolveImageGenerationReceiptConfig,
  type ImageGenerationReceiptConfig,
  type ImageGenerationRequestSnapshot,
} from "@cos-tool-bot/shared";
import { escapeHtml } from "./format.js";

export const TELEGRAM_MEDIA_CAPTION_LIMIT = 1024;

export interface ImageGenerationCaptionInput {
  prompt: string;
  imageCount: number;
  presetKey?: string;
  requestSnapshot?: ImageGenerationRequestSnapshot;
  receiptConfig?: ImageGenerationReceiptConfig;
  truncationNoticeUrl?: string;
}

export interface FormattedImageGenerationCaption {
  html: string;
  plainTextLength: number;
  truncated: boolean;
}

export function formatImageGenerationCaption(
  input: ImageGenerationCaptionInput,
): FormattedImageGenerationCaption {
  const receiptConfig = resolveImageGenerationReceiptConfig(input.receiptConfig);
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
  if (
    prompt.length <= receiptConfig.promptPreviewLength &&
    fullPlainLength <= TELEGRAM_MEDIA_CAPTION_LIMIT
  ) {
    return {
      html: `<b>${escapeHtml(header)}</b>\n\n<blockquote expandable>${escapeHtml(prompt)}</blockquote>`,
      plainTextLength: fullPlainLength,
      truncated: false,
    };
  }

  const notice = receiptConfig.truncationNoticeEnabled ? receiptConfig.truncationNoticeText : "";
  const promptDecorationsLength = receiptConfig.promptPreviewLength > 0 ? 3 : 0;
  const noticeLength = notice ? 2 + notice.length : 0;
  const promptBudget = Math.max(
    0,
    TELEGRAM_MEDIA_CAPTION_LIMIT - header.length - promptDecorationsLength - noticeLength,
  );
  const excerpt = takeUtf16(prompt, Math.min(receiptConfig.promptPreviewLength, promptBudget));
  const htmlParts = [`<b>${escapeHtml(header)}</b>`];
  let plainTextLength = header.length;
  if (excerpt) {
    htmlParts.push(`<blockquote expandable>${escapeHtml(excerpt)}…</blockquote>`);
    plainTextLength += 2 + excerpt.length + 1;
  }
  if (notice) {
    const noticeHtml = escapeHtml(notice);
    htmlParts.push(
      input.truncationNoticeUrl
        ? `<a href="${escapeHtml(input.truncationNoticeUrl)}">${noticeHtml}</a>`
        : noticeHtml,
    );
    plainTextLength += 2 + notice.length;
  }
  return {
    html: htmlParts.join("\n\n"),
    plainTextLength,
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
