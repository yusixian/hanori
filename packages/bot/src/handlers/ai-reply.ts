import { resolveCompleteStreamText, throwCapturedStreamError } from "../utils/stream-error.js";
import type {
  AgentToolsConfig,
  AiExecutionConfig,
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
  UserPrivacyCallbacks,
  UserPrivacyMode,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_AI_EXECUTION_CONFIG,
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
  DEFAULT_TIMEOUT_CONFIG,
  inferCapabilities,
  isRichMessageEnabled,
  isStreamReplyMode,
} from "@cos-tool-bot/shared";
import type { JSONValue, Tool, UserModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import type { Api, MiddlewareFn } from "grammy";
import type { Message, User } from "grammy/types";
import type { BotContext, WrapperContext } from "../context.js";
import { hasLeadingBotCommand } from "../middleware/update-constraint.js";
import { appendCurrentRequest, assembleContext } from "../services/context-assembler.js";
import { PendingActionRegistry } from "../services/pending-actions.js";
import { PendingGitHubActionRegistry } from "../services/pending-github-actions.js";
import type { ContinueChatConfig } from "../services/continue-chat.js";
import { continueChat } from "../services/continue-chat.js";
import {
  AiExecutionCoordinator,
  AiRunCancelledError,
  AiRunDrainTimeoutError,
  type AiExecutionCoordinatorStats,
  type AiRunContext,
  type AiRunScope,
} from "../services/ai-execution-coordinator.js";
import { AiIngressLock } from "../services/ai-ingress-lock.js";
import { AiReplyQueueFullError } from "../services/ai-reply-scheduler.js";
import {
  AiTurnCoalescer,
  type CoalesceAdmission,
  type CoalesceBatchHandle,
  type CoalescedTurnMessage,
  type CoalesceScope,
} from "../services/ai-turn-coalescer.js";
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
import { VISIBLE_EFFECT_TOOL_NAMES } from "../tools/visible-effects.js";
import { isTextCoveredByDeliveries } from "../utils/delivery.js";
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
import { extractCacheTokenUsage } from "../utils/cache-usage.js";
import {
  createCacheFingerprint,
  createToolSchemaHash,
  sortToolsForPromptCache,
} from "../utils/prompt-cache.js";
import { createMetaPrefixStreamFilter, stripMetaPrefix } from "../utils/strip-meta-prefix.js";
import { createThinkingStreamFilter, stripThinkingContent } from "../utils/strip-thinking.js";
import {
  createAiSelectionRuntime,
  type AiProviderRuntime,
  type AiSelectionMutations,
  type AiSelectionSnapshot,
} from "./ai-selection.js";

export type { AiProviderRuntime } from "./ai-selection.js";

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

export function resolveGitHubCodingModelConfig(
  config: Pick<GitHubToolsRuntimeConfig, "codingProviderId" | "codingModelId">,
  providers: AiProviderRuntime[] | undefined,
  fallbackProvider: AiProviderRuntime,
  fallbackModelId: string,
): GitHubCodingModelConfig | undefined {
  if (!config.codingProviderId && !config.codingModelId) {
    return buildGitHubCodingModelConfig(fallbackProvider, fallbackModelId);
  }
  if (!config.codingProviderId) return undefined;

  const provider = providers?.find((candidate) => candidate.id === config.codingProviderId);
  if (!provider) return undefined;

  const modelId = config.codingModelId ?? provider.defaultModel;
  if (
    !modelId ||
    (modelId !== provider.defaultModel &&
      !provider.models?.some((candidate) => candidate.id === modelId))
  ) {
    return undefined;
  }
  return buildGitHubCodingModelConfig(provider, modelId);
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
  activeModelId?: string | null;
  aiSelectionSnapshot?: AiSelectionSnapshot;
  aiSelectionMutations?: AiSelectionMutations;
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
  triggerConfig: AiTriggerConfig;
  groupOverrides: Record<string, AiGroupOverride>;
  adminChatIds: number[];
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  privacy?: UserPrivacyCallbacks;
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
  executionConfig?: AiExecutionConfig;
  /** Return after scheduler admission so grammY can process the next update in the same Chat. */
  detachReplyExecution?: boolean;
  imageOcrConfig?: ImageOcrConfig;
  botMemory?: BotMemoryCallbacks;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  models?: ModelEntry[];
  modelCommandAccess?: "admin" | "all";
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
    userId: number;
    handle: ReturnType<typeof setTimeout>;
  }) => void | Promise<void>;
  onTimerCancel?: (timerId: string) => void;
  onTimerFiredPersist?: (timerId: string) => Promise<void>;
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

function serializedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

const COOLDOWN_CLEANUP_INTERVAL = 5 * 60 * 1000;
const BUFFER_CLEANUP_INTERVAL = 5 * 60 * 1000;
const BUFFER_STALE_MS = 30 * 60 * 1000;
const DETACHED_DELIVERY_DRAIN_WAIT_MS = 5_000;

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
  github_inspect_workspace: "🔎 检查本地 coding workspace...",
  github_resume_workspace: "🔐 准备 workspace 恢复确认...",
  github_discard_workspace: "🔐 准备 workspace 丢弃确认...",
  github_push_branch: "🔐 准备分支推送确认...",
  github_create_pull_request: "🔐 准备 Pull Request 创建确认...",
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
  groupHistoryMaxTokens: number;
} {
  const conversationCfg = {
    ...DEFAULT_CONVERSATION_CONFIG,
    ...config.conversationConfig,
  };
  const override = config.groupOverrides[String(chatId)];
  if (!override) {
    return {
      enabled: config.triggerConfig !== undefined,
      whitelisted: false,
      systemPrompt: config.systemPrompt,
      triggerConfig: config.triggerConfig,
      conversationEnabled: conversationCfg.enabled,
      maxContextMessages: conversationCfg.maxContextMessages,
      groupHistoryMaxTokens:
        conversationCfg.groupHistoryMaxTokens ?? DEFAULT_CONVERSATION_CONFIG.groupHistoryMaxTokens,
    };
  }
  return {
    enabled: override.enabled ?? true,
    whitelisted: override.whitelisted ?? false,
    systemPrompt: override.systemPrompt ?? config.systemPrompt,
    triggerConfig: { ...config.triggerConfig, ...override.triggerConfig },
    conversationEnabled: override.conversationEnabled ?? conversationCfg.enabled,
    maxContextMessages: override.maxContextMessages ?? conversationCfg.maxContextMessages,
    groupHistoryMaxTokens:
      override.groupHistoryMaxTokens ??
      conversationCfg.groupHistoryMaxTokens ??
      DEFAULT_CONVERSATION_CONFIG.groupHistoryMaxTokens,
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

function describeReplyQuote(replyMsg: Message | undefined, fileDesc = ""): string {
  if (!replyMsg) return "";
  const replyText = replyMsg.text ?? replyMsg.caption ?? "";
  const content = `${fileDesc}${replyText}`.trim();
  if (!content) return "";
  return `[回复 ${getDisplayName(replyMsg.from)} 的消息: ${content}]\n`;
}

function describeGroupMessageForHistory(msg: Message): string {
  if (msg.text) return msg.text;
  const caption = msg.caption?.trim();
  let attachment = "";
  if (msg.photo) attachment = "[图片]";
  else if (msg.document) {
    attachment = `[文件: ${msg.document.file_name ?? "unknown"}]`;
  }
  return [attachment, caption].filter(Boolean).join("\n");
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
  getAiExecutionStats(): AiExecutionCoordinatorStats;
  getPendingGitHubActions(): PendingGitHubActionRegistry;
  getContinueChatConfig(chatId?: number): ContinueChatConfig;
  isPrivateChat(chatId: number): boolean;
}

const MAX_RECENT_BOT_MESSAGES = 20;
const PERSISTENCE_RETRY_DELAYS_MS = [0, 50, 150] as const;
const MOOD_EXPIRE_MS = 60 * 60 * 1000; // 1 hour

export function createAiReplyHandler(
  config: AiReplyConfig,
  runtime?: { ingressLock?: AiIngressLock },
): {
  handler: MiddlewareFn<BotContext>;
  state: BotRuntimeState;
  setModelForChat: (chatId: number, modelId: string, actorTelegramUserId: number) => Promise<void>;
  resetModelForChat: (chatId: number, actorTelegramUserId: number) => Promise<void>;
  setProviderForChat: (
    chatId: number,
    providerId: string,
    actorTelegramUserId: number,
  ) => Promise<void>;
  resetProviderForChat: (chatId: number, actorTelegramUserId: number) => Promise<void>;
  applyAiSelectionSnapshot: (snapshot: AiSelectionSnapshot) => void;
  getSelectionForChat: (chatId: number) => {
    providerId: string;
    modelId: string;
    models: ModelEntry[];
  };
  getProvidersList: () => Array<{ id: string; label: string; defaultModel: string }>;
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
  fireTimerEvent: (
    chatId: number,
    timerId: string,
    reason: string,
    userId?: number,
    memoryless?: boolean,
    allowRssWrites?: boolean,
  ) => Promise<boolean>;
  isAiEnabled: () => boolean;
  setAiEnabled: (enabled: boolean) => number;
  captureTurnCoalescingAdmission: (context: object, chatId: number, threadId?: number) => void;
  stopTurnCoalescing: (chatId: number, threadId?: number) => void;
  cancelChatRuns: (chatId: number) => Promise<number>;
  cancelUserRuns: (userId: number) => Promise<number>;
  runChatMutation: <T>(chatId: number, operation: () => Promise<T>) => Promise<T>;
  runUserMutation: <T>(userId: number, operation: () => Promise<T>) => Promise<T>;
  waitForUserProfileUpdates: (userId: number) => Promise<void>;
  destroy: () => Promise<void>;
} {
  const cooldownMap = new Map<number, number>();

  // Bot-wide AI kill switch (in-memory). /stop flips aiDisabled=true and aborts
  // all in-flight streamText calls via the registered controllers.
  let aiDisabled = false;
  const activeAbortControllers = new Set<AbortController>();
  const executionConfig: AiExecutionConfig = {
    ...DEFAULT_AI_EXECUTION_CONFIG,
    ...config.executionConfig,
    queueNotice: {
      ...DEFAULT_AI_EXECUTION_CONFIG.queueNotice,
      ...config.executionConfig?.queueNotice,
    },
  };
  const executionCoordinator = new AiExecutionCoordinator({
    maxConcurrent: executionConfig.maxConcurrentReplies,
    maxQueued: 100,
  });
  const turnCoalescer = new AiTurnCoalescer();
  const turnCoalescingAdmissions = new WeakMap<object, CoalesceAdmission>();
  const ingressLock = runtime?.ingressLock ?? new AiIngressLock();
  interface DetachedDeliveryTask {
    scope: AiRunScope;
    settled: Promise<void>;
  }
  const detachedDeliveryTasks = new Set<DetachedDeliveryTask>();

  function trackDetachedDelivery(task: Promise<unknown>, scope: AiRunScope): Promise<void> {
    let tracked!: DetachedDeliveryTask;
    const settled = task
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        detachedDeliveryTasks.delete(tracked);
      });
    tracked = { scope, settled };
    detachedDeliveryTasks.add(tracked);
    return settled;
  }

  async function drainDetachedDeliveries(
    scope?: Partial<AiRunScope>,
    waitMs = DETACHED_DELIVERY_DRAIN_WAIT_MS,
  ): Promise<boolean> {
    const matchingTasks = [...detachedDeliveryTasks].filter(
      (task) =>
        (scope?.chatId === undefined || task.scope.chatId === scope.chatId) &&
        (scope?.userId === undefined || task.scope.userId === scope.userId),
    );
    if (matchingTasks.length === 0) return true;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const allSettled = Promise.all(matchingTasks.map((task) => task.settled)).then(() => {
      settled = true;
    });
    await Promise.race([
      allSettled,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, waitMs);
        timeout.unref?.();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    return settled;
  }

  function isAiEnabled(): boolean {
    return !aiDisabled;
  }

  function setAiEnabled(enabled: boolean): number {
    if (enabled) {
      aiDisabled = false;
      return 0;
    }
    aiDisabled = true;
    turnCoalescer.clear();
    const scheduledAborted = executionCoordinator.cancelAllNow();
    const toAbort = [...activeAbortControllers];
    activeAbortControllers.clear();
    for (const c of toAbort) {
      c.abort(new Error("AI disabled by /stop"));
    }
    return Math.max(scheduledAborted, toAbort.length);
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

  const selectionRuntime = createAiSelectionRuntime({
    providers: config.providers,
    activeProviderId: config.activeProviderId,
    activeModelId: config.activeModelId,
    initialSnapshot: config.aiSelectionSnapshot,
    legacy: {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      providerFormat: config.providerFormat ?? "openai",
      model: config.model,
      models: config.models,
    },
    mutations: config.aiSelectionMutations,
  });

  const setModelForChat = (chatId: number, modelId: string, actorTelegramUserId: number) =>
    selectionRuntime.setModel(chatId, modelId, actorTelegramUserId);
  const resetModelForChat = (chatId: number, actorTelegramUserId: number) =>
    selectionRuntime.resetModel(chatId, actorTelegramUserId);
  const setProviderForChat = (chatId: number, providerId: string, actorTelegramUserId: number) =>
    selectionRuntime.setProvider(chatId, providerId, actorTelegramUserId);
  const resetProviderForChat = (chatId: number, actorTelegramUserId: number) =>
    selectionRuntime.resetProvider(chatId, actorTelegramUserId);
  const getProvidersList = () => selectionRuntime.getProvidersList();

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
  const onTimerFired = (
    timerChatId: number,
    timerId: string,
    reason: string,
    timerUserId?: number,
    memoryless?: boolean,
    allowRssWrites?: boolean,
  ): Promise<boolean> => {
    if (!botApi) return Promise.reject(new Error("Bot API is not ready for timer delivery"));
    const eventDescription = `定时器到期 (ID: ${timerId}): ${reason}\n请根据定时器的用途继续对话。`;
    return continueChat(botApi, buildContinueChatConfig(timerChatId), {
      chatId: timerChatId,
      eventDescription,
      userId: timerUserId,
      timerDepth: 1,
      memoryless,
      requireDelivery: true,
      allowRssWrites,
    }).catch((err) => {
      config.onLog?.({
        level: "error",
        message: `Timer continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
        meta: { chatId: timerChatId, timerId },
      });
      throw err;
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
      resolveSelection: (selectionChatId) => {
        const selection = selectionRuntime.resolve(selectionChatId);
        return Object.freeze({
          model: selection.providerFactory(selection.modelId),
          modelId: selection.modelId,
          providerId: selection.providerId,
          temperature: selection.modelEntry?.temperature,
          maxTokens: selection.modelEntry?.maxTokens,
          providerOptions: buildProviderOptions(
            selection.modelEntry,
            selection.providerRuntime.providerFormat,
          ),
          agentToolsFactory: config.agentToolsConfig?.enabled
            ? () =>
                createAgentTools({
                  provider: (model) => selection.providerFactory(model),
                  model: selection.modelId,
                  agentConfig: config.agentToolsConfig!,
                  webToolsConfig: config.webToolsConfig,
                  onLog: config.onLog,
                  timeoutConfig: config.timeoutConfig,
                })
            : undefined,
        });
      },
      isAiDisabled: () => aiDisabled,
      runWithExecution: async (scope, operation) => {
        const scheduledAt = Date.now();
        let executionStartedAt: number | undefined;
        let scheduledResult: ReturnType<typeof operation> | undefined;
        await ingressLock.runExecutionAdmission(scope.chatId, scope.userId, async () => {
          const scheduled = executionCoordinator.schedule(scope, async (context) => {
            executionStartedAt = Date.now();
            config.onLog?.({
              level: "info",
              message: "AI continuation execution started",
              meta: {
                ...scope,
                waitMs: Math.max(0, executionStartedAt - scheduledAt),
                ...executionCoordinator.stats,
              },
            });
            return operation(context);
          });
          if (scheduled.queued) {
            config.onLog?.({
              level: "info",
              message: "AI continuation queued",
              meta: { ...scope, ...executionCoordinator.stats },
            });
          }
          scheduledResult = scheduled.result;
          scheduled.start();
        });
        try {
          return await scheduledResult!;
        } finally {
          config.onLog?.({
            level: "info",
            message: "AI continuation execution finished",
            meta: {
              ...scope,
              runMs:
                executionStartedAt === undefined ? 0 : Math.max(0, Date.now() - executionStartedAt),
              ...executionCoordinator.stats,
            },
          });
        }
      },
      registerAbortController: (c) => activeAbortControllers.add(c),
      unregisterAbortController: (c) => activeAbortControllers.delete(c),
      systemPrompt: config.systemPrompt,
      behavioralPrompt: config.behavioralPrompt,
      conversationConfig: config.conversationConfig,
      conversation: config.conversation,
      privacy: config.privacy,
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
      dataFiles: config.dataFiles,
      pendingActions,
      recentBotMessageIds,
      moodState,
      stickerPacks: config.stickerPacks,
      onTimerFired: async (timerChatId, timerId, reason) => {
        await onTimerFired(timerChatId, timerId, reason);
      },
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
  const conversationCfg = {
    ...DEFAULT_CONVERSATION_CONFIG,
    ...config.conversationConfig,
  };
  const groupBuffers = new Map<
    number,
    { buffer: RingBuffer<BufferedMessage>; lastActive: number }
  >();

  const bufferCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of groupBuffers) {
      if (now - entry.lastActive > BUFFER_STALE_MS) {
        groupBuffers.delete(chatId);
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
    getAiExecutionStats: () => executionCoordinator.stats,
    getPendingGitHubActions: () => pendingGitHubActions,
    getContinueChatConfig: (cid) => buildContinueChatConfig(cid),
    isPrivateChat: (chatId) => knownPrivateChats.has(chatId),
  };

  const handleMessage: MiddlewareFn<BotContext> = async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) return next();

    const chatId = ctx.chat?.id;
    if (!chatId) return next();
    const coalesceConversationScope = { chatId, threadId: msg.message_thread_id };
    const coalesceAdmission =
      turnCoalescingAdmissions.get(ctx) ?? turnCoalescer.capture(coalesceConversationScope);

    // Skip commands
    if (hasLeadingBotCommand(ctx)) {
      turnCoalescer.stopAccepting(coalesceConversationScope);
      return next();
    }

    const isPrivate = ctx.chat?.type === "private";
    const userId = ctx.from?.id;
    if (!userId) {
      turnCoalescer.advance(coalesceConversationScope, coalesceAdmission);
      return next();
    }

    const isAdmin = config.adminChatIds.includes(userId);
    const userName = getDisplayName(ctx.from);

    let effectivePrompt = config.systemPrompt;
    let triggerResult: TriggerResult = false;
    let groupConversationEnabled = conversationCfg.enabled;
    let groupMaxContext = conversationCfg.maxContextMessages;
    let groupHistoryMaxTokens = conversationCfg.groupHistoryMaxTokens;
    let groupTriggerConfig = config.triggerConfig;

    if (isPrivate) {
      if (!isAdmin && !config.privateChatWhitelist?.includes(userId)) {
        turnCoalescer.advance(coalesceConversationScope, coalesceAdmission);
        return next();
      }
    } else {
      const groupCfg = resolveGroupConfig(config, chatId);
      if (!groupCfg.enabled || (!groupCfg.whitelisted && !isAdmin)) {
        turnCoalescer.advance(coalesceConversationScope, coalesceAdmission);
        return next();
      }

      effectivePrompt = groupCfg.systemPrompt;
      groupConversationEnabled = groupCfg.conversationEnabled;
      groupMaxContext = groupCfg.maxContextMessages;
      groupHistoryMaxTokens = groupCfg.groupHistoryMaxTokens;
      groupTriggerConfig = groupCfg.triggerConfig;
    }

    const privacyMode: UserPrivacyMode = (await config.privacy?.getMode(userId)) ?? "normal";
    const personalizationEnabled = privacyMode !== "off";
    if (personalizationEnabled && ctx.from) profileObserver?.observe(ctx.api, ctx.from);

    const supportsAiContent = !!(msg.text || msg.photo || msg.document);
    if (!supportsAiContent) {
      turnCoalescer.advance(coalesceConversationScope, coalesceAdmission);
      return next();
    }

    // Capture API reference and track private chats for event handlers
    botApi = ctx.api;
    if (isPrivate) knownPrivateChats.add(chatId);

    // Push to ring buffer for group chats (before trigger check)
    let bufferedGroupText = "";
    let groupBufferSnapshot: BufferedMessage[] = [];
    let persistedGroupMessageId: number | undefined;
    if (!isPrivate) {
      const buffer = getOrCreateBuffer(chatId);
      bufferedGroupText = describeGroupMessageForHistory(msg);
      if (bufferedGroupText) {
        buffer.push({
          messageId: msg.message_id,
          userId,
          userName,
          text: bufferedGroupText,
          timestamp: Date.now(),
        });
      }
      groupBufferSnapshot = buffer.getAll();
    }

    triggerResult = isPrivate
      ? "reply"
      : checkTrigger(ctx, groupTriggerConfig, chatId, cooldownMap);
    if (privacyMode === "off" && triggerResult !== "reply" && triggerResult !== "mention") {
      triggerResult = false;
    }

    const shouldPersistPublicGroupMessage =
      !isPrivate && !!config.conversation && groupConversationEnabled && !!bufferedGroupText;
    const groupTurnSourceKey = `telegram:${msg.message_id}:user`;
    const groupHistoryContent =
      `${describeReplyQuote(ctx.reply_to_message)}${bufferedGroupText}`.trim();
    const coalesceScope: CoalesceScope = {
      ...coalesceConversationScope,
      userId,
      privacyMode,
    };
    const tracksGroupTurnCompletion =
      !!config.conversation?.completeTurns || !!config.conversation?.completeTurn;
    if (shouldPersistPublicGroupMessage) {
      try {
        const message = {
          chatId,
          content: groupHistoryContent || bufferedGroupText,
          userAuthoredContent: personalizationEnabled ? bufferedGroupText : undefined,
          userId,
          userName,
          sourceKey: groupTurnSourceKey,
          meta: {
            tgMessageId: msg.message_id,
            publicGroupHistory: true,
            turnState:
              triggerResult && !aiDisabled && tracksGroupTurnCompletion ? "pending" : "complete",
          },
        };
        if (config.conversation!.upsertUserMessage) {
          const persisted = await config.conversation!.upsertUserMessage(message);
          persistedGroupMessageId = persisted?.id;
        } else {
          await config.conversation!.addMessage({ ...message, role: "user" });
        }
      } catch (err) {
        config.onLog?.({
          level: "error",
          message: `Failed to capture group message: ${err instanceof Error ? err.message : String(err)}`,
          meta: { chatId, userId, messageId: msg.message_id },
        });
      }
    }
    const supportsQueuedTurnCoalescing =
      !shouldPersistPublicGroupMessage ||
      (!!config.conversation?.completeTurns && persistedGroupMessageId !== undefined);

    // A rapid text-only follow-up merges into the same user's queued run instead of
    // scheduling a second model call. Media messages keep the full per-turn pipeline.
    const followUpReplyFiles = extractFilesFromMessage(ctx.reply_to_message);
    if (
      triggerResult &&
      !aiDisabled &&
      supportsQueuedTurnCoalescing &&
      msg.text &&
      !msg.photo &&
      !msg.document &&
      followUpReplyFiles.length === 0
    ) {
      const followUpText = `${describeReplyQuote(ctx.reply_to_message)}${msg.text}`.trim();
      const merged =
        !!followUpText &&
        turnCoalescer.tryAppend(coalesceScope, {
          tgMessageId: msg.message_id,
          text: followUpText,
          userAuthoredContent: msg.text.trim(),
          sourceKey: shouldPersistPublicGroupMessage ? groupTurnSourceKey : undefined,
        });
      if (merged) {
        config.onLog?.({
          level: "info",
          message: "AI reply coalesced into queued turn",
          meta: { chatId, userId, ...executionCoordinator.stats },
        });
        return;
      }
    }
    // Once a message cannot join the open batch, later messages must not cross it. The queued
    // owner's handle still drains extras that were accepted before this boundary.
    turnCoalescer.advance(coalesceConversationScope, coalesceAdmission);
    if (!triggerResult || aiDisabled) {
      if (shouldPersistPublicGroupMessage) {
        void config.conversation!.triggerCompression(chatId);
      }
      return next();
    }

    const readConversation =
      config.conversation &&
      (isPrivate ? conversationCfg.enabled && personalizationEnabled : groupConversationEnabled);
    const persistConversation =
      config.conversation &&
      (isPrivate ? conversationCfg.enabled && personalizationEnabled : groupConversationEnabled);

    // Taken before the turn is queued so a delayed execution cannot read cross-chat
    // messages that arrived while it was waiting.
    let admissionHistoryWatermark: number | undefined;
    if (readConversation && privacyMode === "normal" && config.conversation?.getHistoryWatermark) {
      try {
        admissionHistoryWatermark = await config.conversation.getHistoryWatermark();
      } catch (err) {
        config.onLog?.({
          level: "warn",
          message: `Failed to capture conversation history watermark: ${err instanceof Error ? err.message : String(err)}`,
          meta: { chatId, userId },
        });
      }
    }

    const executeTurn = async (
      executionContext: AiRunContext,
      preserveQueuedMessage: boolean,
    ): Promise<void> => {
      // Hoisted so the outer finally can unregister even on early errors.
      let manualAbort: AbortController | null = null;
      try {
        if (!executionContext.isCurrent()) throw new AiRunCancelledError();
        const turnMessageConfig = Object.freeze({ ...getEffectiveMessageConfig() });
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

        // Create per-request telegram tools
        const telegramTools = createTelegramTools({
          api: ctx.api,
          chatId,
          userId,
          recentBotMessageIds: chatBotMsgIds,
          pendingActions,
          onTimerFired: async (timerChatId, timerId, reason) => {
            await onTimerFired(timerChatId, timerId, reason, userId);
          },
          onTimerCreate: config.onTimerCreate
            ? (params) => config.onTimerCreate!({ ...params, userId })
            : undefined,
          onTimerCancel: config.onTimerCancel,
          onTimerFiredPersist: config.onTimerFiredPersist,
          onceGuard,
          dataDir: config.dataFiles?.dataDir,
          token: config.token,
          receivedFiles: recentReceivedFiles.get(chatId),
          timeoutConfig: config.timeoutConfig,
        });
        if (!personalizationEnabled) delete telegramTools.set_timer;

        // Create per-request behavior tools
        const deliveredMultiMessages: string[] = [];
        const behaviorTools = createBehaviorTools({
          api: ctx.api,
          chatId,
          recentBotMessageIds: chatBotMsgIds,
          moodState,
          richMessageEnabled: isRichMessageEnabled(turnMessageConfig),
          onLog: config.onLog,
          onMultiMessageSent: (text) => deliveredMultiMessages.push(text),
        });
        if (!personalizationEnabled) delete behaviorTools.set_mood;

        // Resolve one immutable provider/model/factory snapshot after acquiring the scheduler slot.
        const currentSelection = selectionRuntime.resolve(chatId);
        const currentModel = currentSelection.modelId;
        const currentProviderRuntime = currentSelection.providerRuntime;
        const currentProviderFactory = currentSelection.providerFactory;

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
            codingModel: resolveGitHubCodingModelConfig(
              config.githubToolsConfig,
              config.providers,
              currentProviderRuntime,
              currentModel,
            ),
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
        if (!isPrivate && !readConversation && personalizationEnabled) {
          const shouldIncludeContext =
            conversationCfg.groupContextMode === "all" ||
            (conversationCfg.groupContextMode === "random_only" && triggerResult === "random");

          if (shouldIncludeContext) {
            const contextMessages = groupBufferSnapshot.filter(
              (buffered) => buffered.messageId !== msg.message_id,
            );
            if (contextMessages.length > 0) {
              ringBufferContext = formatGroupContextMessages(contextMessages);
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
        const replyContextDesc = describeReplyQuote(replyMsg, describeFiles(replyFiles, "", " "));

        const rawContent = `${replyContextDesc}${attachmentDesc}${messageText}`.trim();
        const userAuthoredContent = `${attachmentDesc}${messageText}`.trim();
        // Coalesced follow-ups extend the model request only; their own history rows were
        // written at ingress, and this run's history read is bounded before this message.
        const coalescedLines = coalescedExtras.map((extra) =>
          isPrivate ? extra.text : `[${userName}]: ${extra.text}`,
        );
        const ownContent = !isPrivate ? `[${userName}]: ${rawContent}` : rawContent;
        const textContent = [ownContent, ...coalescedLines].join("\n");
        const retrievalQuery = [rawContent || messageText, ...coalescedExtras.map((e) => e.text)]
          .join("\n")
          .trim();
        const requestMemoryTools = personalizationEnabled ? memoryTools : undefined;
        const requestBotMemoryTools = personalizationEnabled ? botMemoryTools : undefined;

        if (!isPrivate && persistConversation) {
          try {
            const message = {
              chatId,
              content: rawContent || bufferedGroupText || messageText,
              userAuthoredContent: personalizationEnabled
                ? userAuthoredContent || bufferedGroupText || messageText
                : undefined,
              userId,
              userName,
              sourceKey: groupTurnSourceKey,
              meta: {
                tgMessageId: msg.message_id,
                publicGroupHistory: true,
                turnState: tracksGroupTurnCompletion ? "pending" : "complete",
              },
            };
            if (config.conversation!.upsertUserMessage) {
              const persisted = await config.conversation!.upsertUserMessage(message);
              persistedGroupMessageId = persisted?.id ?? persistedGroupMessageId;
            } else {
              await config.conversation!.addMessage({ ...message, role: "user" });
            }
          } catch (err) {
            config.onLog?.({
              level: "error",
              message: `Failed to enrich triggered group message: ${err instanceof Error ? err.message : String(err)}`,
              meta: { chatId, userId, messageId: msg.message_id },
            });
          }
        }

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
          conversation: readConversation ? config.conversation : undefined,
          historyFormat: conversationCfg.historyFormat,
          maxContextMessages: isPrivate ? conversationCfg.maxContextMessages : groupMaxContext,
          groupHistoryMaxTokens: isPrivate ? undefined : groupHistoryMaxTokens,
          historyExcludeSourceKey: isPrivate ? undefined : `telegram:${msg.message_id}:user`,
          historyBeforeId: isPrivate ? undefined : persistedGroupMessageId,
          historyBeforeTelegramMessageId: isPrivate ? undefined : msg.message_id,
          ringBufferContext: ringBufferContext || undefined,
          memoryConfig: config.memoryConfig,
          memory: personalizationEnabled ? config.memory : undefined,
          userId,
          includeCrossChatUserHistory: privacyMode === "normal",
          crossChatHistoryBeforeId: admissionHistoryWatermark,
          memoryTools: requestMemoryTools,
          botMemoryConfig: config.botMemoryConfig,
          botMemory: personalizationEnabled ? config.botMemory : undefined,
          botMemoryTools: requestBotMemoryTools,
          retrievalQuery,
          currentMood: personalizationEnabled ? moodState.get(chatId) : undefined,
          stickerPacks: config.stickerPacks,
          webToolsConfig: config.webToolsConfig,
          webTools,
          agentToolsConfig: config.agentToolsConfig,
          artworkToolsEnabled: config.artworkToolsConfig?.enabled,
          hasFileTools: !!fileTools,
          dataFiles: config.dataFiles,
          messageConfig: turnMessageConfig,
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
        const historyBudget = promptTrace.sections
          .map((section) => section.details?.["historyBudget"])
          .find((details) => details !== undefined);

        // Combine all tools
        const allTools: Record<string, Tool> = {
          ...requestMemoryTools,
          ...requestBotMemoryTools,
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
        const msgCfg = turnMessageConfig;
        const isStreamMode = isStreamReplyMode(msgCfg) && !preserveQueuedMessage;
        const richMessageEnabled = isRichMessageEnabled(msgCfg) && !preserveQueuedMessage;
        if (isStreamMode || preserveQueuedMessage) {
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
        const stableTools = sortToolsForPromptCache(allTools);
        const toolSchemaHash = createToolSchemaHash(stableTools);
        const cacheFingerprint = createCacheFingerprint({
          providerId: currentProviderRuntime.id,
          model: currentModel,
          staticPrefixHash: promptTrace.staticPrefixHash,
          toolSchemaHash,
        });

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
            toolSchemaHash,
            cacheFingerprint,
            promptSections: promptTrace.sections,
            promptEstimatedTokens: promptTrace.totalEstimatedTokens,
            historyBudget,
            history_degraded:
              typeof historyBudget === "object" &&
              historyBudget !== null &&
              "degraded" in historyBudget
                ? historyBudget.degraded
                : false,
            toolsEnabled: Object.keys(stableTools),
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
        const wrappedTools = wrapToolsWithStatus(
          wrapToolsWithCache(stableTools, requestCache),
          ctx,
        );
        manualAbort = new AbortController();
        activeAbortControllers.add(manualAbort);
        const perStepAbort = createPerStepAbort(
          config.timeoutConfig?.perStepMs ?? DEFAULT_TIMEOUT_CONFIG.perStepMs,
          AbortSignal.any([
            AbortSignal.timeout(
              config.timeoutConfig?.aiReplyMs ?? DEFAULT_TIMEOUT_CONFIG.aiReplyMs,
            ),
            manualAbort.signal,
            executionContext.signal,
          ]),
        );

        // ─── streamText (ai v6 API) ───
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
                config.onLog?.({
                  level: "debug",
                  message: "AI tool call",
                  meta: {
                    step: stepCounter,
                    toolName: tc.toolName,
                    argsLength: serializedLength(tc.input),
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
                    resultLength: serializedLength(tr.output),
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
        // Track whether multi_message actually delivered content (segment mode only).
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
              const streamMethod = richMessageEnabled
                ? "replyWithMarkdownStream"
                : "replyWithStream";
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
            sentViaMultiMessage = deliveredMultiMessages.length > 0;
          }
        } finally {
          perStepAbort.cleanup();
        }

        // If /stop fired while streamText was running, drop all pending sends + saves.
        if (aiDisabled || manualAbort?.signal.aborted || !executionContext.isCurrent()) {
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
        const deliveredMultiMessageContent = deliveredMultiMessages.join("\n");
        const trailingTextCovered =
          sentViaMultiMessage && isTextCoveredByDeliveries(text, deliveredMultiMessages);
        const steps = await result.steps;
        const usage = await result.usage;
        const finishReason = await result.finishReason;
        let sentFinalText = false;

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
              () => aiDisabled || !!manualAbort?.signal.aborted || !executionContext.isCurrent(),
            );
            chatBotMsgIds.push(...messageIds);
            streamStarted = messageIds.length > 0;
            sentFinalText = streamStarted;
          } else {
            await handleEmptyText(ctx, steps, config, chatBotMsgIds, chatId, userId, finishReason);
            capturedStreamError = undefined;
          }
        } else if (!isStreamMode) {
          if (sentViaMultiMessage && (!text || trailingTextCovered)) {
            await ctx.deleteWaiting();
          } else if (text) {
            const messageIds = await sendFormattedChunks(
              ctx,
              text,
              msgCfg,
              richMessageEnabled,
              logRichFallback,
              () => aiDisabled || !!manualAbort?.signal.aborted || !executionContext.isCurrent(),
            );
            chatBotMsgIds.push(...messageIds);
            sentFinalText = messageIds.length > 0;
          } else {
            await handleEmptyText(ctx, steps, config, chatBotMsgIds, chatId, userId, finishReason);
          }
        }

        if (isStreamMode && isPrivate && streamStarted) {
          await ctx.deleteWaiting();
        }

        throwCapturedStreamError(capturedStreamError, streamStarted);

        const durationMs = Date.now() - startTime;
        const assistantContent = sentViaMultiMessage
          ? [deliveredMultiMessageContent, sentFinalText ? text : ""].filter(Boolean).join("\n")
          : text || "";

        if (sentViaMultiMessage && text && !sentFinalText) {
          config.onLog?.({
            level: trailingTextCovered ? "info" : "warn",
            message: trailingTextCovered
              ? `Suppressed ${text.length} trailing chars already delivered via multi_message`
              : `Failed to deliver ${text.length} uncovered trailing chars after multi_message`,
            meta: { chatId, userId, trailingLength: text.length },
          });
        }

        // Debug: AI response
        const totalToolCalls = steps.reduce((n, s) => n + s.toolCalls.length, 0);
        const totalToolResults = steps.reduce((n, s) => n + s.toolResults.length, 0);
        config.onLog?.({
          level: "debug",
          message: "AI response",
          meta: {
            durationMs,
            responseLength: text?.length ?? 0,
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
          ...extractCacheTokenUsage(
            usage,
            steps.map((step) => step.usage),
          ),
          providerId: currentProviderRuntime.id,
          staticPrefixHash: promptTrace.staticPrefixHash,
          toolSchemaHash,
          cacheFingerprint,
          durationMs,
          trigger: triggerResult as string,
        });

        // Save messages to conversation history (before checking text emptiness)
        if (persistConversation) {
          const toSave: Array<{
            chatId: number;
            role: ConversationRole;
            content: string;
            userAuthoredContent?: string;
            userId?: number;
            userName?: string;
            sourceKey?: string;
            meta?: Record<string, unknown>;
          }> = [];
          const sourcePrefix = `telegram:${msg.message_id}`;
          const turnOrderMeta =
            persistedGroupMessageId === undefined ? {} : { turnOrderId: persistedGroupMessageId };

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
                meta: { ...turnOrderMeta, model: currentModel, trigger: triggerResult },
              });
            }
          }

          // Group user messages are captured/upserted before the model call so ambient
          // and failed-trigger messages are durable. Private messages remain part of
          // the reply transaction and are omitted entirely in personalization-off mode.
          if (isPrivate) {
            toSave.push({
              chatId,
              role: "user",
              content: rawContent || messageText,
              userAuthoredContent: userAuthoredContent || messageText,
              userId,
              userName,
              sourceKey: `${sourcePrefix}:user`,
              meta: { tgMessageId: msg.message_id },
            });
            // Private follow-ups skipped ingress persistence; save them with this turn.
            toSave.push(...buildPrivateExtraRows());
          }

          // Save all tool calls and results from steps
          for (const step of steps) {
            for (const tc of step.toolCalls) {
              toSave.push({
                chatId,
                role: "tool_call",
                content: tc.toolName,
                sourceKey: `${sourcePrefix}:tool-call:${tc.toolCallId}`,
                meta: {
                  ...turnOrderMeta,
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
                  ...turnOrderMeta,
                  toolName: tr.toolName,
                  toolCallId: tr.toolCallId,
                },
              });
            }
          }

          // Persist only content confirmed as delivered. Uncovered trailing text is
          // sent through the normal fallback path before it reaches this point.
          toSave.push({
            chatId,
            role: "assistant",
            content: assistantContent,
            sourceKey: `${sourcePrefix}:assistant`,
            meta: {
              model: currentModel,
              trigger: triggerResult,
              usage,
              ...turnOrderMeta,
            },
          });

          if (!executionContext.isCurrent()) return;
          try {
            await config.conversation!.addMessages(toSave);
            privateExtrasSettled = true;
            if (isPrivate) await config.conversation!.triggerCompression(chatId);
          } catch (err) {
            config.onLog?.({
              level: "error",
              message: `Failed to save conversation: ${err instanceof Error ? err.message : String(err)}`,
              meta: { chatId },
            });
          }
        }

        config.onLog?.({
          level: "info",
          message: "AI reply sent",
          meta: {
            chatId,
            userId,
            isPrivate,
            textLength: assistantContent.length,
            responseTextLength: text?.length ?? 0,
            multiMessageSentCount: deliveredMultiMessages.length,
            trigger: triggerResult,
            conversationEnabled: !!persistConversation,
          },
        });
      } catch (err) {
        if (!executionContext.isCurrent()) {
          await ctx.deleteWaiting().catch(() => {});
          return;
        }
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
        if (manualAbort) activeAbortControllers.delete(manualAbort);
        await rescuePrivateExtras();
      }
    };

    let preserveQueuedMessage = false;
    let queueNotice: Promise<void> | undefined;
    let coalesceHandle: CoalesceBatchHandle | undefined;
    let coalescedExtras: CoalescedTurnMessage[] = [];
    let privateExtrasSettled = false;
    const buildPrivateExtraRows = () =>
      coalescedExtras.map((extra) => ({
        chatId,
        role: "user" as ConversationRole,
        content: extra.text,
        userAuthoredContent: extra.userAuthoredContent,
        userId,
        userName,
        sourceKey: `telegram:${extra.tgMessageId}:user`,
        meta: { tgMessageId: extra.tgMessageId } as Record<string, unknown>,
      }));
    /**
     * Group follow-ups are durable from ingress, private ones only exist in memory until the
     * reply transaction commits — so a failed or superseded run would drop them silently.
     */
    const rescuePrivateExtras = async () => {
      if (!isPrivate || !persistConversation || privateExtrasSettled) return;
      if (coalescedExtras.length === 0) return;
      if (config.privacy) {
        let currentPrivacyMode: UserPrivacyMode;
        try {
          currentPrivacyMode = await config.privacy.getMode(userId);
        } catch (error) {
          config.onLog?.({
            level: "error",
            message: "Failed to verify privacy mode before persisting coalesced messages",
            meta: {
              chatId,
              userId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          return;
        }
        if (currentPrivacyMode !== privacyMode) {
          privateExtrasSettled = true;
          return;
        }
      }
      let lastError: unknown;
      for (const delayMs of PERSISTENCE_RETRY_DELAYS_MS) {
        if (delayMs > 0) await sleep(delayMs);
        try {
          await config.conversation!.addMessages(buildPrivateExtraRows());
          privateExtrasSettled = true;
          return;
        } catch (error) {
          lastError = error;
        }
      }
      config.onLog?.({
        level: "error",
        message: `Failed to persist coalesced messages: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        meta: { chatId, userId, count: coalescedExtras.length },
      });
    };
    let groupTurnFinalization: Promise<void> | undefined;
    const finalizeGroupTurn = () => {
      if (isPrivate || !persistConversation) return Promise.resolve();
      groupTurnFinalization ??= (async () => {
        const sourceKeys = [
          groupTurnSourceKey,
          ...coalescedExtras.flatMap((extra) => (extra.sourceKey ? [extra.sourceKey] : [])),
        ];
        let lastError: unknown;
        for (const delayMs of PERSISTENCE_RETRY_DELAYS_MS) {
          if (delayMs > 0) await sleep(delayMs);
          try {
            if (config.conversation!.completeTurns) {
              await config.conversation!.completeTurns(chatId, sourceKeys, persistedGroupMessageId);
            } else {
              for (const sourceKey of sourceKeys) {
                await config.conversation!.completeTurn?.(
                  chatId,
                  sourceKey,
                  persistedGroupMessageId,
                );
              }
            }
            void config.conversation!.triggerCompression(chatId);
            return;
          } catch (error) {
            lastError = error;
          }
        }
        config.onLog?.({
          level: "error",
          message: "Failed to finalize conversation turn",
          meta: {
            chatId,
            userId,
            error: lastError instanceof Error ? lastError.message : String(lastError),
          },
        });
      })();
      return groupTurnFinalization;
    };
    const scheduledAt = Date.now();
    let executionStartedAt: number | undefined;
    let scheduled;
    try {
      scheduled = executionCoordinator.schedule({ chatId, userId }, async (executionContext) => {
        // Synchronous drain: everything appended before this instant joins this turn.
        coalescedExtras = coalesceHandle?.drain() ?? [];
        executionStartedAt = Date.now();
        config.onLog?.({
          level: "info",
          message: "AI reply execution started",
          meta: {
            chatId,
            userId,
            waitMs: Math.max(0, executionStartedAt - scheduledAt),
            coalescedCount: coalescedExtras.length,
            ...executionCoordinator.stats,
          },
        });
        const run = async () => {
          if (!executionContext.isCurrent()) {
            throw new AiRunCancelledError("AI reply was cancelled before execution");
          }
          return executeTurn(executionContext, preserveQueuedMessage);
        };
        try {
          if (!config.privacy) {
            await run();
          } else {
            await config.privacy.runExclusive(userId, async () => {
              const currentPrivacyMode = await config.privacy!.getMode(userId);
              if (currentPrivacyMode !== privacyMode) {
                throw new AiRunCancelledError("User privacy mode changed before AI execution");
              }
              await run();
            });
          }
        } finally {
          if (coalescedExtras.some((extra) => extra.sourceKey)) {
            // Keep the Chat permit until persisted follow-ups share their final logical order.
            await finalizeGroupTurn();
          }
        }
      });
    } catch (error) {
      if (error instanceof AiReplyQueueFullError) {
        config.onLog?.({
          level: "warn",
          message: "AI reply queue is full",
          meta: { chatId, userId, ...executionCoordinator.stats },
        });
        const busyReply = trackDetachedDelivery(
          ctx
            .directlyReply("助手现在真的忙不过来啦，请稍后再试哦～")
            .then(() => undefined)
            .catch(() => undefined),
          { chatId, userId },
        );
        const finalization = trackDetachedDelivery(finalizeGroupTurn(), { chatId, userId });
        if (!config.detachReplyExecution) await Promise.all([busyReply, finalization]);
        return;
      }
      await finalizeGroupTurn();
      throw error;
    }

    preserveQueuedMessage = scheduled.queued && executionConfig.queueNotice.enabled;
    if (scheduled.queued && supportsQueuedTurnCoalescing) {
      coalesceHandle = turnCoalescer.open(coalesceScope, coalesceAdmission);
    }
    trackDetachedDelivery(
      scheduled.result
        .finally(async () => {
          // A run cancelled while queued never drained; recover its extras for finalization.
          const undrained = coalesceHandle?.close();
          if (undrained?.length) coalescedExtras = [...coalescedExtras, ...undrained];
          await rescuePrivateExtras();
        })
        .finally(finalizeGroupTurn)
        .then(
          () => {
            config.onLog?.({
              level: "info",
              message: "AI reply execution finished",
              meta: {
                chatId,
                userId,
                runMs:
                  executionStartedAt === undefined
                    ? 0
                    : Math.max(0, Date.now() - executionStartedAt),
                ...executionCoordinator.stats,
              },
            });
          },
          async (error) => {
            await queueNotice;
            if (error instanceof AiRunCancelledError) {
              config.onLog?.({
                level: "info",
                message: "AI reply execution cancelled",
                meta: { chatId, userId, ...executionCoordinator.stats },
              });
              try {
                await ctx.deleteWaiting();
              } catch {
                // Best-effort cleanup after a cancelled detached turn.
              }
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            config.onLog?.({
              level: "error",
              message: "Scheduled AI reply failed before execution",
              meta: { chatId, userId, error: message, ...executionCoordinator.stats },
            });
            try {
              await ctx.resolveWait(`AI 回复时出错:\n${message}`);
            } catch {
              // The turn already failed before normal delivery fallbacks were available.
            }
          },
        )
        .catch(() => {}),
      { chatId, userId },
    );

    if (preserveQueuedMessage) {
      config.onLog?.({
        level: "info",
        message: "AI reply queued",
        meta: { chatId, userId, ...executionCoordinator.stats },
      });
      queueNotice = trackDetachedDelivery(
        ctx.wait(executionConfig.queueNotice.text).catch((error) => {
          config.onLog?.({
            level: "warn",
            message: "Failed to send AI queue notice",
            meta: { chatId, userId, error: error instanceof Error ? error.message : String(error) },
          });
        }),
        { chatId, userId },
      );
    }
    scheduled.start();
    if (!config.detachReplyExecution) {
      await queueNotice;
      await scheduled.result;
    }
    return;
  };

  const handler: MiddlewareFn<BotContext> = async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId === undefined || userId === undefined || hasLeadingBotCommand(ctx)) {
      return handleMessage(ctx, next);
    }
    if (ingressLock.hasMessageAdmission(ctx)) {
      return handleMessage(ctx, next);
    }
    return ingressLock.runMessage(chatId, userId, async () => {
      await handleMessage(ctx, next);
    });
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

  let destroyStarted = false;
  let destroyPromise: Promise<void> | undefined;
  function destroy(): Promise<void> {
    if (destroyPromise) return destroyPromise;
    if (!destroyStarted) {
      destroyStarted = true;
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
    let attempt!: Promise<void>;
    attempt = (async () => {
      try {
        const result = await executionCoordinator.destroyAndDrain();
        const deliveriesSettled = await drainDetachedDeliveries();
        if (!result.settled || result.timedOut || !deliveriesSettled) {
          throw new AiRunDrainTimeoutError("Timed out draining AI runs during Bot shutdown");
        }
      } finally {
        if (destroyPromise === attempt) destroyPromise = undefined;
      }
    })();
    destroyPromise = attempt;
    return attempt;
  }

  return {
    handler,
    state,
    setModelForChat,
    resetModelForChat,
    setProviderForChat,
    resetProviderForChat,
    applyAiSelectionSnapshot: selectionRuntime.applyAiSelectionSnapshot,
    getSelectionForChat: (chatId) => {
      const selection = selectionRuntime.resolve(chatId);
      return {
        providerId: selection.providerId,
        modelId: selection.modelId,
        models: selection.providerRuntime.models ?? config.models ?? [],
      };
    },
    getProvidersList,
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
    captureTurnCoalescingAdmission: (context, chatId, threadId) => {
      turnCoalescingAdmissions.set(context, turnCoalescer.capture({ chatId, threadId }));
    },
    stopTurnCoalescing: (chatId, threadId) => turnCoalescer.stopAccepting({ chatId, threadId }),
    cancelChatRuns: async (chatId) => {
      const result = await executionCoordinator.cancelChat(chatId);
      const deliveriesSettled = await drainDetachedDeliveries({ chatId });
      if (!result.settled || result.timedOut || !deliveriesSettled) {
        throw new AiRunDrainTimeoutError(
          "Timed out waiting for the active AI reply; history was not cleared",
        );
      }
      groupBuffers.delete(chatId);
      recentBotMessageIds.delete(chatId);
      return result.cancelled;
    },
    cancelUserRuns: async (userId) => {
      const result = await executionCoordinator.cancelUser(userId);
      const deliveriesSettled = await drainDetachedDeliveries({ userId });
      if (!result.settled || result.timedOut || !deliveriesSettled) {
        throw new AiRunDrainTimeoutError(
          "Timed out waiting for active AI replies; privacy data was not changed",
        );
      }
      return result.cancelled;
    },
    runChatMutation: (chatId, operation) => ingressLock.runChatMutation(chatId, operation),
    runUserMutation: (userId, operation) => ingressLock.runUserMutation(userId, operation),
    waitForUserProfileUpdates: (userId) =>
      profileObserver?.waitForIdle(userId) ?? Promise.resolve(),
    destroy,
  };
}
