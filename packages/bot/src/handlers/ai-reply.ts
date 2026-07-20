import { resolveCompleteStreamText, throwCapturedStreamError } from "../utils/stream-error.js";
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
  GitHubToolsRuntimeConfig,
  ImageOcrConfig,
  MemoryCallbacks,
  MemoryConfig,
  MessageConfig,
  ModelEntry,
  GitHubCodingModelConfig,
  PixAIConfig,
  PixAIGenerationRecord,
  ReplyMode,
  TimeoutConfig,
  TokenUsageRecord,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
  DEFAULT_TIMEOUT_CONFIG,
  inferCapabilities,
  isRichMessageEnabled,
  isStreamReplyMode,
} from "@cos-tool-bot/shared";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONValue, LanguageModel, Tool, UserModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import type { Api, Middleware } from "grammy";
import type { Message, User } from "grammy/types";
import type { BotContext, WrapperContext } from "../context.js";
import { appendCurrentRequest, assembleContext } from "../services/context-assembler.js";
import { GroupContextPersistenceTracker } from "../services/group-context-persistence-tracker.js";
import { PendingActionRegistry } from "../services/pending-actions.js";
import { PendingGitHubActionRegistry } from "../services/pending-github-actions.js";
import type { ContinueChatConfig } from "../services/continue-chat.js";
import { continueChat } from "../services/continue-chat.js";
import { acquireChatLock } from "../services/chat-lock.js";
import {
  createActionTools,
  createAgentTools,
  createArtworkTools,
  createBehaviorTools,
  createBotMemoryTools,
  createMemoryTools,
  createMcpTools,
  createGitHubTools,
  type GitHubCodeCallbacks,
  type McpToolsOptions,
  createRssTools,
  createTelegramTools,
  createWebTools,
  directPixAIGenerate,
  injectPixAITool,
} from "../tools/index.js";
import type { DirectGenerateResult, DrawOverrides, RssToolsOptions } from "../tools/index.js";
import type { ReceivedFile } from "../tools/telegram.js";
import { createFileTools } from "../tools/file-tools.js";
import type { MoodInfo } from "../tools/index.js";
import { PixAIRateLimiter } from "../services/pixai-rate-limiter.js";
import type { RateLimitStats } from "../services/pixai-rate-limiter.js";
import {
  createOnceGuard,
  createPerStepAbort,
  createRequestCache,
  wrapToolsWithCache,
} from "../tools/utils.js";
import { markdownToTelegramHtml } from "../utils/format.js";
import { sendMarkdownWithFallback } from "../utils/rich-message.js";
import { RingBuffer } from "../utils/ring-buffer.js";
import { splitMessage } from "../utils/split-message.js";
import { sleep } from "../utils/sleep.js";
import { formatSentMessagesHtml, showRichThinkingDraft } from "../utils/stream-reply.js";
import type { DataFilesConfig } from "../utils/data-files.js";
import type { NsfwChecker } from "../services/nsfw-checker.js";
import { describeImages } from "../services/image-ocr.js";
import { TelegramProfileObserver } from "../services/telegram-profile-observer.js";
import { createMetaPrefixStreamFilter, stripMetaPrefix } from "../utils/strip-meta-prefix.js";
import { createThinkingStreamFilter, stripThinkingContent } from "../utils/strip-thinking.js";

export interface AiProviderRuntime {
  id: string;
  label: string;
  apiKey: string;
  baseURL: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
  models?: ModelEntry[];
}

export function buildGitHubCodingModelConfig(
  provider: AiProviderRuntime,
  modelId: string,
): GitHubCodingModelConfig {
  const entry = provider.models?.find((model) => model.id === modelId);
  return {
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    id: modelId,
    providerFormat: provider.providerFormat,
    maxTokens: entry?.maxTokens,
    capabilities: entry?.capabilities ?? inferCapabilities(modelId),
    thinking: entry?.thinking,
  };
}

export interface AiReplyConfig {
  botId: string;
  /** @deprecated active provider's apiKey — superseded by providers[] when present */
  apiKey: string;
  /** @deprecated active provider's baseURL */
  baseURL: string;
  /** @deprecated active provider's defaultModel */
  model: string;
  /** @deprecated active provider's providerFormat */
  providerFormat?: "openai" | "gemini";
  providers?: AiProviderRuntime[];
  activeProviderId?: string;
  providerOverride?: {
    getProviderForChat: (chatId: number) => string | undefined;
    setProviderForChat: (chatId: number, providerId: string) => void;
    resetProviderForChat: (chatId: number) => void;
  };
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
  githubToolsConfig?: GitHubToolsRuntimeConfig;
  githubCodeCallbacks?: GitHubCodeCallbacks;
  artworkToolsConfig?: ArtworkToolsConfig;
  botMemoryConfig?: BotMemoryConfig;
  messageConfig?: MessageConfig;
  imageOcrConfig?: ImageOcrConfig;
  botMemory?: BotMemoryCallbacks;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
  modelOverride?: {
    getModelForChat: (chatId: number) => string | undefined;
    setModelForChat: (chatId: number, modelId: string) => void;
    resetModelForChat: (chatId: number) => void;
  };
  timeoutConfig?: TimeoutConfig;
  dataFiles?: DataFilesConfig;
  privateChatWhitelist?: number[];
  nsfwChecker?: NsfwChecker;
  token: string;
  onGroupOverrideUpdate?: (chatId: number, override: AiGroupOverride) => void | Promise<void>;
  onPixaiConfigUpdate?: (updates: {
    model?: string;
    pixaiConfig?: Partial<PixAIConfig>;
  }) => void | Promise<void>;
  onMessageConfigUpdate?: (updates: Partial<MessageConfig>) => void | Promise<void>;
  onWebToolApiKeyUpdate?: (target: "image" | "search", apiKey: string) => void | Promise<void>;
  onTimerCreate?: (params: {
    timerId: string;
    chatId: number;
    seconds: number;
    reason: string;
  }) => void;
  onTimerCancel?: (timerId: string) => void;
  onTimerFiredPersist?: (timerId: string) => void;
  rssCallbacks?: Omit<RssToolsOptions, "chatId" | "adminChatIds">;
  mcpTools?: McpToolsOptions;
  initialApi?: Api;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;

async function downloadImagesForVision(
  api: Api,
  token: string,
  files: ReceivedFile[],
  timeoutMs: number,
): Promise<Array<{ buffer: Buffer; mimeType: string; sourceIndex: number }>> {
  const indexed = files
    .map((f, idx) => ({ f, idx }))
    .filter(({ f }) => f.type === "photo" || f.mime_type?.startsWith("image/"));
  if (indexed.length === 0) return [];
  const settled = await Promise.allSettled(
    indexed.map(async ({ f, idx }) => {
      const tgFile = await api.getFile(f.file_id);
      if (!tgFile.file_path) return null;
      const url = `https://api.telegram.org/file/bot${token}/${tgFile.file_path}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_VISION_IMAGE_BYTES) return null;
      return { buffer: buf, mimeType: f.mime_type ?? "image/jpeg", sourceIndex: idx };
    }),
  );
  const results: Array<{ buffer: Buffer; mimeType: string; sourceIndex: number }> = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value != null) results.push(r.value);
    else if (r.status === "rejected") console.debug("[vision] image download failed:", r.reason);
  }
  return results;
}

function extractFilesFromMessage(msg: Message | undefined): ReceivedFile[] {
  const files: ReceivedFile[] = [];
  if (!msg) return files;
  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1]!;
    files.push({ type: "photo", file_id: largest.file_id, file_size: largest.file_size });
  }
  if (msg.document) {
    files.push({
      type: "document",
      file_id: msg.document.file_id,
      file_name: msg.document.file_name ?? undefined,
      file_size: msg.document.file_size,
      mime_type: msg.document.mime_type ?? undefined,
    });
  }
  return files;
}

type TriggerResult = "reply" | "mention" | "keyword" | "random" | false;

interface BufferedMessage {
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
}

interface ToolResultEntry {
  toolName: string;
  output: unknown;
  toolCallId: string;
}

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
  "set_mood",
  // Artwork tools
  "send_artwork",
]);

async function directlyReplyAndCleanup(
  ctx: WrapperContext,
  text: string,
): Promise<number | undefined> {
  const sent = await ctx.directlyReply(text).catch(() => undefined);
  if (!sent) return undefined;
  await ctx.deleteWaiting().catch(() => {});
  return sent.message_id;
}

async function safeReply(ctx: WrapperContext, text: string): Promise<number | undefined> {
  try {
    const html = markdownToTelegramHtml(text);
    return await ctx.resolveWait(html, "HTML");
  } catch {
    try {
      return await ctx.resolveWait(text);
    } catch {
      return directlyReplyAndCleanup(ctx, text);
    }
  }
}

export async function safeFormattedReply(
  ctx: WrapperContext,
  text: string,
  richMessageEnabled: boolean,
  onFallback?: (mode: "rich" | "html", error: unknown) => void,
): Promise<number | undefined> {
  if (!richMessageEnabled) return safeReply(ctx, text);

  const messageThreadId = ctx.message?.message_thread_id;
  const topicOptions =
    messageThreadId === undefined ? undefined : { message_thread_id: messageThreadId };
  const replyParameters =
    ctx.chat?.type === "private" ? undefined : { message_id: ctx.message!.message_id };
  try {
    let result;
    try {
      result = await sendMarkdownWithFallback(
        ctx.api,
        ctx.chat!.id,
        text,
        richMessageEnabled,
        { ...topicOptions, reply_parameters: replyParameters },
        onFallback,
      );
    } catch (error) {
      if (!replyParameters) throw error;
      result = await sendMarkdownWithFallback(
        ctx.api,
        ctx.chat!.id,
        text,
        richMessageEnabled,
        topicOptions,
        onFallback,
      );
    }
    await ctx.deleteWaiting();
    return result.message.message_id;
  } catch {
    return safeReply(ctx, text);
  }
}

export async function sendFormattedChunks(
  ctx: WrapperContext,
  text: string,
  messageConfig: MessageConfig,
  richMessageEnabled: boolean,
  onFallback?: (mode: "rich" | "html", error: unknown) => void,
  shouldAbort?: () => boolean,
): Promise<number[]> {
  const threshold = messageConfig.autoSplitThreshold ?? 0;
  const chunks = splitMessage(text, threshold > 0 ? threshold : 4096);
  const messageIds: number[] = [];

  for (const [index, chunk] of chunks.entries()) {
    if (shouldAbort?.()) break;
    if (index > 0) {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});
      await sleep(messageConfig.splitDelayMs ?? 800);
      if (shouldAbort?.()) break;
    }

    const replyMsgId = await safeFormattedReply(ctx, chunk, richMessageEnabled, onFallback);
    if (!replyMsgId) throw new Error("Telegram reply delivery failed");
    messageIds.push(replyMsgId);
    // A final fallback may edit the waiting message even when Rich delivery is enabled.
    // Detach it after conversion so later chunks become additional persistent messages.
    if (ctx.waiting_message?.message_id === replyMsgId) {
      ctx.waiting_message = undefined;
    }
  }

  return messageIds;
}

/** Handle the case when AI returned empty text and no multi_message was used */
async function handleEmptyText(
  ctx: WrapperContext,
  steps: Array<{ toolCalls: Array<{ toolName: string }> }>,
  config: { onLog?: (entry: BotLogEntry) => void | Promise<void> },
  chatBotMsgIds: number[],
  chatId: number,
  userId: number,
  finishReason: string,
): Promise<void> {
  const hasVisibleAction = steps.some((s) =>
    s.toolCalls.some((tc) => VISIBLE_EFFECT_TOOL_NAMES.has(tc.toolName)),
  );
  if (hasVisibleAction) {
    await ctx.deleteWaiting();
  } else {
    config.onLog?.({
      level: "warn",
      message: "AI returned empty text",
      meta: { chatId, userId, finishReason },
    });
    const replyMsgId = await safeReply(ctx, "(AI 未生成回复内容)");
    if (replyMsgId) chatBotMsgIds.push(replyMsgId);
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
  github_repository: "🐙 查看 GitHub 仓库...",
  github_read_file: "🐙 读取仓库代码...",
  github_list_tree: "🐙 查看代码结构...",
  github_list_issues: "🐙 查看 Issue...",
  github_code_task: "🛠️ Pi 正在修改和测试代码...",
  github_push_branch: "🔐 准备分支推送确认...",
  github_create_issue: "🔐 准备 Issue 创建确认...",
  github_update_issue: "🔐 准备 Issue 更新确认...",
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
  save_received_file: "💾 保存文件...",
};

function wrapToolsWithStatus(
  tools: Record<string, Tool>,
  ctx: WrapperContext,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
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
          await ctx.resolveWait(status).catch(() => {});
        } else {
          await ctx.wait(status).catch(() => {});
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
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";

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

function getDisplayName(from: User | undefined): string {
  if (!from) return "Unknown";
  if (from.first_name && from.last_name) return `${from.first_name} ${from.last_name}`;
  return from.first_name || from.username || "Unknown";
}

function describeFiles(
  files: ReceivedFile[],
  prefix = "",
  separator = "\n",
  descriptionsByIndex?: Map<number, string>,
): string {
  let result = "";
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const sizeStr = f.file_size ? ` ${formatFileSize(f.file_size)}` : "";
    if (f.type === "photo" || f.mime_type?.startsWith("image/")) {
      const desc = descriptionsByIndex?.get(i);
      const descStr = desc ? ` | 描述: ${desc}` : "";
      if (f.type === "photo") {
        result += `[${prefix}图片${sizeStr}${descStr}]${separator}`;
      } else {
        const nameStr = f.file_name ? ` "${f.file_name}"` : "";
        const typeStr = f.mime_type ? ` (${f.mime_type})` : "";
        result += `[${prefix}文件${nameStr}${typeStr}${sizeStr}${descStr}]${separator}`;
      }
    } else {
      const nameStr = f.file_name ? ` "${f.file_name}"` : "";
      const typeStr = f.mime_type ? ` (${f.mime_type})` : "";
      result += `[${prefix}文件${nameStr}${typeStr}${sizeStr}]${separator}`;
    }
  }
  return result;
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
  getPendingGitHubActions(): PendingGitHubActionRegistry;
  getContinueChatConfig(chatId?: number): ContinueChatConfig;
  isPrivateChat(chatId: number): boolean;
}

const MAX_RECENT_BOT_MESSAGES = 20;
const MOOD_EXPIRE_MS = 60 * 60 * 1000; // 1 hour

export function createAiReplyHandler(config: AiReplyConfig): {
  handler: Middleware<BotContext>;
  state: BotRuntimeState;
  setModelForChat: (chatId: number, modelId: string) => void;
  getModelForChat: (chatId: number) => string;
  resetModelForChat: (chatId: number) => void;
  setProviderForChat: (chatId: number, providerId: string) => void;
  getProviderForChat: (chatId: number) => string;
  resetProviderForChat: (chatId: number) => void;
  getProvidersList: () => Array<{ id: string; label: string; defaultModel: string }>;
  getModelsForChat: (chatId: number) => ModelEntry[];
  getReplyMode: () => ReplyMode;
  setReplyMode: (mode: ReplyMode) => void;
  getRichMessageEnabled: () => boolean;
  setRichMessageEnabled: (enabled: boolean) => Promise<void>;
  getImageGenEnabled: (chatId: number) => boolean;
  setImageGenEnabled: (chatId: number, enabled: boolean) => void;
  getPixaiFullConfig: () => { model: string | undefined; pixaiConfig: PixAIConfig };
  updatePixaiConfig: (updates: {
    model?: string;
    pixaiConfig?: Partial<PixAIConfig>;
  }) => void | Promise<void>;
  updateWebToolApiKey: (target: "image" | "search", apiKey: string) => Promise<boolean>;
  getPixaiRateLimitStats: () => RateLimitStats;
  canUseImageGeneration: (isPrivate: boolean, isAdmin: boolean, chatId: number) => boolean;
  directGenerate: (
    rawPrompt: string,
    overrides: DrawOverrides,
    chatId: number,
    userId?: number,
  ) => Promise<DirectGenerateResult>;
  fireTimerEvent: (chatId: number, timerId: string, reason: string) => void;
  isAiEnabled: () => boolean;
  setAiEnabled: (enabled: boolean) => number;
  destroy: () => void;
} {
  const cooldownMap = new Map<number, number>();

  // Bot-wide AI kill switch (in-memory). /stop flips aiDisabled=true and aborts
  // all in-flight streamText calls via the registered controllers.
  let aiDisabled = false;
  const activeAbortControllers = new Set<AbortController>();

  function isAiEnabled(): boolean {
    return !aiDisabled;
  }

  function setAiEnabled(enabled: boolean): number {
    if (enabled) {
      aiDisabled = false;
      return 0;
    }
    aiDisabled = true;
    const toAbort = [...activeAbortControllers];
    activeAbortControllers.clear();
    for (const c of toAbort) {
      c.abort(new Error("AI disabled by /stop"));
    }
    return toAbort.length;
  }

  // Per-chat model override (in-memory fallback)
  const chatModelMap = new Map<number, string>();

  function getModelForChat(chatId: number): string {
    // Per-chat model override wins; otherwise fall back to the active provider's default model.
    const providerDefault = getProviderRuntimeForChat(chatId).defaultModel || config.model;
    if (config.modelOverride) {
      return config.modelOverride.getModelForChat(chatId) ?? providerDefault;
    }
    return chatModelMap.get(chatId) ?? providerDefault;
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

  // Reply mode runtime override (takes precedence over config)
  let replyModeOverride: ReplyMode | undefined;

  function getEffectiveMessageConfig(): MessageConfig {
    const base = { ...DEFAULT_MESSAGE_CONFIG, ...config.messageConfig };
    if (replyModeOverride !== undefined) {
      return { ...base, replyMode: replyModeOverride };
    }
    return base;
  }

  async function setRichMessageEnabled(enabled: boolean): Promise<void> {
    await config.onMessageConfigUpdate?.({ richMessageEnabled: enabled });
    config.messageConfig = {
      ...DEFAULT_MESSAGE_CONFIG,
      ...config.messageConfig,
      richMessageEnabled: enabled,
    };
  }

  function canUseImageGeneration(isPrivate: boolean, isAdmin: boolean, chatId: number): boolean {
    if (isAdmin) return true;
    if (isPrivate) return false;
    return getImageGenEnabled(chatId);
  }

  function getImageGenEnabled(chatId: number): boolean {
    return config.groupOverrides[String(chatId)]?.imageGenerationEnabled === true;
  }

  function setImageGenEnabled(chatId: number, enabled: boolean): void {
    const key = String(chatId);
    const existing = config.groupOverrides[key];
    if (existing) {
      existing.imageGenerationEnabled = enabled;
    } else {
      config.groupOverrides[key] = { chatId, whitelisted: false, imageGenerationEnabled: enabled };
    }
    config.onGroupOverrideUpdate?.(chatId, config.groupOverrides[key]!);
  }

  function getPixaiFullConfig(): { model: string | undefined; pixaiConfig: PixAIConfig } {
    const imgCfg = config.webToolsConfig?.imageGeneration;
    return {
      model: imgCfg?.model,
      pixaiConfig: imgCfg?.pixaiConfig ?? {},
    };
  }

  // PixAI rate limiter (per-bot singleton, must be declared before updatePixaiConfig)
  const pixaiRateLimiter = new PixAIRateLimiter(
    config.webToolsConfig?.imageGeneration?.pixaiConfig?.rateLimit,
  );

  async function updatePixaiConfig(updates: {
    model?: string;
    pixaiConfig?: Partial<PixAIConfig>;
  }): Promise<void> {
    const imgCfg = config.webToolsConfig?.imageGeneration;
    if (!imgCfg) return;

    if (updates.model !== undefined) imgCfg.model = updates.model;
    if (updates.pixaiConfig) {
      // Deep-merge rateLimit to preserve existing fields
      const { rateLimit: rlUpdate, ...rest } = updates.pixaiConfig;
      imgCfg.pixaiConfig = { ...imgCfg.pixaiConfig, ...rest };
      if (rlUpdate) {
        imgCfg.pixaiConfig.rateLimit = { ...imgCfg.pixaiConfig.rateLimit, ...rlUpdate };
        pixaiRateLimiter.updateConfig(rlUpdate);
      }
    }
    await config.onPixaiConfigUpdate?.(updates);
  }

  async function updateWebToolApiKey(target: "image" | "search", apiKey: string): Promise<boolean> {
    const webToolsConfig = config.webToolsConfig;
    if (!webToolsConfig) return false;

    const targetConfig =
      target === "image" ? webToolsConfig.imageGeneration : webToolsConfig.search;
    if (!targetConfig) return false;

    await config.onWebToolApiKeyUpdate?.(target, apiKey);
    targetConfig.apiKey = apiKey;
    if (webToolsConfig.enabled) {
      webTools = createWebTools({ config: webToolsConfig, timeoutConfig: config.timeoutConfig });
    }
    return true;
  }

  // Provider registry: prefer config.providers; fall back to legacy top-level fields.
  // Synthesizes a single "__legacy__" entry when providers[] not supplied so all downstream
  // code paths can uniformly look up by id.
  const providerRegistry = new Map<string, AiProviderRuntime>();
  if (config.providers && config.providers.length > 0) {
    for (const p of config.providers) providerRegistry.set(p.id, p);
  } else {
    providerRegistry.set("__legacy__", {
      id: "__legacy__",
      label: "Default",
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      providerFormat: config.providerFormat ?? "openai",
      defaultModel: config.model,
      models: config.models,
    });
  }
  const fallbackProviderId =
    config.activeProviderId && providerRegistry.has(config.activeProviderId)
      ? config.activeProviderId
      : providerRegistry.keys().next().value!;

  // Lazy-build LanguageModel factory per provider id (cached).
  const providerClientCache = new Map<string, (modelId: string) => LanguageModel>();
  function getProviderClient(providerId: string): (modelId: string) => LanguageModel {
    const cached = providerClientCache.get(providerId);
    if (cached) return cached;
    const entry = providerRegistry.get(providerId) ?? providerRegistry.get(fallbackProviderId)!;
    const factory: (modelId: string) => LanguageModel =
      entry.providerFormat === "gemini"
        ? createGoogleGenerativeAI({ baseURL: entry.baseURL, apiKey: entry.apiKey })
        : createOpenAICompatible({ name: "custom", baseURL: entry.baseURL, apiKey: entry.apiKey });
    providerClientCache.set(providerId, factory);
    return factory;
  }

  // In-memory per-chat provider override (used when persistent callback not supplied).
  const chatProviderMap = new Map<number, string>();

  function getProviderIdForChat(chatId: number): string {
    const override =
      config.providerOverride?.getProviderForChat(chatId) ?? chatProviderMap.get(chatId);
    if (override && providerRegistry.has(override)) return override;
    return fallbackProviderId;
  }

  function getProviderRuntimeForChat(chatId: number): AiProviderRuntime {
    const id = getProviderIdForChat(chatId);
    return providerRegistry.get(id) ?? providerRegistry.get(fallbackProviderId)!;
  }

  function setProviderForChat(chatId: number, providerId: string) {
    if (!providerRegistry.has(providerId)) return;
    if (config.providerOverride) {
      config.providerOverride.setProviderForChat(chatId, providerId);
    } else {
      chatProviderMap.set(chatId, providerId);
    }
  }

  function resetProviderForChat(chatId: number) {
    if (config.providerOverride) {
      config.providerOverride.resetProviderForChat(chatId);
    } else {
      chatProviderMap.delete(chatId);
    }
  }

  function getProvidersList(): Array<{ id: string; label: string; defaultModel: string }> {
    return Array.from(providerRegistry.values()).map((p) => ({
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
    }));
  }

  /** Per-chat provider client factory (what the old singleton `provider` used to be). */
  function getProviderClientForChat(chatId: number): (modelId: string) => LanguageModel {
    return getProviderClient(getProviderIdForChat(chatId));
  }

  // Memory tools setup
  const memoryCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  let memoryTools: Record<string, Tool> | undefined;
  let profileObserver: TelegramProfileObserver | undefined;
  if (memoryCfg.enabled && config.memory) {
    memoryTools = createMemoryTools(config.memory);
    if (memoryCfg.autoUpdateLastSeen) {
      profileObserver = new TelegramProfileObserver({
        memory: config.memory,
        token: config.token,
        dataDir: config.dataFiles?.dataDir,
        onError: (error) =>
          config.onLog?.({
            level: "error",
            message: `Profile avatar refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
    }
  }

  // Bot memory tools setup
  const botMemoryCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
  let botMemoryTools: Record<string, Tool> | undefined;
  if (botMemoryCfg.enabled && config.botMemory) {
    botMemoryTools = createBotMemoryTools(config.botMemory);
  }

  // Web tools setup (singleton, not per-request)
  let webTools: Record<string, Tool> | undefined;
  if (config.webToolsConfig?.enabled) {
    webTools = createWebTools({
      config: config.webToolsConfig,
      timeoutConfig: config.timeoutConfig,
    });
  }

  // File tools setup (singleton, not per-request)
  let fileTools: Record<string, Tool> | undefined;
  if (config.dataFiles) {
    fileTools = createFileTools({
      dataDir: config.dataFiles.dataDir,
      protectedFiles: config.dataFiles.injectableFiles,
    });
  }

  // Per-chat recently received files (for save_received_file tool)
  const recentReceivedFiles = new Map<number, ReceivedFile[]>();

  // Recent bot message IDs per chat (for edit/delete tools)
  const recentBotMessageIds = new Map<number, number[]>();

  // Mood state per chat
  const moodState = new Map<number, MoodInfo>();

  // Pending actions registry for interactive tools
  const pendingActions = new PendingActionRegistry();
  const pendingGitHubActions = new PendingGitHubActionRegistry();

  // Track known private chats
  const knownPrivateChats = new Set<number>();

  // Last saved system prompt per chat (dedup: skip saving identical prompts)
  // Capped at 500 entries to prevent unbounded growth; cleared when full.
  const lastSystemContent = new Map<number, string>();
  const SYSTEM_CONTENT_CAP = 500;

  // Bot API reference: initialized eagerly if provided, otherwise captured on first request
  let botApi: Api | undefined = config.initialApi;

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

  function buildProviderOptions(
    entry?: ModelEntry,
    providerFormat?: "openai" | "gemini",
  ): Record<string, Record<string, JSONValue>> | undefined {
    if (!entry?.thinking) return undefined;
    const enabled = entry.thinking === "enabled";
    if ((providerFormat ?? config.providerFormat) === "gemini") {
      return {
        google: {
          thinkingConfig: {
            thinkingBudget: enabled ? (entry.thinkingBudget ?? -1) : 0,
            includeThoughts: enabled,
          },
        },
      };
    }
    const thinking: Record<string, JSONValue> = { type: entry.thinking };
    if (entry.thinkingBudget != null) thinking.budget_tokens = entry.thinkingBudget;
    return { custom: { thinking } };
  }

  function buildContinueChatConfig(chatId?: number): ContinueChatConfig {
    const modelId = chatId != null ? getModelForChat(chatId) : config.model;
    const providerRuntime =
      chatId != null
        ? getProviderRuntimeForChat(chatId)
        : (providerRegistry.get(fallbackProviderId) ?? providerRegistry.values().next().value!);
    const models = providerRuntime.models ?? config.models;
    const modelEntry = models?.find((m) => m.id === modelId);
    const providerFactory =
      chatId != null ? getProviderClientForChat(chatId) : getProviderClient(fallbackProviderId);
    // Telegram: private chat IDs are positive, group/supergroup IDs are negative
    const imageGenerationAllowed =
      chatId != null
        ? canUseImageGeneration(
            chatId > 0 || knownPrivateChats.has(chatId),
            config.adminChatIds.includes(chatId),
            chatId,
          )
        : false;
    return {
      model: providerFactory(modelId),
      modelId,
      temperature: modelEntry?.temperature,
      maxTokens: modelEntry?.maxTokens,
      providerOptions: buildProviderOptions(modelEntry, providerRuntime.providerFormat),
      isAiDisabled: () => aiDisabled,
      registerAbortController: (c) => activeAbortControllers.add(c),
      unregisterAbortController: (c) => activeAbortControllers.delete(c),
      systemPrompt: config.systemPrompt,
      behavioralPrompt: config.behavioralPrompt,
      conversationConfig: config.conversationConfig,
      conversation: config.conversation,
      memoryConfig: config.memoryConfig,
      memory: config.memory,
      botMemoryConfig: config.botMemoryConfig,
      botMemory: config.botMemory,
      messageConfig: getEffectiveMessageConfig(),
      webToolsConfig: config.webToolsConfig,
      agentToolsConfig: config.agentToolsConfig,
      artworkToolsConfig: config.artworkToolsConfig,
      timeoutConfig: config.timeoutConfig,
      webTools,
      agentToolsFactory: config.agentToolsConfig?.enabled
        ? () =>
            createAgentTools({
              provider: (m) => providerFactory(m),
              model: modelId,
              agentConfig: config.agentToolsConfig!,
              webToolsConfig: config.webToolsConfig,
              onLog: config.onLog,
              timeoutConfig: config.timeoutConfig,
            })
        : undefined,
      dataFiles: config.dataFiles,
      pendingActions,
      recentBotMessageIds,
      moodState,
      stickerPacks: config.stickerPacks,
      onTimerFired,
      onTimerCreate: config.onTimerCreate,
      onTimerCancel: config.onTimerCancel,
      onTimerFiredPersist: config.onTimerFiredPersist,
      onLog: config.onLog,
      onTokenUsage: config.onTokenUsage,
      onGenerationTrack: config.onGenerationTrack,
      imageGenerationAllowed,
      rateLimiter: pixaiRateLimiter,
      adminIds: config.adminChatIds,
      rssCallbacks: config.rssCallbacks,
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
    // Clean rate limiter expired state
    pixaiRateLimiter.cleanup();
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
  const groupContextPersistence = new GroupContextPersistenceTracker();

  const bufferCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of groupBuffers) {
      if (now - entry.lastActive > BUFFER_STALE_MS) {
        groupBuffers.delete(chatId);
        groupContextPersistence.clearChat(chatId);
      }
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
    getPendingGitHubActions: () => pendingGitHubActions,
    getContinueChatConfig: (cid) => buildContinueChatConfig(cid),
    isPrivateChat: (chatId) => knownPrivateChats.has(chatId),
  };

  const handler: Middleware<BotContext> = async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) return next();

    // Skip commands
    const entities = msg.entities ?? [];
    if (entities.some((e) => e.type === "bot_command" && e.offset === 0)) {
      return next();
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    const isPrivate = ctx.chat?.type === "private";
    const userId = ctx.from?.id;
    if (!userId) return next();

    const isAdmin = config.adminChatIds.includes(userId);
    const userName = getDisplayName(ctx.from);

    let effectivePrompt = config.systemPrompt;
    let triggerResult: TriggerResult = false;
    let groupConversationEnabled = conversationCfg.enabled;
    let groupMaxContext = conversationCfg.maxContextMessages;
    let groupTriggerConfig = config.triggerConfig;

    if (isPrivate) {
      if (!isAdmin && !config.privateChatWhitelist?.includes(userId)) return next();
    } else {
      const groupCfg = resolveGroupConfig(config, chatId);
      if (!groupCfg.enabled) return next();
      if (!groupCfg.whitelisted && !isAdmin) return next();

      effectivePrompt = groupCfg.systemPrompt;
      groupConversationEnabled = groupCfg.conversationEnabled;
      groupMaxContext = groupCfg.maxContextMessages;
      groupTriggerConfig = groupCfg.triggerConfig;
    }

    if (ctx.from) profileObserver?.observe(ctx.api, ctx.from);

    const supportsAiContent = !!(msg.text || msg.photo || msg.document);
    if (!supportsAiContent || aiDisabled) return next();

    // Capture API reference and track private chats for event handlers
    botApi = ctx.api;
    if (isPrivate) knownPrivateChats.add(chatId);

    // Push to ring buffer for group chats (before trigger check)
    if (!isPrivate) {
      const buffer = getOrCreateBuffer(chatId);
      const bufferText =
        msg.text ??
        msg.caption ??
        (msg.photo
          ? "[图片]"
          : msg.document
            ? `[文件: ${msg.document.file_name ?? "unknown"}]`
            : "");
      if (bufferText) {
        buffer.push({
          messageId: msg.message_id,
          userId,
          userName,
          text: bufferText,
          timestamp: Date.now(),
        });
      }
    }

    triggerResult = isPrivate
      ? "reply"
      : checkTrigger(ctx, groupTriggerConfig, chatId, cooldownMap);
    if (!triggerResult) return next();

    // Determine if conversation history is enabled
    const useConversation =
      config.conversation && (isPrivate ? conversationCfg.enabled : groupConversationEnabled);

    // Hoisted so the outer finally can unregister even on early errors.
    let manualAbort: AbortController | null = null;
    let releaseChatLock: (() => void) | null = null;
    try {
      // Shared per-chat lock: mutually exclusive with timer-driven continueChat
      // so their streamText runs never race over recentBotMessageIds/moodState/history.
      releaseChatLock = await acquireChatLock(chatId);
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
        messageId: msg.message_id,
        stickerCache,
        onceGuard,
      });

      // Extract received files metadata
      const receivedFiles = extractFilesFromMessage(msg);
      if (receivedFiles.length) {
        recentReceivedFiles.set(chatId, receivedFiles);
      }
      const messageText = msg.text ?? msg.caption ?? "";

      // Extract reply-to message metadata
      const replyMsg = ctx.reply_to_message;
      const replyFiles = extractFilesFromMessage(replyMsg);
      const replyText = replyMsg?.text ?? replyMsg?.caption ?? "";

      // Create per-request telegram tools
      const telegramTools = createTelegramTools({
        api: ctx.api,
        chatId,
        recentBotMessageIds: chatBotMsgIds,
        pendingActions,
        onTimerFired,
        onTimerCreate: config.onTimerCreate,
        onTimerCancel: config.onTimerCancel,
        onTimerFiredPersist: config.onTimerFiredPersist,
        onceGuard,
        dataDir: config.dataFiles?.dataDir,
        token: config.token,
        receivedFiles: recentReceivedFiles.get(chatId),
        timeoutConfig: config.timeoutConfig,
      });

      // Create per-request behavior tools
      const behaviorTools = createBehaviorTools({
        api: ctx.api,
        chatId,
        recentBotMessageIds: chatBotMsgIds,
        moodState,
        richMessageEnabled: isRichMessageEnabled(getEffectiveMessageConfig()),
        onLog: config.onLog,
        onceGuard,
      });

      // Resolve model + provider for this chat
      const currentModel = getModelForChat(chatId);
      const currentProviderRuntime = getProviderRuntimeForChat(chatId);
      const currentProviderFactory = getProviderClientForChat(chatId);

      // Create agent tools if enabled
      let agentTools: Record<string, Tool> = {};
      if (config.agentToolsConfig?.enabled) {
        agentTools = createAgentTools({
          provider: (m) => currentProviderFactory(m),
          model: currentModel,
          agentConfig: config.agentToolsConfig,
          webToolsConfig: config.webToolsConfig,
          onLog: config.onLog,
          timeoutConfig: config.timeoutConfig,
        });
      }

      let githubTools: Record<string, Tool> = {};
      if (
        config.githubToolsConfig?.enabled &&
        (isAdmin || config.githubToolsConfig.publicReadEnabled)
      ) {
        githubTools = createGitHubTools({
          config: config.githubToolsConfig,
          isAdmin,
          userId,
          chatId,
          api: ctx.api,
          pendingActions: pendingGitHubActions,
          codeCallbacks: config.githubCodeCallbacks,
          codingModel: buildGitHubCodingModelConfig(currentProviderRuntime, currentModel),
        });
      }

      // Create artwork tools if enabled
      let artworkTools: Record<string, Tool> = {};
      if (config.artworkToolsConfig?.enabled) {
        artworkTools = createArtworkTools({
          api: ctx.api,
          chatId,
          recentBotMessageIds: chatBotMsgIds,
          config: config.artworkToolsConfig,
          onceGuard,
          timeoutConfig: config.timeoutConfig,
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

      // --- Download images for vision / OCR ---
      const hasVision = inferCapabilities(currentModel).includes("vision");
      const ocrEnabled = !!config.imageOcrConfig?.enabled;
      const needImages = hasVision || ocrEnabled;
      const imageDownloadTimeout =
        config.timeoutConfig?.imageDownloadMs ?? DEFAULT_TIMEOUT_CONFIG.imageDownloadMs;
      const [imageBuffers, replyImageBuffers] = await Promise.all([
        needImages && receivedFiles.length
          ? downloadImagesForVision(ctx.api, config.token, receivedFiles, imageDownloadTimeout)
          : [],
        needImages && replyFiles.length
          ? downloadImagesForVision(ctx.api, config.token, replyFiles, imageDownloadTimeout)
          : [],
      ]);

      // --- Run OCR on downloaded images (only for current-message files, not replies) ---
      const ocrDescriptions = new Map<number, string>();
      if (ocrEnabled && config.imageOcrConfig && imageBuffers.length > 0) {
        try {
          const ocrResults = await describeImages({
            botId: config.botId,
            chatId,
            userId,
            images: imageBuffers.map((b) => ({ buffer: b.buffer, mimeType: b.mimeType })),
            config: config.imageOcrConfig,
            providers: config.providers,
            activeProviderId: config.activeProviderId,
            logger: {
              debug: (o, m) => {
                config.onLog?.({
                  level: "debug",
                  message: `[image-ocr] ${m ?? ""}`,
                  meta: o as Record<string, unknown>,
                });
              },
              info: (o, m) => {
                config.onLog?.({
                  level: "info",
                  message: `[image-ocr] ${m ?? ""}`,
                  meta: o as Record<string, unknown>,
                });
              },
              warn: (o, m) => {
                config.onLog?.({
                  level: "warn",
                  message: `[image-ocr] ${m ?? ""}`,
                  meta: o as Record<string, unknown>,
                });
              },
            },
            onTokenUsage: config.onTokenUsage,
          });
          const skipCounts: Record<string, number> = {};
          let ok = 0;
          for (let i = 0; i < ocrResults.length; i++) {
            const res = ocrResults[i]!;
            const sourceIndex = imageBuffers[i]?.sourceIndex;
            if (res.description && sourceIndex != null) {
              ocrDescriptions.set(sourceIndex, res.description);
              ok++;
            } else if (res.skipReason) {
              skipCounts[res.skipReason] = (skipCounts[res.skipReason] ?? 0) + 1;
            }
          }
          config.onLog?.({
            level: "info",
            message: `[image-ocr] processed ${imageBuffers.length} image(s): ${ok} ok, skips=${JSON.stringify(skipCounts)}`,
            meta: { chatId, ok, skipCounts },
          });
        } catch (err) {
          config.onLog?.({
            level: "warn",
            message: `[image-ocr] describeImages threw: ${err instanceof Error ? err.message : String(err)}`,
            meta: { chatId },
          });
        }
      }

      // --- Build text description (always needed for history and non-vision) ---
      const attachmentDesc = describeFiles(receivedFiles, "收到", "\n", ocrDescriptions);

      // --- Build reply-to context description ---
      let replyContextDesc = "";
      if (replyMsg) {
        const replyFileDesc = describeFiles(replyFiles, "", " ");
        const replyContent = `${replyFileDesc}${replyText}`.trim();
        if (replyContent) {
          replyContextDesc = `[回复 ${getDisplayName(replyMsg.from)} 的消息: ${replyContent}]\n`;
        }
      }

      const rawContent = `${replyContextDesc}${attachmentDesc}${messageText}`.trim();
      const textContent = !isPrivate ? `[${userName}]: ${rawContent}` : rawContent;

      // Build context after OCR/file enrichment so automatic memory retrieval sees
      // the same textual request that is persisted and sent to the model.
      const promptBundle = await assembleContext({
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
        retrievalQuery: rawContent || messageText,
        currentMood: moodState.get(chatId),
        stickerPacks: config.stickerPacks,
        webToolsConfig: config.webToolsConfig,
        webTools,
        agentToolsConfig: config.agentToolsConfig,
        artworkToolsEnabled: config.artworkToolsConfig?.enabled,
        hasFileTools: !!fileTools,
        dataFiles: config.dataFiles,
        messageConfig: getEffectiveMessageConfig(),
      });

      // --- Assemble final user message (multimodal or text-only) ---
      const allImageBuffers = [...replyImageBuffers, ...imageBuffers];
      let currentRequest: UserModelMessage;
      if (allImageBuffers.length > 0) {
        const parts: UserModelMessage["content"] = allImageBuffers.map((img) => ({
          type: "image" as const,
          image: img.buffer,
          mimeType: img.mimeType,
        }));
        parts.push({ type: "text" as const, text: textContent || "用户发送了一张图片" });
        currentRequest = { role: "user", content: parts };
      } else {
        currentRequest = { role: "user", content: textContent };
      }
      const { messages, trace: promptTrace } = appendCurrentRequest(promptBundle, currentRequest);

      // Combine all tools
      const allTools: Record<string, Tool> = {
        ...memoryTools,
        ...botMemoryTools,
        ...actionTools,
        ...telegramTools,
        ...behaviorTools,
        ...webTools,
        ...agentTools,
        ...githubTools,
        ...artworkTools,
        ...fileTools,
      };

      // RSS tools (per-request: depends on chatId)
      if (config.rssCallbacks) {
        const rssTools = createRssTools({
          ...config.rssCallbacks,
          chatId,
          adminChatIds: config.adminChatIds,
        });
        Object.assign(allTools, rssTools);
      }

      // MCP tools (external MCP server tools, resolved dynamically per request)
      if (config.mcpTools) {
        const mcpTools = createMcpTools(config.mcpTools, { includeAdminTools: isAdmin });
        const mcpToolKeys = Object.keys(mcpTools);
        if (mcpToolKeys.length > 0) {
          Object.assign(allTools, mcpTools);
          config.onLog?.({
            level: "info",
            message: `MCP tools injected: ${mcpToolKeys.join(", ")}`,
          });
        } else {
          config.onLog?.({
            level: "warn",
            message: "MCP config present but no tools available (servers may be disconnected)",
          });
        }
      }

      // PixAI image generation (per-request, fire-and-forget) + permission control + rate limiting
      injectPixAITool(allTools, {
        allowed: canUseImageGeneration(isPrivate, isAdmin, chatId),
        webToolsConfig: config.webToolsConfig,
        api: ctx.api,
        chatId,
        userId: ctx.from?.id,
        recentBotMessageIds: chatBotMsgIds,
        timeoutConfig: config.timeoutConfig,
        onLog: config.onLog,
        onGenerationTrack: config.onGenerationTrack,
        rateLimiter: pixaiRateLimiter,
        adminIds: config.adminChatIds,
        nsfwChecker: config.nsfwChecker,
      });

      // Stream mode and segment mode are mutually exclusive:
      // - Stream: multi_message is removed; private chats use the configured draft format
      // - Segment: multi_message is available; AI sends messages via tool, no streaming
      const msgCfg = getEffectiveMessageConfig();
      const isStreamMode = isStreamReplyMode(msgCfg);
      const richMessageEnabled = isRichMessageEnabled(msgCfg);
      if (isStreamMode) {
        delete allTools.multi_message;
      }

      // Increase maxSteps when agent tools, web tools, or artwork tools are available
      const baseMaxSteps = memoryCfg.maxSteps || 3;
      const hasAdvancedTools =
        config.agentToolsConfig?.enabled ||
        config.githubToolsConfig?.enabled ||
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
          providerId: currentProviderRuntime.id,
          providerLabel: currentProviderRuntime.label,
          baseURL: currentProviderRuntime.baseURL,
          providerFormat: currentProviderRuntime.providerFormat,
          messagesCount: messages.length,
          systemPromptLength: messages[0]?.role === "system" ? messages[0].content.length : 0,
          staticPrefixHash: promptTrace.staticPrefixHash,
          promptSections: promptTrace.sections,
          promptEstimatedTokens: promptTrace.totalEstimatedTokens,
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
      const requestCache = createRequestCache();
      const wrappedTools = wrapToolsWithStatus(wrapToolsWithCache(allTools, requestCache), ctx);
      manualAbort = new AbortController();
      activeAbortControllers.add(manualAbort);
      const perStepAbort = createPerStepAbort(
        config.timeoutConfig?.perStepMs ?? DEFAULT_TIMEOUT_CONFIG.perStepMs,
        AbortSignal.any([
          AbortSignal.timeout(config.timeoutConfig?.aiReplyMs ?? DEFAULT_TIMEOUT_CONFIG.aiReplyMs),
          manualAbort.signal,
        ]),
      );

      // ─── streamText (ai v6 API) ───
      // In segment mode, multiMessageUsed tracks whether AI used the multi_message tool.
      // In stream mode, multi_message is deleted so this stays false.
      let multiMessageUsed = false;
      const currentProviderModels = currentProviderRuntime.models ?? config.models;
      const modelEntry = currentProviderModels?.find((m) => m.id === currentModel);
      const result = streamText({
        model: currentProviderFactory(currentModel),
        messages,
        tools: wrappedTools,
        stopWhen: stepCountIs(maxSteps),
        toolChoice,
        abortSignal: perStepAbort.signal,
        temperature: modelEntry?.temperature,
        maxOutputTokens: modelEntry?.maxTokens,
        providerOptions: buildProviderOptions(modelEntry, currentProviderRuntime.providerFormat),
        experimental_onToolCallStart: () => perStepAbort.pause(),
        experimental_onToolCallFinish: () => perStepAbort.resume(),
        onStepFinish: ({ toolCalls, toolResults }) => {
          stepCounter++;
          perStepAbort.reset();
          if (toolCalls?.length) {
            for (const tc of toolCalls) {
              if (!isStreamMode && tc.toolName === "multi_message") multiMessageUsed = true;
              config.onLog?.({
                level: "debug",
                message: "AI tool call",
                meta: {
                  step: stepCounter,
                  toolName: tc.toolName,
                  args: truncate(tc.input),
                  toolCallId: tc.toolCallId,
                },
              });
            }
          }
          if (toolResults?.length) {
            for (const tr of toolResults as ToolResultEntry[]) {
              config.onLog?.({
                level: "debug",
                message: "AI tool result",
                meta: {
                  step: stepCounter,
                  toolName: tr.toolName,
                  result: truncate(tr.output),
                  toolCallId: tr.toolCallId,
                },
              });
            }
            if (ctx.waiting_message) {
              ctx.resolveWait("💭 回复中...").catch(() => {});
            }
          }
        },
      });

      // Track whether streaming actually sent any messages (stream mode only)
      let streamStarted = false;
      // Preserve the first stream failure. AI SDK's later `result.text` access can replace
      // it with the generic "No output generated" error, hiding the actionable provider cause.
      let capturedStreamError: unknown;
      // Track whether multi_message tool was used (segment mode only)
      let sentViaMultiMessage = false;
      const logRichFallback = (mode: "rich" | "html", error: unknown) => {
        config.onLog?.({
          level: "warn",
          message: `${mode === "rich" ? "Rich Message" : "HTML"} delivery failed, falling back`,
          meta: {
            chatId,
            userId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      };

      try {
        if (isStreamMode && ctx.chat?.type === "private") {
          // ─── Private stream mode: Rich Markdown draft + persistent Rich Message ───
          const thinkFilter = createThinkingStreamFilter(({ pattern, strippedLength }) => {
            config.onLog?.({
              level: "info",
              message: `Stripped thinking content from stream (pattern: ${pattern}, ${strippedLength} chars)`,
              meta: { chatId, userId },
            });
          });
          const metaFilter = createMetaPrefixStreamFilter(({ pattern, strippedLength }) => {
            config.onLog?.({
              level: "warn",
              message: `Stripped meta prefix from stream (pattern: ${pattern}, ${strippedLength} chars)`,
              meta: { chatId, userId },
            });
          });
          // Buffer leading whitespace so the first yield always carries a visible char.
          // Telegram draft methods reject cumulative content that trims to empty.
          let leadingBuffer = "";
          let hasVisibleContent = false;
          async function* managedTextStream() {
            const emit = async (out: string) => {
              if (out) await ctx.deleteWaiting();
            };
            for await (const chunk of result.textStream) {
              const afterThink = thinkFilter.push(chunk);
              if (!afterThink) continue;
              const filtered = metaFilter.push(afterThink);
              if (!filtered) continue;
              if (!hasVisibleContent) {
                leadingBuffer += filtered;
                if (/\S/.test(leadingBuffer)) {
                  hasVisibleContent = true;
                  await emit(leadingBuffer);
                  yield leadingBuffer;
                  leadingBuffer = "";
                }
                continue;
              }
              await emit(filtered);
              yield filtered;
            }
            const thinkFlushed = thinkFilter.flush();
            const afterThinkFlush = thinkFlushed ? metaFilter.push(thinkFlushed) : "";
            const metaFlushed = metaFilter.flush();
            const flushed = afterThinkFlush + metaFlushed;
            if (flushed) leadingBuffer += flushed;
            if (leadingBuffer && /\S/.test(leadingBuffer)) {
              hasVisibleContent = true;
              await emit(leadingBuffer);
              yield leadingBuffer;
              leadingBuffer = "";
            }
          }

          const sentMessages: Message[] = [];
          try {
            if (richMessageEnabled) {
              const thinkingShown = await showRichThinkingDraft(
                ctx.api,
                chatId,
                ctx.update.update_id,
                ctx.message?.message_thread_id,
              );
              if (thinkingShown) await ctx.deleteWaiting();
              sentMessages.push(await ctx.replyWithMarkdownStream(managedTextStream()));
            } else {
              const legacyMessages = await ctx.replyWithStream(managedTextStream());
              await formatSentMessagesHtml(ctx.api, legacyMessages);
              sentMessages.push(...legacyMessages);
            }
            streamStarted = sentMessages.length > 0;
          } catch (streamErr) {
            capturedStreamError = streamErr;
            const streamMethod = richMessageEnabled ? "replyWithMarkdownStream" : "replyWithStream";
            config.onLog?.({
              level: "warn",
              message: `${streamMethod} failed, falling back to text: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
              meta: {
                chatId,
                userId,
                errorName: streamErr instanceof Error ? streamErr.name : undefined,
                errorCause:
                  streamErr instanceof Error && streamErr.cause
                    ? String(streamErr.cause)
                    : undefined,
              },
            });
            // The draft may contain only a prefix. Wait for result.text below, then persist
            // the complete response through the same split/fallback path as group replies.
            streamStarted = false;
          }

          for (const message of sentMessages) chatBotMsgIds.push(message.message_id);
        } else {
          // ─── Segment mode and group stream mode: drain before final delivery ───
          // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional drain
          for await (const _ of result.textStream) {
          }
          sentViaMultiMessage = multiMessageUsed;
        }
      } finally {
        perStepAbort.cleanup();
      }

      // If /stop fired while streamText was running, drop all pending sends + saves.
      if (aiDisabled || manualAbort?.signal.aborted) {
        config.onLog?.({
          level: "info",
          message: "AI disabled mid-reply, dropping pending sends",
          meta: { chatId, userId },
        });
        await ctx.deleteWaiting().catch(() => {});
        return;
      }

      const rawText = await resolveCompleteStreamText(result.text, capturedStreamError);
      const afterThink = stripThinkingContent(rawText, ({ pattern, strippedLength }) => {
        config.onLog?.({
          level: "info",
          message: `Stripped thinking content from segment text (pattern: ${pattern}, ${strippedLength} chars)`,
          meta: { chatId, userId },
        });
      });
      const text = stripMetaPrefix(afterThink, ({ pattern, strippedLength }) => {
        config.onLog?.({
          level: "warn",
          message: `Stripped meta prefix from segment text (pattern: ${pattern}, ${strippedLength} chars)`,
          meta: { chatId, userId },
        });
      });
      const steps = await result.steps;
      const usage = await result.usage;
      const finishReason = await result.finishReason;

      // ─── Send final reply (when streaming/multi_message didn't handle it) ───
      if (isStreamMode && !streamStarted) {
        // Group chats cannot stream drafts. Private stream failures also land here only
        // after the complete provider result has been drained and filtered.
        if (text) {
          const messageIds = await sendFormattedChunks(
            ctx,
            text,
            msgCfg,
            richMessageEnabled,
            logRichFallback,
            () => aiDisabled || !!manualAbort?.signal.aborted,
          );
          chatBotMsgIds.push(...messageIds);
          streamStarted = messageIds.length > 0;
        } else {
          await handleEmptyText(ctx, steps, config, chatBotMsgIds, chatId, userId, finishReason);
          capturedStreamError = undefined;
        }
      } else if (!isStreamMode) {
        if (sentViaMultiMessage) {
          await ctx.deleteWaiting();
        } else if (text) {
          const messageIds = await sendFormattedChunks(
            ctx,
            text,
            msgCfg,
            richMessageEnabled,
            logRichFallback,
            () => aiDisabled || !!manualAbort?.signal.aborted,
          );
          chatBotMsgIds.push(...messageIds);
        } else {
          await handleEmptyText(ctx, steps, config, chatBotMsgIds, chatId, userId, finishReason);
        }
      }

      if (isStreamMode && isPrivate && streamStarted) {
        await ctx.deleteWaiting();
      }

      throwCapturedStreamError(capturedStreamError, streamStarted);

      const durationMs = Date.now() - startTime;

      // Debug: AI response
      const totalToolCalls = steps.reduce((n, s) => n + s.toolCalls.length, 0);
      const totalToolResults = steps.reduce((n, s) => n + s.toolResults.length, 0);
      config.onLog?.({
        level: "debug",
        message: "AI response",
        meta: {
          durationMs,
          responseLength: text?.length ?? 0,
          responsePreview: truncate(text ?? "", 200),
          totalSteps: steps.length,
          finishReason,
          usage,
          totalToolCalls,
          totalToolResults,
        },
      });

      // Record token usage
      config.onTokenUsage?.({
        chatId,
        userId,
        model: currentModel,
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        durationMs,
        trigger: triggerResult as string,
      });

      // Save messages to conversation history (before checking text emptiness)
      if (useConversation) {
        const toSave: Array<{
          chatId: number;
          role: ConversationRole;
          content: string;
          userId?: number;
          userName?: string;
          sourceKey?: string;
          meta?: Record<string, unknown>;
        }> = [];
        const sourcePrefix = `telegram:${msg.message_id}`;
        let contextSavedThrough: number | undefined;

        // Save system prompt used for this reply (deduplicated per chat)
        const sysMsg = messages.find((m) => m.role === "system")?.content;
        if (typeof sysMsg === "string" && sysMsg) {
          const prev = lastSystemContent.get(chatId);
          if (prev !== sysMsg) {
            if (lastSystemContent.size >= SYSTEM_CONTENT_CAP) lastSystemContent.clear();
            lastSystemContent.set(chatId, sysMsg);
            toSave.push({
              chatId,
              role: "system" as ConversationRole,
              content: sysMsg,
              sourceKey: `${sourcePrefix}:system`,
              meta: { model: currentModel, trigger: triggerResult },
            });
          }
        }

        // Save group context if configured
        if (!isPrivate) {
          const shouldSaveContext =
            conversationCfg.saveGroupContext === "all" ||
            (conversationCfg.saveGroupContext === "random_only" && triggerResult === "random");

          if (shouldSaveContext) {
            const buffer = groupBuffers.get(chatId);
            if (buffer) {
              const allMessages = buffer.buffer.getAll();
              const contextMessages = groupContextPersistence.selectUnsavedContext(
                chatId,
                msg.message_id,
                allMessages,
              );
              if (contextMessages.length > 0) {
                contextSavedThrough = contextMessages.at(-1)!.messageId;
                toSave.push({
                  chatId,
                  role: "context",
                  content: formatGroupContextMessages(contextMessages),
                  sourceKey: `${sourcePrefix}:context`,
                });
              }
            }
          }
        }

        // Save user message (text only, no image data)
        toSave.push({
          chatId,
          role: "user",
          content: rawContent || messageText,
          userId,
          userName,
          sourceKey: `${sourcePrefix}:user`,
          meta: { tgMessageId: msg.message_id },
        });

        // Save all tool calls and results from steps
        for (const step of steps) {
          for (const tc of step.toolCalls) {
            toSave.push({
              chatId,
              role: "tool_call",
              content: tc.toolName,
              sourceKey: `${sourcePrefix}:tool-call:${tc.toolCallId}`,
              meta: {
                toolName: tc.toolName,
                args: JSON.stringify(tc.input),
                toolCallId: tc.toolCallId,
              },
            });
          }
          for (const tr of step.toolResults as ToolResultEntry[]) {
            toSave.push({
              chatId,
              role: "tool_result",
              content:
                typeof tr.output === "string"
                  ? tr.output
                  : (JSON.stringify(tr.output) ?? String(tr.output)),
              sourceKey: `${sourcePrefix}:tool-result:${tr.toolCallId}`,
              meta: {
                toolName: tr.toolName,
                toolCallId: tr.toolCallId,
              },
            });
          }
        }

        // Save assistant reply with usage meta (even if empty text).
        // When multi_message handled the reply, the final `text` was discarded (never sent),
        // so persist what actually went out — aggregated multi_message payloads — to keep
        // conversation history consistent with what the user saw.
        let assistantContent = text || "";
        if (sentViaMultiMessage) {
          const parts: string[] = [];
          for (const step of steps) {
            for (const tc of step.toolCalls) {
              if (tc.toolName !== "multi_message") continue;
              const input = tc.input as { messages?: Array<{ text?: string }> } | undefined;
              if (input?.messages) {
                for (const m of input.messages) {
                  if (!m.text) continue;
                  const clean = stripMetaPrefix(stripThinkingContent(m.text));
                  if (clean) parts.push(clean);
                }
              }
            }
          }
          if (parts.length) assistantContent = parts.join("\n");
          else assistantContent = "";
          if (text) {
            config.onLog?.({
              level: "warn",
              message: `multi_message used but model emitted ${text.length} trailing chars; dropped (not sent, not saved)`,
              meta: { chatId, userId, droppedPreview: truncate(text, 200) },
            });
          }
        }
        toSave.push({
          chatId,
          role: "assistant",
          content: assistantContent,
          sourceKey: `${sourcePrefix}:assistant`,
          meta: {
            model: currentModel,
            trigger: triggerResult,
            usage,
          },
        });

        config
          .conversation!.addMessages(toSave)
          .then(() => {
            if (!isPrivate && conversationCfg.saveGroupContext !== "none") {
              const bufferedMessageIds =
                groupBuffers
                  .get(chatId)
                  ?.buffer.getAll()
                  .map((message) => message.messageId) ?? [];
              groupContextPersistence.commitReply(
                chatId,
                msg.message_id,
                contextSavedThrough,
                bufferedMessageIds,
              );
            }
            config.conversation!.triggerCompression(chatId);
          })
          .catch((err) => {
            config.onLog?.({
              level: "error",
              message: `Failed to save conversation: ${err instanceof Error ? err.message : String(err)}`,
              meta: { chatId },
            });
          });
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
        await directlyReplyAndCleanup(ctx, errorReply);
      }
    } finally {
      releaseChatLock?.();
      if (manualAbort) activeAbortControllers.delete(manualAbort);
    }
  };

  function buildDirectGenerate() {
    return (
      rawPrompt: string,
      overrides: DrawOverrides,
      chatId: number,
      userId?: number,
    ): Promise<DirectGenerateResult> => {
      if (!botApi) {
        return Promise.resolve({ ok: false, error: "Bot 尚未就绪，请稍后再试" });
      }
      const imgCfg = config.webToolsConfig?.imageGeneration;
      if (!imgCfg || imgCfg.provider !== "pixai" || !imgCfg.apiKey) {
        return Promise.resolve({ ok: false, error: "生图未配置或未启用" });
      }

      let chatBotMsgIds = recentBotMessageIds.get(chatId);
      if (!chatBotMsgIds) {
        chatBotMsgIds = [];
        recentBotMessageIds.set(chatId, chatBotMsgIds);
      }
      while (chatBotMsgIds.length > MAX_RECENT_BOT_MESSAGES) chatBotMsgIds.shift();

      return directPixAIGenerate(rawPrompt, overrides, {
        getImageGenConfig: () => imgCfg,
        api: botApi,
        chatId,
        userId,
        recentBotMessageIds: chatBotMsgIds,
        timeoutConfig: config.timeoutConfig,
        onLog: config.onLog,
        onGenerationTrack: config.onGenerationTrack,
        rateLimiter: pixaiRateLimiter,
        adminIds: config.adminChatIds,
        nsfwChecker: config.nsfwChecker,
      });
    };
  }

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    setAiEnabled(false);
    clearInterval(cleanupTimer);
    clearInterval(bufferCleanupTimer);
    pendingActions.destroy();
    pendingGitHubActions.destroy();
    cooldownMap.clear();
    recentReceivedFiles.clear();
    recentBotMessageIds.clear();
    moodState.clear();
    knownPrivateChats.clear();
    lastSystemContent.clear();
    groupBuffers.clear();
  }

  return {
    handler,
    state,
    setModelForChat,
    getModelForChat,
    resetModelForChat,
    setProviderForChat,
    getProviderForChat: getProviderIdForChat,
    resetProviderForChat,
    getProvidersList,
    getModelsForChat: (chatId: number): ModelEntry[] => {
      const entry = getProviderRuntimeForChat(chatId);
      return entry.models ?? config.models ?? [];
    },
    getReplyMode: (): ReplyMode =>
      replyModeOverride ?? config.messageConfig?.replyMode ?? DEFAULT_MESSAGE_CONFIG.replyMode!,
    setReplyMode: (mode: ReplyMode) => {
      replyModeOverride = mode;
    },
    getRichMessageEnabled: () => isRichMessageEnabled(getEffectiveMessageConfig()),
    setRichMessageEnabled,
    getImageGenEnabled,
    setImageGenEnabled,
    getPixaiFullConfig,
    updatePixaiConfig,
    updateWebToolApiKey,
    getPixaiRateLimitStats: () => pixaiRateLimiter.getStats(),
    canUseImageGeneration,
    directGenerate: buildDirectGenerate(),
    fireTimerEvent: onTimerFired,
    isAiEnabled,
    setAiEnabled,
    destroy,
  };
}
