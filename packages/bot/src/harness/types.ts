/** Callback data is `hx:<approval id>:<verb>`; the record, not the payload, carries authority. */
export const HARNESS_CALLBACK_PREFIX = "hx:";

export const HARNESS_COMMANDS = ["status", "quota", "harness", "bug"] as const;
export type HarnessCommandName = (typeof HARNESS_COMMANDS)[number];

export interface HarnessInlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export type HarnessKeyboard = HarnessInlineButton[][];

export interface HarnessOutgoingMessage {
  html: string;
  threadId?: number;
  keyboard?: HarnessKeyboard;
  /** Sent as a photo with the HTML as caption; falls back to text when Telegram rejects it. */
  photoUrl?: string;
  replyToMessageId?: number;
}

export type HarnessMessageKind = "text" | "photo";

export interface HarnessEditMessage {
  html: string;
  keyboard?: HarnessKeyboard;
  /** Replaces the photo of a photo card; ignored for text cards. */
  photoUrl?: string;
}

export type HarnessEditResult = "edited" | "unchanged" | "missing";

/** Outbound Telegram surface the server uses; keeps grammY out of the server package. */
export interface HarnessTelegram {
  send(
    chatId: number,
    message: HarnessOutgoingMessage,
  ): Promise<{ messageId: number; kind: HarnessMessageKind }>;
  edit(
    chatId: number,
    messageId: number,
    kind: HarnessMessageKind,
    message: HarnessEditMessage,
  ): Promise<HarnessEditResult>;
  sendDocument(
    chatId: number,
    document: { filename: string; content: string; caption?: string; threadId?: number },
  ): Promise<void>;
  createForumTopic(chatId: number, name: string): Promise<number>;
  setChatCommands(chatId: number): Promise<void>;
}

export interface HarnessAttachment {
  kind: "photo" | "document";
  fileId: string;
}

export interface HarnessCommandRequest {
  command: HarnessCommandName;
  args: string;
  chatId: number;
  /** Undefined in the General topic. */
  threadId?: number;
  userId: number;
  messageId: number;
  /** From the command message and the message it replies to. */
  attachments?: HarnessAttachment[];
}

/** An owner message replying to one of this Bot's messages in the harness chat. */
export interface HarnessReplyRequest {
  chatId: number;
  threadId?: number;
  userId: number;
  messageId: number;
  replyToMessageId: number;
  text: string;
}

export interface HarnessReply {
  /** Empty means the port already answered (for example by posting a card). */
  html: string;
  document?: { filename: string; content: string };
}

export interface HarnessCallbackRequest {
  data: string;
  chatId: number;
  threadId?: number;
  messageId: number;
  userId: number;
}

export interface HarnessCallbackAnswer {
  text?: string;
  alert?: boolean;
}

export interface HarnessBotPort {
  isHarnessChat(chatId: number): boolean;
  isOwner(userId: number): boolean;
  allowsCasualReplies(): boolean;
  usageHint(threadId: number | undefined): string;
  onBotReady(telegram: HarnessTelegram): void;
  handleCommand(request: HarnessCommandRequest): Promise<HarnessReply>;
  handleCallback(request: HarnessCallbackRequest): Promise<HarnessCallbackAnswer>;
  /** Returns null when the replied-to message is not a harness card or question. */
  handleReply(request: HarnessReplyRequest): Promise<HarnessReply | null>;
}
