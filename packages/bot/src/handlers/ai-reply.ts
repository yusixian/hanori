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
import { assembleContext } from "../services/context-assembler.js";
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
} from "../tools/index.js";
import { createFileTools } from "../tools/file-tools.js";
import type { MoodInfo } from "../tools/index.js";
import { createOnceGuard } from "../tools/utils.js";
import { markdownToTelegramHtml } from "../utils/format.js";
import { RingBuffer } from "../utils/ring-buffer.js";
import { sleep } from "../utils/sleep.js";
import { splitMessage } from "../utils/split-message.js";
import type { DataFilesConfig } from "../utils/data-files.js";

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
  dataFiles?: DataFilesConfig;
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

// Tools that produce visible side effects (used to decide whether to delete the waiting message)
const VISIBLE_EFFECT_TOOL_NAMES = new Set([
  "react_to_message",
  "send_sticker",
  // Telegram tools
  "send_photo",
  "send_voice",
  "send_document",
  "send_media_group",
  "close_poll",
  "set_timer",
  "cancel_timer",
  "send_dice",
  "delete_own_message",
  "pin_message",
  "get_chat_info",
  // Behavior tools
  "think",
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
  get_profile: "🔍 看看你是谁...",
  update_profile: "📝 记住你的变化...",
  search_profiles: "🔎 想想这个人...",
  search_history: "📜 翻翻聊天记录...",
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
  // Web tools
  web_search: "🌐 搜索中...",
  fetch_webpage: "📄 看看这个网页...",
  get_current_time: "🕐 获取时间...",
  generate_image: "🎨 画画中...",
  // Agent tools
  delegate_task: "🤖 找帮手...",
  // Bot memory tools
  save_memory: "💾 记下来...",
  recall_memories: "🧠 回忆中...",
  delete_memory: "🗑️ 忘掉它...",
  // Artwork tools
  fetch_artwork_info: "🖼️ 查看作品...",
  send_artwork: "🖼️ 发送作品图片...",
  send_media_group: "📷 发送多张图片...",
  // File tools
  read_file: "📄 读取文件...",
  write_file: "✏️ 写入文件...",
  delete_file: "🗑️ 删除文件...",
};

function wrapToolsWithStatus(
  tools: Record<string, CoreTool>,
  ctx: WrapperContext,
): Record<string, CoreTool> {
  const wrapped: Record<string, CoreTool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const status = TOOL_STATUS_MAP[name];
    if (!status || !("execute" in t) || typeof t.execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    const originalExecute = t.execute;
    wrapped[name] = {
      ...t,
      execute: async (...args: Parameters<typeof originalExecute>) => {
        if (ctx.waiting_message) {
          ctx.resolveWait(status).catch(() => {});
        } else {
          ctx.wait(status).catch(() => {});
        }
        return originalExecute(...args);
      },
    };
  }
  return wrapped;
}

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

  // File tools setup (singleton, not per-request)
  let fileTools: Record<string, CoreTool> | undefined;
  if (config.dataFiles) {
    fileTools = createFileTools({
      dataDir: config.dataFiles.dataDir,
      protectedFiles: config.dataFiles.injectableFiles,
    });
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
      timerDepth: 1,
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
      dataFiles: config.dataFiles,
      pendingActions,
      recentBotMessageIds,
      moodState,
      stickerPacks: config.stickerPacks,
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

      // Create per-request once guard to prevent duplicate side-effect tool calls
      const onceGuard = createOnceGuard();

      // Create per-request action tools
      const actionTools = createActionTools({
        api: ctx.api,
        chatId,
        messageId: ctx.message.message_id,
        stickerCache,
        onceGuard,
      });

      // Create per-request telegram tools
      const telegramTools = createTelegramTools({
        api: ctx.api,
        chatId,
        recentBotMessageIds: chatBotMsgIds,
        pendingActions,
        onTimerFired,
        onceGuard,
        dataDir: config.dataFiles?.dataDir,
      });

      // Create per-request behavior tools
      const behaviorTools = createBehaviorTools({
        api: ctx.api,
        chatId,
        recentBotMessageIds: chatBotMsgIds,
        moodState,
        onLog: config.onLog,
        onceGuard,
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
          onceGuard,
        });
      }

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

      // Assemble context using ContextAssembler
      const { messages } = await assembleContext({
        systemPrompt: effectivePrompt,
        behavioralPrompt: config.behavioralPrompt,
        groupBehavioralPrompt: config.groupBehavioralPrompt,
        isPrivate,
        chatId,
        userName,
        userUsername: ctx.from?.username,
        chatTitle: ctx.chat?.title,
        conversationConfig: config.conversationConfig,
        conversation: useConversation ? config.conversation : undefined,
        historyFormat: conversationCfg.historyFormat,
        maxContextMessages: isPrivate ? conversationCfg.maxContextMessages : groupMaxContext,
        ringBufferContext: ringBufferContext || undefined,
        memoryConfig: config.memoryConfig,
        memory: config.memory,
        userId,
        memoryTools,
        botMemoryConfig: config.botMemoryConfig,
        botMemory: config.botMemory,
        botMemoryTools,
        currentMood: moodState.get(chatId),
        stickerPacks: config.stickerPacks,
        webToolsConfig: config.webToolsConfig,
        webTools,
        agentToolsConfig: config.agentToolsConfig,
        artworkToolsEnabled: config.artworkToolsConfig?.enabled,
        hasFileTools: !!fileTools,
        dataFiles: config.dataFiles,
        messageConfig: config.messageConfig,
      });

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
        ...fileTools,
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
      const wrappedTools = wrapToolsWithStatus(allTools, ctx);
      const result = await generateText({
        model: provider(currentModel),
        messages,
        tools: wrappedTools,
        maxSteps,
        toolChoice,
        onStepFinish: ({ toolCalls, toolResults }) => {
          stepCounter++;
          if (toolCalls?.length) {
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
          s.toolCalls.some((tc) => VISIBLE_EFFECT_TOOL_NAMES.has(tc.toolName)),
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

        // Save all tool calls and results from steps
        for (const step of result.steps) {
          for (const tc of step.toolCalls) {
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
          s.toolCalls.some((tc) => VISIBLE_EFFECT_TOOL_NAMES.has(tc.toolName)),
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
