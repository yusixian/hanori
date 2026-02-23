import type {
  AgentToolsConfig,
  AiGroupOverride,
  AiTriggerConfig,
  ArtworkToolsConfig,
  BotLogEntry,
  BotMemoryCallbacks,
  BotMemoryConfig,
  ConversationCallbacks,
  ConversationConfig,
  ConversationRole,
  MemoryCallbacks,
  MemoryConfig,
  MessageConfig,
  ModelEntry,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
} from "@cos-tool-bot/shared";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { CoreTool } from "ai";
import { generateText } from "ai";
import type { Api, Middleware } from "grammy";
import type { WrapperContext } from "../context.js";
import { PendingActionRegistry } from "../services/pending-actions.js";
import type { ContinueChatConfig } from "../services/continue-chat.js";
import { continueChat } from "../services/continue-chat.js";
import {
  createActionTools,
  createAgentTools,
  createArtworkTools,
  createBehaviorTools,
  createBotMemoryTools,
  createMemoryTools,
  createTelegramTools,
  createWebTools,
  getArtworkPlatforms,
  getAvailableAgentNames,
} from "../tools/index.js";
import type { MoodInfo } from "../tools/index.js";
import { markdownToTelegramHtml } from "../utils/format.js";
import { RingBuffer } from "../utils/ring-buffer.js";
import { sleep } from "../utils/sleep.js";
import { splitMessage } from "../utils/split-message.js";

export interface AiReplyConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  adminChatIds: number[];
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  memoryConfig?: MemoryConfig;
  memory?: MemoryCallbacks;
  stickerPacks?: string[];
  webToolsConfig?: WebToolsConfig;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  botMemory?: BotMemoryCallbacks;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  modelOverride?: {
    getModelForChat: (chatId: number) => string | undefined;
    setModelForChat: (chatId: number, modelId: string) => void;
    resetModelForChat: (chatId: number) => void;
  };
}

type TriggerResult = "reply" | "mention" | "keyword" | "random" | false;

interface BufferedMessage {
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
}

interface ToolResultEntry {
  toolName: string;
  result: unknown;
  toolCallId: string;
}

const MAX_MESSAGE_LENGTH = 4096;
const DEBUG_TRUNCATE_LEN = 500;

function truncate(value: unknown, maxLen = DEBUG_TRUNCATE_LEN): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (!str) return "";
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}

const COOLDOWN_CLEANUP_INTERVAL = 5 * 60 * 1000;
const BUFFER_CLEANUP_INTERVAL = 5 * 60 * 1000;
const BUFFER_STALE_MS = 30 * 60 * 1000;

// Tools that produce visible side effects but should NOT be saved to conversation history
const ACTION_TOOL_NAMES = new Set([
  "react_to_message",
  "send_sticker",
  // Telegram tools
  "send_photo",
  "send_voice",
  "send_document",
  "send_poll",
  "send_choice",
  "close_poll",
  "set_timer",
  "cancel_timer",
  "send_dice",
  "edit_own_message",
  "delete_own_message",
  "pin_message",
  "get_chat_info",
  "reply_to_specific",
  // Behavior tools
  "think",
  "multi_message",
  "set_mood",
  // Artwork tools
  "send_artwork",
]);

async function safeReply(ctx: WrapperContext, text: string): Promise<number | undefined> {
  try {
    const html = markdownToTelegramHtml(text);
    return await ctx.resolveWait(html, "HTML");
  } catch {
    try {
      return await ctx.resolveWait(text);
    } catch {
      const sent = await ctx.directlyReply(text).catch(() => undefined);
      return sent?.message_id;
    }
  }
}

const TOOL_STATUS_MAP: Record<string, string> = {
  // Memory tools
  get_profile: "🔍 查询用户档案...",
  update_profile: "📝 更新用户档案...",
  search_profiles: "🔎 搜索人物...",
  search_history: "📜 查找历史对话...",
  // Action tools
  react_to_message: "💫 添加表情...",
  send_sticker: "🎨 发送贴纸...",
  // Telegram tools
  send_photo: "📷 发送图片...",
  send_voice: "🎙️ 发送语音...",
  send_document: "📎 发送文件...",
  send_poll: "📊 发起投票...",
  send_choice: "🎮 发送选择...",
  close_poll: "📊 关闭投票...",
  set_timer: "⏱️ 设置定时器...",
  cancel_timer: "⏱️ 取消定时器...",
  send_dice: "🎲 掷骰子...",
  edit_own_message: "✏️ 编辑消息...",
  delete_own_message: "🗑️ 撤回消息...",
  pin_message: "📌 置顶消息...",
  get_chat_info: "ℹ️ 获取聊天信息...",
  reply_to_specific: "↩️ 回复消息...",
  // Behavior tools
  think: "💭 思考中...",
  multi_message: "💬 组织回复...",
  set_mood: "🎭 调整情绪...",
  // Web tools
  web_search: "🌐 搜索中...",
  fetch_webpage: "📄 阅读网页...",
  get_current_time: "🕐 获取时间...",
  generate_image: "🎨 生成图片...",
  // Agent tools
  delegate_task: "🤖 委派任务...",
  // Bot memory tools
  save_memory: "💾 保存记忆...",
  recall_memories: "🧠 回忆中...",
  delete_memory: "🗑️ 删除记忆...",
  // Artwork tools
  fetch_artwork_info: "🖼️ 获取作品信息...",
  send_artwork: "🖼️ 发送作品图片...",
};

function resolveGroupConfig(
  config: AiReplyConfig,
  chatId: number,
): {
  enabled: boolean;
  whitelisted: boolean;
  systemPrompt: string;
  triggerConfig: AiTriggerConfig;
  conversationEnabled: boolean;
  maxContextMessages: number;
} {
  const conversationCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const override = config.groupOverrides[String(chatId)];
  if (!override) {
    return {
      enabled: config.triggerConfig !== undefined,
      whitelisted: false,
      systemPrompt: config.systemPrompt,
      triggerConfig: config.triggerConfig,
      conversationEnabled: conversationCfg.enabled,
      maxContextMessages: conversationCfg.maxContextMessages,
    };
  }
  return {
    enabled: override.enabled ?? true,
    whitelisted: override.whitelisted ?? false,
    systemPrompt: override.systemPrompt ?? config.systemPrompt,
    triggerConfig: { ...config.triggerConfig, ...override.triggerConfig },
    conversationEnabled: override.conversationEnabled ?? conversationCfg.enabled,
    maxContextMessages: override.maxContextMessages ?? conversationCfg.maxContextMessages,
  };
}

function checkTrigger(
  ctx: WrapperContext,
  triggerConfig: AiTriggerConfig,
  chatId: number,
  cooldownMap: Map<number, number>,
): TriggerResult {
  const text = ctx.message?.text ?? "";

  if (triggerConfig.replyToBot && ctx.message?.reply_to_message?.from?.id === ctx.me.id) {
    return "reply";
  }

  if (triggerConfig.mentionBot && ctx.me.username) {
    if (text.toLowerCase().includes(`@${ctx.me.username.toLowerCase()}`)) {
      return "mention";
    }
  }

  if (triggerConfig.triggerWords.length > 0) {
    const lowerText = text.toLowerCase();
    if (triggerConfig.triggerWords.some((w) => lowerText.includes(w.toLowerCase()))) {
      return "keyword";
    }
  }

  if (triggerConfig.randomReplyPercent > 0) {
    const now = Date.now();
    const lastTime = cooldownMap.get(chatId) ?? 0;
    const cooldownMs = triggerConfig.randomReplyCooldown * 1000;
    if (now - lastTime >= cooldownMs) {
      if (Math.random() * 100 < triggerConfig.randomReplyPercent) {
        cooldownMap.set(chatId, now);
        return "random";
      }
    }
  }

  return false;
}

function getUserDisplayName(ctx: WrapperContext): string {
  const from = ctx.from;
  if (!from) return "Unknown";
  if (from.first_name && from.last_name) return `${from.first_name} ${from.last_name}`;
  return from.first_name || from.username || "Unknown";
}

function formatGroupContextMessages(messages: BufferedMessage[]): string {
  return messages.map((m) => `[${m.userName}]: ${m.text}`).join("\n");
}

const MEMORY_SYSTEM_PROMPT = `
你拥有记忆管理工具，可以记住和搜索关于用户的信息。

可用工具:
- get_profile: 获取用户档案（备注、特征、兴趣等）
- update_profile: 更新用户档案（备注会追加，特征和兴趣会合并去重）
- search_profiles: 模糊搜索人物档案
- search_history: 搜索历史对话记录

使用指南:
- 当用户分享个人信息（喜好、工作、名字等）时，主动使用 update_profile 记录
- 当用户问「你还记得…」或需要回忆之前的对话时，使用 search_history
- 在对话中发现有价值的信息时积极记录，不必等用户要求
- 不要告诉用户你在使用工具，自然地回复即可
`.trim();

const BOT_MEMORY_SYSTEM_PROMPT = `
你拥有长期记忆管理工具，可以保存和检索跨对话持久保存的信息。

可用工具:
- save_memory: 保存一条记忆（通用或关联特定用户）
- recall_memories: 搜索已保存的记忆（支持按关键词、分类、用户过滤）
- delete_memory: 删除不再准确或不再需要的记忆

使用指南:
- 当你学到重要事实、规则或偏好时，使用 save_memory 保存
- 当你需要回忆之前保存的信息时，使用 recall_memories
- 通用记忆（不指定 telegram_id）对所有对话可见
- 用户专属记忆（指定 telegram_id）仅在与该用户对话时可见
- 使用 category 来组织记忆（如 fact、preference、rule、event）
- 学到重要信息时及时保存，不必犹豫
`.trim();

interface ExtendedToolsPromptOptions {
  hasStickerPacks: boolean;
  hasTTS: boolean;
  hasWebTools: boolean;
  hasSearchTool: boolean;
  hasImageGeneration: boolean;
  hasAgentTools: boolean;
  availableAgents: string[];
  hasBotMemory: boolean;
  hasArtworkTools: boolean;
  isPrivate: boolean;
}

function buildExtendedToolsPrompt(opts: ExtendedToolsPromptOptions): string {
  const lines: string[] = [];

  // Behavior tools (always available)
  lines.push("你拥有以下高级行为工具:");
  lines.push("- think: 内部推理，用于深度思考和规划。内容不会发送给用户。");
  lines.push("- multi_message: 分多条消息回复（像真人那样）。使用后不需要再生成普通文本回复。");
  lines.push("- set_mood: 设置你的情绪状态，影响后续回复语气。");

  // Telegram interaction tools
  lines.push("");
  lines.push("Telegram 互动工具:");
  lines.push("- react_to_message: 对当前消息添加 emoji 表情回应（如 👍 ❤ 🔥 😂 😢 🎉 🤩 😱 等）");
  if (opts.hasStickerPacks) {
    lines.push("- send_sticker: 发送一个贴纸来表达情绪");
  }
  lines.push("- send_photo: 发送图片（URL 或 file_id）");
  if (opts.hasTTS) {
    lines.push("- send_voice: 发送语音消息（文本转语音）");
  }
  lines.push("- send_document: 发送文件");
  lines.push("- send_poll: 发起投票（非匿名时投票结果会自动通知你）");
  lines.push("- send_choice: 发送 inline keyboard 选择按钮（用户点击后你会自动收到通知）");
  lines.push("- close_poll: 手动关闭投票并获取最终结果");
  lines.push("- set_timer: 设置定时器，到期后你会自动收到通知继续对话");
  lines.push("- cancel_timer: 取消定时器");
  lines.push("- send_dice: 发送骰子/随机动画");
  lines.push("- edit_own_message: 编辑 bot 之前发的消息");
  lines.push("- delete_own_message: 删除/撤回 bot 之前发的消息");
  lines.push("- pin_message: 置顶消息（需管理员权限）");
  lines.push("- get_chat_info: 获取当前聊天信息");
  lines.push("- reply_to_specific: 回复某条特定历史消息");

  // Web tools
  if (opts.hasWebTools) {
    lines.push("");
    lines.push("信息获取工具:");
    lines.push("- get_current_time: 获取当前时间");
    if (opts.hasSearchTool) {
      lines.push("- web_search: 搜索网络获取最新信息");
    }
    lines.push("- fetch_webpage: 获取网页正文内容");
    if (opts.hasImageGeneration) {
      lines.push("- generate_image: AI 生成图片，配合 send_photo 发送");
    }
  }

  // Agent tools
  if (opts.hasAgentTools && opts.availableAgents.length > 0) {
    lines.push("");
    lines.push("子任务委派工具:");
    lines.push(
      `- delegate_task: 将复杂任务委派给专门的 agent (${opts.availableAgents.join(", ")})`,
    );
  }

  // Bot memory tools
  if (opts.hasBotMemory) {
    lines.push("");
    lines.push("长期记忆工具:");
    lines.push("- save_memory: 保存一条长期记忆（通用或关联特定用户）");
    lines.push("- recall_memories: 搜索已保存的记忆");
    lines.push("- delete_memory: 删除不再需要的记忆");
  }

  // Artwork tools
  if (opts.hasArtworkTools) {
    const platforms = getArtworkPlatforms();
    lines.push("");
    lines.push(`作品图片抓取工具（支持: ${platforms.join(", ")}）:`);
    lines.push("- fetch_artwork_info: 从 URL 获取作品信息（标题、作者、图片列表、标签等）");
    lines.push("- send_artwork: 发送作品图片（支持单图/多图、NSFW 遮罩）");
    lines.push("");
    lines.push("**重要 — 作品链接自动处理规则:**");
    lines.push(
      "- 当用户消息中包含 pixiv.net/artworks/、twitter.com/.../status/、x.com/.../status/ 等链接时，**必须**立即调用 fetch_artwork_info 获取作品信息",
    );
    lines.push("- 获取成功后**必须**调用 send_artwork 发送图片给用户");
    lines.push(
      "- 不要对这些链接使用 fetch_webpage，fetch_artwork_info 能获取更完整的结构化信息和图片",
    );
    lines.push("- 对 NSFW/R18 内容开启 has_spoiler 遮罩");
    lines.push("- 发完图片后可以用自然语言评论作品");
  }

  lines.push("");
  lines.push("使用指南:");
  lines.push("- 积极使用互动工具让对话更生动，像真人聊天一样自然表达");
  lines.push("- 除非使用了 multi_message，否则你必须生成文字回复内容");
  lines.push("- 遇到需要分析或规划的问题时，先用 think 整理思路");
  lines.push("");
  lines.push("**主动行为建议**:");
  lines.push("- 用户说了有趣/感动/搞笑的话 → react_to_message 加个表情");
  lines.push("- 回复内容较长或包含多个话题 → 用 multi_message 分条发送");
  lines.push("- 对话氛围变化时 → 用 set_mood 调整情绪状态");
  lines.push("- 用户分享了个人信息 → 用记忆工具记录");
  if (opts.hasSearchTool) {
    lines.push("- 用户提到时事/不确定的事实 → 用 web_search 查证");
  }
  lines.push("- 需要用户做选择时 → 用 send_choice 或 send_poll，禁止文本选数字");
  lines.push("");
  lines.push("**选择交互规则（重要）**:");
  lines.push(
    "- 当你需要让用户做选择（如 galgame 剧情分支、多选一问答、互动游戏选项等），**禁止**在文本中用「1. 2. 3. 选数字」的方式，必须使用交互工具：",
  );
  if (opts.isPrivate) {
    lines.push("  - 当前为私聊：使用 send_choice 发送 inline keyboard 按钮让用户点选");
  } else {
    lines.push("  - 当前为群聊：使用 send_poll 发起投票让群成员投票选择");
    lines.push(
      "  - 如果选项仅面向特定用户而非群体决策，也可以使用 send_choice 并指定 target_user_id",
    );
  }
  lines.push("- 你可以先用文字描述选项内容/背景，然后紧跟 send_choice 或 send_poll 工具调用");

  return lines.join("\n");
}

async function loadStickerPacks(
  api: Api,
  packNames: string[],
  cache: Map<string, string[]>,
): Promise<void> {
  for (const name of packNames) {
    try {
      const set = await api.getStickerSet(name);
      for (const sticker of set.stickers) {
        if (sticker.emoji) {
          const existing = cache.get(sticker.emoji);
          if (existing) {
            existing.push(sticker.file_id);
          } else {
            cache.set(sticker.emoji, [sticker.file_id]);
          }
        }
      }
    } catch {
      // ignore invalid sticker pack names
    }
  }
}

export interface BotRuntimeState {
  getMood(chatId: number): MoodInfo | undefined;
  getAllMoods(): ReadonlyMap<number, MoodInfo>;
  getActiveGroupCount(): number;
  getPendingActions(): PendingActionRegistry;
  getContinueChatConfig(chatId?: number): ContinueChatConfig;
  isPrivateChat(chatId: number): boolean;
}

const MAX_RECENT_BOT_MESSAGES = 20;
const MOOD_EXPIRE_MS = 60 * 60 * 1000; // 1 hour

export function createAiReplyHandler(config: AiReplyConfig): {
  handler: Middleware<WrapperContext>;
  state: BotRuntimeState;
  setModelForChat: (chatId: number, modelId: string) => void;
  getModelForChat: (chatId: number) => string;
  resetModelForChat: (chatId: number) => void;
} {
  const cooldownMap = new Map<number, number>();

  // Per-chat model override (in-memory fallback)
  const chatModelMap = new Map<number, string>();

  function getModelForChat(chatId: number): string {
    if (config.modelOverride) {
      return config.modelOverride.getModelForChat(chatId) ?? config.model;
    }
    return chatModelMap.get(chatId) ?? config.model;
  }

  function setModelForChat(chatId: number, modelId: string) {
    if (config.modelOverride) {
      config.modelOverride.setModelForChat(chatId, modelId);
    } else {
      chatModelMap.set(chatId, modelId);
    }
  }

  function resetModelForChat(chatId: number) {
    if (config.modelOverride) {
      config.modelOverride.resetModelForChat(chatId);
    } else {
      chatModelMap.delete(chatId);
    }
  }

  // Create AI provider
  const provider = createOpenAICompatible({
    name: "custom",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  // Memory tools setup
  const memoryCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  let memoryTools: Record<string, CoreTool> | undefined;
  if (memoryCfg.enabled && config.memory) {
    memoryTools = createMemoryTools(config.memory);
  }

  // Bot memory tools setup
  const botMemoryCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
  let botMemoryTools: Record<string, CoreTool> | undefined;
  if (botMemoryCfg.enabled && config.botMemory) {
    botMemoryTools = createBotMemoryTools(config.botMemory);
  }

  // Web tools setup (singleton, not per-request)
  let webTools: Record<string, CoreTool> | undefined;
  if (config.webToolsConfig?.enabled) {
    webTools = createWebTools({ config: config.webToolsConfig });
  }

  // Recent bot message IDs per chat (for edit/delete tools)
  const recentBotMessageIds = new Map<number, number[]>();

  // Mood state per chat
  const moodState = new Map<number, MoodInfo>();

  // Pending actions registry for interactive tools
  const pendingActions = new PendingActionRegistry();

  // Track known private chats
  const knownPrivateChats = new Set<number>();

  // Captured bot API reference (set on first request)
  let botApi: Api | undefined;

  // Timer fired callback - triggers continueChat
  const onTimerFired = (timerChatId: number, timerId: string, reason: string) => {
    if (!botApi) return;
    const eventDescription = `定时器到期 (ID: ${timerId}): ${reason}\n请根据定时器的用途继续对话。`;
    continueChat(botApi, buildContinueChatConfig(timerChatId), {
      chatId: timerChatId,
      eventDescription,
    }).catch((err) => {
      config.onLog?.({
        level: "error",
        message: `Timer continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
        meta: { chatId: timerChatId, timerId },
      });
    });
  };

  function buildContinueChatConfig(chatId?: number): ContinueChatConfig {
    const modelId = chatId != null ? getModelForChat(chatId) : config.model;
    return {
      model: provider(modelId),
      systemPrompt: config.systemPrompt,
      behavioralPrompt: config.behavioralPrompt,
      conversationConfig: config.conversationConfig,
      conversation: config.conversation,
      memoryConfig: config.memoryConfig,
      memory: config.memory,
      botMemoryConfig: config.botMemoryConfig,
      botMemory: config.botMemory,
      messageConfig: config.messageConfig,
      webToolsConfig: config.webToolsConfig,
      agentToolsConfig: config.agentToolsConfig,
      artworkToolsConfig: config.artworkToolsConfig,
      webTools,
      agentToolsFactory: config.agentToolsConfig?.enabled
        ? () =>
            createAgentTools({
              provider: (m) => provider(m),
              model: modelId,
              agentConfig: config.agentToolsConfig!,
              webToolsConfig: config.webToolsConfig,
              onLog: config.onLog,
            })
        : undefined,
      pendingActions,
      recentBotMessageIds,
      moodState,
      onTimerFired,
      onLog: config.onLog,
    };
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    const maxCooldown = config.triggerConfig.randomReplyCooldown * 1000;
    for (const [chatId, lastTime] of cooldownMap) {
      if (now - lastTime > maxCooldown * 2) cooldownMap.delete(chatId);
    }
    // Clean expired moods
    for (const [chatId, mood] of moodState) {
      if (now - mood.timestamp > MOOD_EXPIRE_MS) moodState.delete(chatId);
    }
  }, COOLDOWN_CLEANUP_INTERVAL);
  cleanupTimer.unref();

  // Sticker cache: emoji → file_id[]
  const stickerCache = new Map<string, string[]>();
  let stickerCachePromise: Promise<void> | null = null;

  // Group chat ring buffers
  const conversationCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const groupBuffers = new Map<
    number,
    { buffer: RingBuffer<BufferedMessage>; lastActive: number }
  >();

  const bufferCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of groupBuffers) {
      if (now - entry.lastActive > BUFFER_STALE_MS) groupBuffers.delete(chatId);
    }
  }, BUFFER_CLEANUP_INTERVAL);
  bufferCleanupTimer.unref();

  function getOrCreateBuffer(chatId: number): RingBuffer<BufferedMessage> {
    let entry = groupBuffers.get(chatId);
    if (!entry) {
      entry = {
        buffer: new RingBuffer<BufferedMessage>(conversationCfg.groupBufferSize),
        lastActive: Date.now(),
      };
      groupBuffers.set(chatId, entry);
    } else {
      entry.lastActive = Date.now();
    }
    return entry.buffer;
  }

  const state: BotRuntimeState = {
    getMood: (chatId) => {
      const mood = moodState.get(chatId);
      if (mood && Date.now() - mood.timestamp > MOOD_EXPIRE_MS) {
        moodState.delete(chatId);
        return undefined;
      }
      return mood;
    },
    getAllMoods: () => moodState,
    getActiveGroupCount: () => groupBuffers.size,
    getPendingActions: () => pendingActions,
    getContinueChatConfig: (cid) => buildContinueChatConfig(cid),
    isPrivateChat: (chatId) => knownPrivateChats.has(chatId),
  };

  const handler: Middleware<WrapperContext> = async (ctx, next) => {
    if (!ctx.message?.text) return next();

    // Skip commands
    const entities = ctx.message.entities ?? [];
    if (entities.some((e) => e.type === "bot_command" && e.offset === 0)) {
      return next();
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    const isPrivate = ctx.chat?.type === "private";
    const userId = ctx.from?.id;
    if (!userId) return next();

    // Capture API reference and track private chats for event handlers
    botApi = ctx.api;
    if (isPrivate) knownPrivateChats.add(chatId);

    const isAdmin = config.adminChatIds.includes(userId);
    const userName = getUserDisplayName(ctx);

    // Push to ring buffer for group chats (before trigger check)
    if (!isPrivate) {
      const buffer = getOrCreateBuffer(chatId);
      buffer.push({
        userId,
        userName,
        text: ctx.message.text,
        timestamp: Date.now(),
      });
    }

    let effectivePrompt = config.systemPrompt;
    let triggerResult: TriggerResult = false;
    let groupConversationEnabled = conversationCfg.enabled;
    let groupMaxContext = conversationCfg.maxContextMessages;

    if (isPrivate) {
      if (!isAdmin) return next();
      triggerResult = "reply"; // Private always triggers
    } else {
      const groupCfg = resolveGroupConfig(config, chatId);
      if (!groupCfg.enabled) return next();
      if (!groupCfg.whitelisted && !isAdmin) return next();

      triggerResult = checkTrigger(ctx, groupCfg.triggerConfig, chatId, cooldownMap);
      if (!triggerResult) return next();

      effectivePrompt = groupCfg.systemPrompt;
      groupConversationEnabled = groupCfg.conversationEnabled;
      groupMaxContext = groupCfg.maxContextMessages;
    }

    // Determine if conversation history is enabled
    const useConversation =
      config.conversation && (isPrivate ? conversationCfg.enabled : groupConversationEnabled);

    try {
      await ctx.replyWithChatAction("typing");

      // Lazy-load sticker packs (deduped via shared promise)
      if (!stickerCachePromise && config.stickerPacks?.length) {
        stickerCachePromise = loadStickerPacks(ctx.api, config.stickerPacks, stickerCache);
      }
      if (stickerCachePromise) await stickerCachePromise;

      // Per-chat recent bot message IDs
      let chatBotMsgIds = recentBotMessageIds.get(chatId);
      if (!chatBotMsgIds) {
        chatBotMsgIds = [];
        recentBotMessageIds.set(chatId, chatBotMsgIds);
      }
      // Trim old IDs
      while (chatBotMsgIds.length > MAX_RECENT_BOT_MESSAGES) chatBotMsgIds.shift();

      // Create per-request action tools
      const actionTools = createActionTools({
        api: ctx.api,
        chatId,
        messageId: ctx.message.message_id,
        stickerCache,
      });

      // Create per-request telegram tools
      const telegramTools = createTelegramTools({
        api: ctx.api,
        chatId,
        recentBotMessageIds: chatBotMsgIds,
        pendingActions,
        onTimerFired,
      });

      // Create per-request behavior tools
      const behaviorTools = createBehaviorTools({
        api: ctx.api,
        chatId,
        recentBotMessageIds: chatBotMsgIds,
        moodState,
        onLog: config.onLog,
      });

      // Resolve model for this chat
      const currentModel = getModelForChat(chatId);

      // Create agent tools if enabled
      let agentTools: Record<string, CoreTool> = {};
      if (config.agentToolsConfig?.enabled) {
        agentTools = createAgentTools({
          provider: (m) => provider(m),
          model: currentModel,
          agentConfig: config.agentToolsConfig,
          webToolsConfig: config.webToolsConfig,
          onLog: config.onLog,
        });
      }

      // Create artwork tools if enabled
      let artworkTools: Record<string, CoreTool> = {};
      if (config.artworkToolsConfig?.enabled) {
        artworkTools = createArtworkTools({
          api: ctx.api,
          chatId,
          recentBotMessageIds: chatBotMsgIds,
          config: config.artworkToolsConfig,
        });
      }

      // Build messages array
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
      const historyFormat = conversationCfg.historyFormat ?? "prompt";

      if (useConversation) {
        const maxContext = isPrivate ? conversationCfg.maxContextMessages : groupMaxContext;
        const history = await config.conversation!.getHistory(chatId, maxContext);

        // Collect group context from ring buffer
        let ringBufferContext = "";
        if (!isPrivate) {
          const shouldIncludeContext =
            conversationCfg.groupContextMode === "all" ||
            (conversationCfg.groupContextMode === "random_only" && triggerResult === "random");

          if (shouldIncludeContext) {
            const buffer = groupBuffers.get(chatId);
            if (buffer) {
              const allMessages = buffer.buffer.getAll();
              const contextMessages = allMessages.slice(0, -1);
              if (contextMessages.length > 0) {
                ringBufferContext = formatGroupContextMessages(contextMessages);
              }
            }
          }
        }

        if (historyFormat === "prompt") {
          // Pack everything into system prompt for maximum compatibility
          const parts: string[] = [effectivePrompt];

          if (history.summary) {
            parts.push(`[对话摘要]\n${history.summary}`);
          }

          if (history.messages.length > 0) {
            const historyLines = history.messages.map((msg) => {
              if (msg.role === "context") return `[群聊上下文]\n${msg.content}`;
              const prefix = msg.role === "assistant" ? "AI" : msg.userName || "User";
              return `${prefix}: ${msg.content}`;
            });
            parts.push(`[对话历史]\n${historyLines.join("\n")}\n[对话历史结束]`);
          }

          if (ringBufferContext) {
            parts.push(`[近期群聊消息]\n${ringBufferContext}`);
          }

          messages.push({ role: "system", content: parts.join("\n\n") });
        } else {
          // Standard multi-turn messages format
          messages.push({ role: "system", content: effectivePrompt });

          if (history.summary) {
            messages.push({ role: "system", content: `[对话摘要] ${history.summary}` });
          }

          for (const msg of history.messages) {
            if (msg.role === "context") {
              messages.push({ role: "system", content: `[近期群聊消息]\n${msg.content}` });
            } else {
              const role = msg.role === "assistant" ? "assistant" : "user";
              const content =
                !isPrivate && msg.userName && msg.role === "user"
                  ? `[${msg.userName}]: ${msg.content}`
                  : msg.content;
              messages.push({ role, content });
            }
          }

          if (ringBufferContext) {
            messages.push({ role: "system", content: `[近期群聊消息]\n${ringBufferContext}` });
          }
        }
      } else {
        messages.push({ role: "system", content: effectivePrompt });
      }

      // Inject chat environment context + behavioral prompts into system prompt
      if (messages.length > 0 && messages[0]!.role === "system") {
        let envInfo: string;

        if (isPrivate) {
          envInfo = `[System: The user "${userName}"${ctx.from?.username ? ` (@${ctx.from.username})` : ""} is chatting with you in a PRIVATE chat.]`;
        } else {
          const chatTitle = ctx.chat?.title ?? "Unknown";
          envInfo = `[System: The user "${userName}"${ctx.from?.username ? ` (@${ctx.from.username})` : ""} is chatting with you in a GROUP CHAT named "${chatTitle}" (chatId: ${chatId}).]`;
        }

        const suffix = [
          config.behavioralPrompt,
          !isPrivate ? config.groupBehavioralPrompt : undefined,
        ]
          .filter(Boolean)
          .join("\n\n");

        messages[0]!.content =
          envInfo + "\n\n" + messages[0]!.content + (suffix ? `\n\n${suffix}` : "");
      }

      // Memory system: inject system prompt and auto-read profile
      if (memoryTools && config.memory) {
        // Append memory management instructions to the first system message
        if (messages.length > 0 && messages[0]!.role === "system") {
          messages[0]!.content += `\n\n${MEMORY_SYSTEM_PROMPT}`;
        }

        // Auto-read profile: inject current user profile as context
        if (memoryCfg.autoReadProfile && userId) {
          try {
            const profile = await config.memory.getProfile(userId);
            if (profile) {
              const profileInfo = [
                `Telegram ID: ${profile.telegramId}`,
                profile.displayName && `名称: ${profile.displayName}`,
                profile.username && `用户名: @${profile.username}`,
                profile.notes && `备注: ${profile.notes}`,
                profile.traits?.length && `特征: ${profile.traits.join(", ")}`,
                profile.interests?.length && `兴趣: ${profile.interests.join(", ")}`,
                profile.relationship && `关系: ${profile.relationship}`,
              ]
                .filter(Boolean)
                .join("\n");
              messages.push({
                role: "system",
                content: `[当前对话用户档案]\n${profileInfo}`,
              });
            }
          } catch {
            // ignore profile read errors
          }
        }

        // Auto-update lastSeen
        if (memoryCfg.autoUpdateLastSeen && userId) {
          config.memory.touchProfile(userId, userName, ctx.from?.username).catch(() => {});
        }
      }

      // Inject mood state into system prompt
      const currentMood = moodState.get(chatId);
      if (currentMood && messages.length > 0 && messages[0]!.role === "system") {
        const moodStr = currentMood.reason
          ? `[当前情绪: ${currentMood.mood}，原因: ${currentMood.reason}]`
          : `[当前情绪: ${currentMood.mood}]`;
        messages[0]!.content += `\n\n${moodStr}`;
      }

      // Bot memory: inject system prompt and memories
      if (botMemoryTools && config.botMemory && botMemoryCfg.autoInjectMemories) {
        if (messages.length > 0 && messages[0]!.role === "system") {
          messages[0]!.content += `\n\n${BOT_MEMORY_SYSTEM_PROMPT}`;
        }
        try {
          const memories = await config.botMemory.getMemoriesForPrompt(
            userId,
            botMemoryCfg.maxMemories,
          );
          if (memories.length > 0) {
            const lines = memories.map((m) =>
              m.category ? `- [${m.category}] ${m.content}` : `- ${m.content}`,
            );
            messages.push({ role: "system", content: `[长期记忆]\n${lines.join("\n")}` });
          }
        } catch (err) {
          console.error("Failed to load bot memories for prompt:", err);
        }
      }

      // Inject extended tools prompt
      if (messages.length > 0 && messages[0]!.role === "system") {
        const availableAgents = config.agentToolsConfig?.enabled
          ? getAvailableAgentNames(config.agentToolsConfig, config.webToolsConfig)
          : [];
        const extendedPrompt = buildExtendedToolsPrompt({
          hasStickerPacks: !!config.stickerPacks?.length,
          hasTTS: false,
          hasWebTools: !!config.webToolsConfig?.enabled,
          hasSearchTool: !!webTools?.web_search,
          hasImageGeneration: !!config.webToolsConfig?.imageGeneration,
          hasAgentTools: !!config.agentToolsConfig?.enabled,
          availableAgents,
          hasBotMemory: !!botMemoryTools,
          hasArtworkTools: !!config.artworkToolsConfig?.enabled,
          isPrivate,
        });
        messages[0]!.content += `\n\n${extendedPrompt}`;
      }

      // Inject split-friendly writing hint when auto-split is enabled
      if (
        (config.messageConfig?.autoSplitThreshold ?? 0) > 0 &&
        messages.length > 0 &&
        messages[0]!.role === "system"
      ) {
        messages[0]!.content +=
          "\n\n[System: 回复较长内容时，请注意使用段落自然分隔（空行分段），避免在一个段落中堆砌过多内容，使回复结构清晰易读。]";
      }

      // Current user message
      const currentContent = !isPrivate ? `[${userName}]: ${ctx.message.text}` : ctx.message.text;
      messages.push({ role: "user", content: currentContent });

      // Combine all tools
      const allTools: Record<string, CoreTool> = {
        ...memoryTools,
        ...botMemoryTools,
        ...actionTools,
        ...telegramTools,
        ...behaviorTools,
        ...webTools,
        ...agentTools,
        ...artworkTools,
      };
      // Increase maxSteps when agent tools, web tools, or artwork tools are available
      const baseMaxSteps = memoryCfg.maxSteps || 3;
      const hasAdvancedTools =
        config.agentToolsConfig?.enabled ||
        config.webToolsConfig?.enabled ||
        config.artworkToolsConfig?.enabled;
      const maxSteps = Math.max(hasAdvancedTools ? Math.max(baseMaxSteps, 8) : baseMaxSteps, 2);
      const toolChoice = memoryCfg.toolChoice ?? "auto";

      // Debug: AI request
      const startTime = Date.now();
      config.onLog?.({
        level: "debug",
        message: "AI request",
        meta: {
          model: currentModel,
          baseURL: config.baseURL,
          messagesCount: messages.length,
          systemPromptLength: messages[0]?.role === "system" ? messages[0].content.length : 0,
          toolsEnabled: Object.keys(allTools),
          maxSteps,
          toolChoice,
          chatId,
          userId,
          userName,
          isPrivate,
          trigger: triggerResult,
        },
      });

      let stepCounter = 0;
      const result = await generateText({
        model: provider(currentModel),
        messages,
        tools: allTools,
        maxSteps,
        toolChoice,
        onStepFinish: ({ toolCalls, toolResults }) => {
          stepCounter++;
          if (toolCalls?.length) {
            const lastTool = toolCalls[toolCalls.length - 1]!.toolName;
            const status = TOOL_STATUS_MAP[lastTool] ?? `🔧 ${lastTool}...`;
            // First tool call sends the status message; subsequent ones edit it
            if (ctx.waiting_message) {
              ctx.resolveWait(status).catch(() => {});
            } else {
              ctx.wait(status).catch(() => {});
            }

            // Debug: AI tool calls
            for (const tc of toolCalls) {
              config.onLog?.({
                level: "debug",
                message: "AI tool call",
                meta: {
                  step: stepCounter,
                  toolName: tc.toolName,
                  args: truncate(tc.args),
                  toolCallId: tc.toolCallId,
                },
              });
            }
          }
          // Debug: AI tool results
          if (toolResults?.length) {
            for (const tr of toolResults as ToolResultEntry[]) {
              config.onLog?.({
                level: "debug",
                message: "AI tool result",
                meta: {
                  step: stepCounter,
                  toolName: tr.toolName,
                  result: truncate(tr.result),
                  toolCallId: tr.toolCallId,
                },
              });
            }
          }
        },
      });

      const durationMs = Date.now() - startTime;
      const text = result.text?.trim();

      // Warn if AI returned empty text (skip if action tools produced visible effects)
      if (!text) {
        const hasActionToolCalls = result.steps.some((s) =>
          s.toolCalls.some((tc) => ACTION_TOOL_NAMES.has(tc.toolName)),
        );
        if (!hasActionToolCalls) {
          config.onLog?.({
            level: "warn",
            message: "AI returned empty text",
            meta: { chatId, userId, finishReason: result.finishReason },
          });
        }
      }

      // Debug: AI response
      const totalToolCalls = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
      const totalToolResults = result.steps.reduce((n, s) => n + s.toolResults.length, 0);
      config.onLog?.({
        level: "debug",
        message: "AI response",
        meta: {
          durationMs,
          responseLength: text?.length ?? 0,
          responsePreview: truncate(text ?? "", 200),
          totalSteps: result.steps.length,
          finishReason: result.finishReason,
          usage: result.usage,
          totalToolCalls,
          totalToolResults,
        },
      });

      // Save messages to conversation history (before checking text emptiness)
      if (useConversation) {
        const toSave: Array<{
          chatId: number;
          role: ConversationRole;
          content: string;
          userId?: number;
          userName?: string;
          meta?: Record<string, unknown>;
        }> = [];

        // Save group context if configured
        if (!isPrivate) {
          const shouldSaveContext =
            conversationCfg.saveGroupContext === "all" ||
            (conversationCfg.saveGroupContext === "random_only" && triggerResult === "random");

          if (shouldSaveContext) {
            const buffer = groupBuffers.get(chatId);
            if (buffer) {
              const allMessages = buffer.buffer.getAll();
              const contextMessages = allMessages.slice(0, -1);
              if (contextMessages.length > 0) {
                toSave.push({
                  chatId,
                  role: "context",
                  content: formatGroupContextMessages(contextMessages),
                });
              }
            }
          }
        }

        // Save user message
        toSave.push({
          chatId,
          role: "user",
          content: ctx.message.text,
          userId,
          userName,
        });

        // Save tool calls and results from steps (skip action tools that don't need history)
        for (const step of result.steps) {
          for (const tc of step.toolCalls) {
            if (ACTION_TOOL_NAMES.has(tc.toolName)) continue;
            toSave.push({
              chatId,
              role: "tool_call",
              content: tc.toolName,
              meta: {
                toolName: tc.toolName,
                args: JSON.stringify(tc.args),
                toolCallId: tc.toolCallId,
              },
            });
          }
          for (const tr of step.toolResults as ToolResultEntry[]) {
            if (ACTION_TOOL_NAMES.has(tr.toolName)) continue;
            toSave.push({
              chatId,
              role: "tool_result",
              content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
              meta: {
                toolName: tr.toolName,
                toolCallId: tr.toolCallId,
              },
            });
          }
        }

        // Save assistant reply with usage meta (even if empty text)
        toSave.push({
          chatId,
          role: "assistant",
          content: text || "",
          meta: {
            model: currentModel,
            trigger: triggerResult,
            usage: result.usage,
          },
        });

        config.conversation!.addMessages(toSave).catch((err) => {
          config.onLog?.({
            level: "error",
            message: `Failed to save conversation: ${err instanceof Error ? err.message : String(err)}`,
            meta: { chatId },
          });
        });

        // Trigger compression check asynchronously
        config.conversation!.triggerCompression(chatId);
      }

      // Check if multi_message was used (already sent messages directly)
      const hasMultiMessage = result.steps.some((s) =>
        s.toolCalls.some((tc) => tc.toolName === "multi_message"),
      );

      // Final response: edit the waiting message
      if (hasMultiMessage) {
        // multi_message already sent messages, just clean up waiting message
        await ctx.deleteWaiting();
      } else if (text) {
        const msgCfg = config.messageConfig ?? DEFAULT_MESSAGE_CONFIG;
        const chunks = splitMessage(text, msgCfg.autoSplitThreshold);

        if (chunks.length <= 1) {
          // Single chunk: keep original truncation behavior
          const replyText =
            text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH - 3) + "..." : text;
          const replyMsgId = await safeReply(ctx, replyText);
          if (replyMsgId) chatBotMsgIds.push(replyMsgId);
        } else {
          // Multi-chunk: first chunk edits the waiting message, rest are new messages
          const firstMsgId = await safeReply(ctx, chunks[0]!);
          if (firstMsgId) chatBotMsgIds.push(firstMsgId);
          for (let i = 1; i < chunks.length; i++) {
            await ctx.api.sendChatAction(chatId, "typing");
            await sleep(msgCfg.splitDelayMs);
            try {
              const html = markdownToTelegramHtml(chunks[i]!);
              const sent = await ctx.api.sendMessage(chatId, html, { parse_mode: "HTML" });
              chatBotMsgIds.push(sent.message_id);
            } catch {
              try {
                const sent = await ctx.api.sendMessage(chatId, chunks[i]!);
                chatBotMsgIds.push(sent.message_id);
              } catch {
                // skip failed chunk
              }
            }
          }
        }
      } else {
        // Check if any action tools produced visible effects (sticker, reaction, telegram actions)
        const hasVisibleAction = result.steps.some((s) =>
          s.toolCalls.some((tc) => ACTION_TOOL_NAMES.has(tc.toolName)),
        );
        if (hasVisibleAction) {
          await ctx.deleteWaiting();
        } else {
          const replyMsgId = await safeReply(ctx, "(AI 未生成回复内容)");
          if (replyMsgId) chatBotMsgIds.push(replyMsgId);
        }
      }

      config.onLog?.({
        level: "info",
        message: "AI reply sent",
        meta: {
          chatId,
          userId,
          isPrivate,
          textLength: text?.length ?? 0,
          trigger: triggerResult,
          conversationEnabled: !!useConversation,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      config.onLog?.({
        level: "error",
        message: `AI reply failed: ${errMsg}`,
        meta: { chatId, userId },
      });
      const errorReply = `AI 回复时出错:\n${errMsg}`;
      try {
        await ctx.resolveWait(errorReply);
      } catch {
        await ctx.directlyReply(errorReply).catch(() => {});
      }
    }
  };

  return { handler, state, setModelForChat, getModelForChat, resetModelForChat };
}
