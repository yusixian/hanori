export interface ImageGenerationReceiptConfig {
  /** Maximum UTF-16 units of the Prompt shown in a Telegram image caption. */
  promptPreviewLength?: number;
  truncationNoticeEnabled?: boolean;
  truncationNoticeText?: string;
  albumNoticeEnabled?: boolean;
  albumNoticeText?: string;
}

export const IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH = 800;
export const IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH = 200;

export const DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG: Required<ImageGenerationReceiptConfig> = {
  promptPreviewLength: 200,
  truncationNoticeEnabled: true,
  truncationNoticeText: "⚠️ Prompt 已截断，完整内容见任务详情。",
  albumNoticeEnabled: true,
  albumNoticeText: "🔎 完整 Prompt、生成参数与任务进度",
};

export function resolveImageGenerationReceiptConfig(
  config?: ImageGenerationReceiptConfig,
): Required<ImageGenerationReceiptConfig> {
  const previewLength = config?.promptPreviewLength;
  return {
    promptPreviewLength:
      Number.isInteger(previewLength) && previewLength !== undefined
        ? Math.min(Math.max(previewLength, 0), IMAGE_GENERATION_PROMPT_PREVIEW_MAX_LENGTH)
        : DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.promptPreviewLength,
    truncationNoticeEnabled:
      config?.truncationNoticeEnabled ??
      DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.truncationNoticeEnabled,
    truncationNoticeText: normalizeImageGenerationReceiptText(
      config?.truncationNoticeText,
      DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.truncationNoticeText,
    ),
    albumNoticeEnabled:
      config?.albumNoticeEnabled ?? DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.albumNoticeEnabled,
    albumNoticeText: normalizeImageGenerationReceiptText(
      config?.albumNoticeText,
      DEFAULT_IMAGE_GENERATION_RECEIPT_CONFIG.albumNoticeText,
    ),
  };
}

function normalizeImageGenerationReceiptText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/[\r\n]+/g, " ") || fallback;
  let result = "";
  for (const character of normalized) {
    if (result.length + character.length > IMAGE_GENERATION_RECEIPT_TEXT_MAX_LENGTH) break;
    result += character;
  }
  return result;
}
