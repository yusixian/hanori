export interface ImageOcrConfig {
  enabled: boolean;
  providerId?: string;
  modelId?: string;
  systemPrompt?: string;
  maxImagesPerMessage?: number;
  cooldownSeconds?: number;
  maxDescriptionLength?: number;
  timeoutMs?: number;
  /** Maximum size of each Telegram image forwarded to the main model. */
  maxInputImageBytes?: number;
}

export const DEFAULT_MAX_MODEL_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

export const DEFAULT_OCR_PROMPT = `你在为一个中文聊天机器人描述用户发来的图片，帮它理解后续对话。请用中文输出一段 2-4 句的自然描述，覆盖以下要素（有则描述，没有的略过，不要编造）：

1. 主体：人物（性别 / 年龄感 / 表情 / 动作 / 服装）、动物、物品，或画面主要内容；
2. 场景：地点 / 背景 / 时间 / 氛围；
3. 文字：如有明显文字（截图、表情包文字、标语、UI 文案等），原样转述关键短句；
4. 类型 / 风格：照片、二次元插画、表情包、meme、截图、漫画、手绘、AI 生成等；
5. 情绪或用意（如能合理推断）：搞笑 / 吐槽 / 炫耀 / 求助 / 晒图等，口吻中性，避免武断。

约束：
- 只描述画面中真实存在的内容，不要推测画面外信息；
- 不要输出 "这张图片 / 图中显示" 之类冗余开场，直接描述；
- 不要使用 markdown、列表或换行，输出一段紧凑的自然语言；
- 总长度控制在 150 字以内。`;
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 3;
export const DEFAULT_OCR_COOLDOWN_SECONDS = 0;
export const DEFAULT_OCR_MAX_DESCRIPTION_LENGTH = 400;
export const DEFAULT_OCR_TIMEOUT_MS = 600_000;
