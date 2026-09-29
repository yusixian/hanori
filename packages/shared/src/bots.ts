import type { EmailForwardConfigPublic } from "./lark.js";

export type CommandEntity = {
  name: string;
  args: string[];
  original_msg: string;
};

export type BotPlatform = "telegram" | "lark-webhook";

export type BotStatus = "running" | "stopped" | "restarting";
export type TelegramRichMessageFormat = "markdown" | "html";

export interface TelegramRichMessageReceipt {
  messageId: number;
  chatId: number;
  format: TelegramRichMessageFormat;
}

export interface TelegramRichMessageSender {
  sendRichMessage(
    chatId: number,
    format: TelegramRichMessageFormat,
    content: string,
  ): Promise<TelegramRichMessageReceipt>;
}

export interface IBotManager {
  readonly botId: string;
  readonly status: BotStatus;
  readonly uptime: number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendHtml(chatId: number, html: string): Promise<void>;
}

/** Relay destination for the `/cosinside` private-chat channel. Aliases are the only
 *  target selector the command accepts; raw chat IDs never reach the Telegram side. */
export interface CosInsideTarget {
  alias: string;
  chatId: number;
}

export interface CosInsideConfig {
  targets: CosInsideTarget[];
}

export interface BotRecord {
  id: string;
  name: string;
  platform: BotPlatform;
  tokenMasked: string;
  adminChatIds: number[];
  isActive: boolean;
  miniAppEnabled: boolean;
  aiEnabled: boolean;
  aiHasApiKey: boolean;
  createdAt: string;
  updatedAt: string | null;
  larkWebhookConfig?: { webhookUrl: string; hasSignSecret: boolean };
  emailForwardConfig?: EmailForwardConfigPublic;
  cosInsideConfig?: CosInsideConfig;
}

export interface BotWithStatus extends BotRecord {
  status: BotStatus;
  uptime: number | null;
}
