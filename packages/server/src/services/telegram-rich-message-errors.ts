export class BotNotRunningError extends Error {
  constructor(botId: string) {
    super(`Bot ${botId} is not running`);
    this.name = "BotNotRunningError";
  }
}

export class TelegramRichMessagesUnsupportedError extends Error {
  constructor(botId: string) {
    super(`Bot ${botId} does not support Telegram Rich Messages`);
    this.name = "TelegramRichMessagesUnsupportedError";
  }
}
