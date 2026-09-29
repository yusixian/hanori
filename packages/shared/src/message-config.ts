export type ReplyMode = "stream" | "segment";

export interface MessageConfig {
  replyMode?: ReplyMode; // "stream" = streaming draft, "segment" = multi_message tool
  richMessageEnabled?: boolean; // Telegram native Rich Messages, defaults to true
  autoSplitThreshold: number; // 0 = disabled, >0 = auto-split when text exceeds this character count
  splitDelayMs: number; // delay between split segments (ms), shows typing status
}

export const DEFAULT_MESSAGE_CONFIG: MessageConfig = {
  replyMode: "segment", // segment mode: multi_message tool + auto-split
  richMessageEnabled: true,
  autoSplitThreshold: 0, // disabled by default
  splitDelayMs: 800,
};

export function isStreamReplyMode(config?: MessageConfig): boolean {
  return (config?.replyMode ?? DEFAULT_MESSAGE_CONFIG.replyMode) === "stream";
}

export function isRichMessageEnabled(config?: MessageConfig): boolean {
  return config?.richMessageEnabled ?? DEFAULT_MESSAGE_CONFIG.richMessageEnabled ?? true;
}
