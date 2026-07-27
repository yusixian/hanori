export const TELEGRAM_COMMAND_LOCALES = ["zh-CN", "en"] as const;

export type TelegramCommandLocale = (typeof TELEGRAM_COMMAND_LOCALES)[number];
export type TelegramCommandCategory =
  | "general"
  | "conversation"
  | "ai"
  | "operations"
  | "privacy"
  | "media"
  | "integrations";
export type TelegramCommandAccess = "public" | "admin" | "contextual" | "configurable";
export type PublicHelpVisibility = "public" | "admin-overview" | "hidden";

export interface TelegramCommandMetadata {
  command: string;
  description: Record<TelegramCommandLocale, string>;
  category: TelegramCommandCategory;
  access: TelegramCommandAccess;
  capability: string;
  publicHelpVisibility: PublicHelpVisibility;
}

/**
 * Product metadata only. Runtime availability remains the bot's responsibility;
 * consumers must use the active command registry instead of assuming every item
 * in this catalog is enabled for every bot.
 */
export const TELEGRAM_COMMAND_CATALOG = [
  {
    command: "start",
    description: { "zh-CN": "显示欢迎信息", en: "Show the welcome message" },
    category: "general",
    access: "public",
    capability: "help.read",
    publicHelpVisibility: "public",
  },
  {
    command: "help",
    description: { "zh-CN": "显示当前可用命令", en: "Show currently available commands" },
    category: "general",
    access: "public",
    capability: "help.read",
    publicHelpVisibility: "public",
  },
  {
    command: "panel",
    description: {
      "zh-CN": "打开 Bot 帮助与管理面板（如已启用）",
      en: "Open Bot help and management panel when enabled",
    },
    category: "general",
    access: "public",
    capability: "help.read",
    publicHelpVisibility: "public",
  },
  {
    command: "md2tg",
    description: {
      "zh-CN": "将 Markdown 转为 Telegram 富文本",
      en: "Convert Markdown to Telegram rich text",
    },
    category: "general",
    access: "public",
    capability: "message.format",
    publicHelpVisibility: "public",
  },
  {
    command: "status",
    description: { "zh-CN": "查看 Bot 运行状态", en: "Show bot runtime status" },
    category: "operations",
    access: "admin",
    capability: "bot.status.read",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "restart",
    description: { "zh-CN": "重启 Bot", en: "Restart the bot" },
    category: "operations",
    access: "admin",
    capability: "bot.lifecycle.manage",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "backup",
    description: { "zh-CN": "创建数据库备份", en: "Create a database backup" },
    category: "operations",
    access: "admin",
    capability: "backup.create",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "stop",
    description: { "zh-CN": "停用 AI 回复并中断当前调用", en: "Stop AI replies and active calls" },
    category: "ai",
    access: "admin",
    capability: "bot.ai.toggle",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "resume",
    description: { "zh-CN": "恢复 AI 回复", en: "Resume AI replies" },
    category: "ai",
    access: "admin",
    capability: "bot.ai.toggle",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "apikey",
    description: {
      "zh-CN": "在私聊中更新 Web 工具 API Key",
      en: "Update a web tool API key in private chat",
    },
    category: "integrations",
    access: "admin",
    capability: "credentials.manage",
    publicHelpVisibility: "hidden",
  },
  {
    command: "mcp",
    description: { "zh-CN": "查看或管理 MCP 服务器", en: "View or manage MCP servers" },
    category: "integrations",
    access: "admin",
    capability: "mcp.manage",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "clear",
    description: { "zh-CN": "清除当前对话历史", en: "Clear the current conversation history" },
    category: "conversation",
    access: "contextual",
    capability: "conversation.clear",
    publicHelpVisibility: "public",
  },
  {
    command: "privacy",
    description: { "zh-CN": "查看或切换个人化模式", en: "View or change personalization mode" },
    category: "privacy",
    access: "public",
    capability: "privacy.self.manage",
    publicHelpVisibility: "public",
  },
  {
    command: "clearreceived",
    description: { "zh-CN": "清理收到的文件缓存", en: "Clear received file cache" },
    category: "operations",
    access: "admin",
    capability: "bot.files.clear",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "timers",
    description: { "zh-CN": "查看或管理活跃定时器", en: "View or manage active timers" },
    category: "operations",
    access: "admin",
    capability: "timer.manage",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "model",
    description: { "zh-CN": "查看或切换 AI 模型", en: "View or change the AI model" },
    category: "ai",
    access: "admin",
    capability: "chat.ai-selection.write",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "provider",
    description: { "zh-CN": "查看或切换 AI Provider", en: "View or change the AI provider" },
    category: "ai",
    access: "admin",
    capability: "chat.ai-selection.write",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "replymode",
    description: { "zh-CN": "切换回复模式", en: "Change the reply mode" },
    category: "ai",
    access: "admin",
    capability: "bot.settings.write",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "richtext",
    description: { "zh-CN": "切换 AI 富文本增强", en: "Toggle enhanced AI rich text" },
    category: "ai",
    access: "admin",
    capability: "bot.settings.write",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "imagegen",
    description: { "zh-CN": "切换群组生图权限", en: "Toggle group image generation" },
    category: "media",
    access: "admin",
    capability: "group.image-generation.write",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "imgcfg",
    description: { "zh-CN": "查看或修改生图配置", en: "View or change image generation settings" },
    category: "media",
    access: "admin",
    capability: "bot.image-generation.write",
    publicHelpVisibility: "admin-overview",
  },
  {
    command: "draw",
    description: { "zh-CN": "直接生成图片", en: "Generate an image directly" },
    category: "media",
    access: "contextual",
    capability: "image.generate",
    publicHelpVisibility: "public",
  },
  {
    command: "summary",
    description: { "zh-CN": "总结群聊消息", en: "Summarize group messages" },
    category: "conversation",
    access: "contextual",
    capability: "group.summary.run",
    publicHelpVisibility: "public",
  },
] as const satisfies readonly TelegramCommandMetadata[];

export type TelegramCommandName = (typeof TELEGRAM_COMMAND_CATALOG)[number]["command"];

const metadataByCommand = new Map<string, TelegramCommandMetadata>(
  TELEGRAM_COMMAND_CATALOG.map((metadata) => [metadata.command, metadata]),
);

export function getTelegramCommandMetadata(command: TelegramCommandName): TelegramCommandMetadata {
  const metadata = metadataByCommand.get(command);
  if (!metadata) throw new Error(`Unknown Telegram command: ${command}`);
  return metadata;
}
