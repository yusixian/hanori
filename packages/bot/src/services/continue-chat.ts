import type {
  AgentToolsConfig,
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
} from "@cos-tool-bot/shared";
import type { CoreTool, LanguageModelV1 } from "ai";
import { generateText } from "ai";
import type { Api } from "grammy";
import { createBehaviorTools, createTelegramTools } from "../tools/index.js";
import type { MoodInfo } from "../tools/index.js";
import { createOnceGuard } from "../tools/utils.js";
import { markdownToTelegramHtml } from "../utils/format.js";
import { sleep } from "../utils/sleep.js";
import { splitMessage } from "../utils/split-message.js";
import { createFileTools } from "../tools/file-tools.js";
import type { DataFilesConfig } from "../utils/data-files.js";
import { assembleContinueChatContext } from "./context-assembler.js";
import type { PendingActionRegistry } from "./pending-actions.js";

const MAX_MESSAGE_LENGTH = 4096;

// Per-chat promise chain to prevent concurrent generateText calls
const chatLocks = new Map<number, Promise<void>>();

export interface ContinueChatConfig {
  model: LanguageModelV1;
  modelId: string;
  systemPrompt: string;
  behavioralPrompt?: string;
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  memoryConfig?: MemoryConfig;
  memory?: MemoryCallbacks;
  botMemoryConfig?: BotMemoryConfig;
  botMemory?: BotMemoryCallbacks;
  messageConfig?: MessageConfig;
  webToolsConfig?: WebToolsConfig;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsConfig?: ArtworkToolsConfig;
  timeoutConfig?: TimeoutConfig;
  webTools?: Record<string, CoreTool>;
  agentToolsFactory?: () => Record<string, CoreTool>;
  dataFiles?: DataFilesConfig;
  pendingActions: PendingActionRegistry;
  recentBotMessageIds: Map<number, number[]>;
  moodState: Map<number, MoodInfo>;
  stickerPacks?: string[];
  onTimerFired?: (chatId: number, timerId: string, reason: string) => void;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
}

export interface ContinueChatEvent {
  chatId: number;
  eventDescription: string;
  userId?: number;
  userName?: string;
  timerDepth?: number;
}

export async function continueChat(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
): Promise<void> {
  // Per-chat lock: queue behind any ongoing generateText for the same chat
  const prev = chatLocks.get(event.chatId) ?? Promise.resolve();
  let resolve!: () => void;
  const current = new Promise<void>((r) => {
    resolve = r;
  });
  chatLocks.set(event.chatId, current);

  try {
    await prev;
    await doContinueChat(api, config, event);
  } finally {
    resolve();
    // Clean up if we're still the latest
    if (chatLocks.get(event.chatId) === current) {
      chatLocks.delete(event.chatId);
    }
  }
}

async function doContinueChat(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
): Promise<void> {
  const { chatId, eventDescription } = event;
  const convCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const memCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;

  config.onLog?.({
    level: "info",
    message: `continueChat triggered: ${eventDescription}`,
    meta: { chatId, userId: event.userId },
  });

  try {
    // Build messages using ContextAssembler
    const messages = await assembleContinueChatContext({
      systemPrompt: config.systemPrompt,
      behavioralPrompt: config.behavioralPrompt,
      conversationConfig: config.conversationConfig,
      conversation: config.conversation,
      chatId,
      messageConfig: config.messageConfig,
      moodState: config.moodState,
      webToolsConfig: config.webToolsConfig,
      webTools: config.webTools,
      agentToolsConfig: config.agentToolsConfig,
      artworkToolsEnabled: config.artworkToolsConfig?.enabled,
      hasFileTools: !!config.dataFiles,
      dataFiles: config.dataFiles,
      stickerPacks: config.stickerPacks,
      botMemoryConfig: config.botMemoryConfig,
      botMemory: config.botMemory,
    });

    // Inject event as a system notification
    messages.push({
      role: "user",
      content: `[系统事件通知] ${eventDescription}`,
    });

    // Build tools
    let chatBotMsgIds = config.recentBotMessageIds.get(chatId);
    if (!chatBotMsgIds) {
      chatBotMsgIds = [];
      config.recentBotMessageIds.set(chatId, chatBotMsgIds);
    }

    const onceGuard = createOnceGuard();
    const timerDepth = event.timerDepth ?? 0;

    // Wrap onTimerFired to increment depth.
    // We bypass the original config.onTimerFired (which hardcodes timerDepth: 1)
    // and call continueChat directly so we can increment timerDepth properly.
    // The reused `config` still carries the original onTimerFired, so the next
    // doContinueChat will re-wrap it with the correct depth.
    const wrappedOnTimerFired = config.onTimerFired
      ? (tChatId: number, timerId: string, reason: string) => {
          const eventDescription = `定时器到期 (ID: ${timerId}): ${reason}\n请根据定时器的用途继续对话。`;
          continueChat(api, config, {
            chatId: tChatId,
            eventDescription,
            timerDepth: timerDepth + 1,
          }).catch((err) => {
            config.onLog?.({
              level: "error",
              message: `Timer continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
              meta: { chatId: tChatId, timerId },
            });
          });
        }
      : undefined;

    const telegramTools = createTelegramTools({
      api,
      chatId,
      recentBotMessageIds: chatBotMsgIds,
      pendingActions: config.pendingActions,
      onTimerFired: wrappedOnTimerFired,
      onceGuard,
    });

    const behaviorTools = createBehaviorTools({
      api,
      chatId,
      recentBotMessageIds: chatBotMsgIds,
      moodState: config.moodState,
      onLog: config.onLog,
      onceGuard,
    });

    const allTools: Record<string, CoreTool> = {
      ...telegramTools,
      ...behaviorTools,
      ...config.webTools,
    };

    // File tools
    if (config.dataFiles) {
      const fileTools = createFileTools({ dataDir: config.dataFiles.dataDir });
      Object.assign(allTools, fileTools);
    }

    // Remove set_timer when timer depth is too deep to prevent recursion
    if (timerDepth >= 2) {
      delete allTools.set_timer;
      config.onLog?.({
        level: "warn",
        message: "set_timer disabled due to timer depth limit",
        meta: { chatId, timerDepth },
      });
    }

    if (config.agentToolsFactory) {
      Object.assign(allTools, config.agentToolsFactory());
    }

    // Memory tools - only inject if configured
    if (memCfg.enabled && config.memory) {
      const { createMemoryTools } = await import("../tools/index.js");
      Object.assign(allTools, createMemoryTools(config.memory));
    }

    // Bot memory tools
    const botMemCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
    if (botMemCfg.enabled && config.botMemory) {
      const { createBotMemoryTools } = await import("../tools/bot-memory.js");
      Object.assign(allTools, createBotMemoryTools(config.botMemory));
    }

    // Artwork tools
    if (config.artworkToolsConfig?.enabled) {
      const { createArtworkTools } = await import("../tools/artwork/index.js");
      Object.assign(
        allTools,
        createArtworkTools({
          api,
          chatId,
          recentBotMessageIds: chatBotMsgIds,
          config: config.artworkToolsConfig,
          onceGuard,
          timeoutConfig: config.timeoutConfig,
        }),
      );
    }

    const startTime = Date.now();
    const result = await generateText({
      model: config.model,
      messages,
      tools: allTools,
      maxSteps: 5,
      toolChoice: "auto",
      abortSignal: AbortSignal.timeout(
        config.timeoutConfig?.aiReplyMs ?? DEFAULT_TIMEOUT_CONFIG.aiReplyMs,
      ),
    });
    const durationMs = Date.now() - startTime;

    // Record token usage
    config.onTokenUsage?.({
      chatId,
      userId: event.userId,
      model: config.modelId,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      durationMs,
      trigger: "event_continuation",
    });

    const text = result.text?.trim();

    // Check if multi_message was used (already sent messages directly)
    const hasMultiMessage = result.steps.some((s) =>
      s.toolCalls.some((tc) => tc.toolName === "multi_message"),
    );

    // Send reply and track message ID (skip if multi_message already handled it)
    if (!hasMultiMessage && text) {
      const msgCfg = config.messageConfig ?? DEFAULT_MESSAGE_CONFIG;
      const chunks = splitMessage(text, msgCfg.autoSplitThreshold);

      if (chunks.length <= 1) {
        // Single chunk: keep original truncation behavior
        const replyText =
          text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH - 3) + "..." : text;
        try {
          const html = markdownToTelegramHtml(replyText);
          const sent = await api.sendMessage(chatId, html, { parse_mode: "HTML" });
          chatBotMsgIds.push(sent.message_id);
        } catch {
          const sent = await api.sendMessage(chatId, replyText).catch(() => undefined);
          if (sent) chatBotMsgIds.push(sent.message_id);
        }
      } else {
        // Multi-chunk: send each chunk with typing delay
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) {
            await api.sendChatAction(chatId, "typing");
            await sleep(msgCfg.splitDelayMs);
          }
          try {
            const html = markdownToTelegramHtml(chunks[i]!);
            const sent = await api.sendMessage(chatId, html, { parse_mode: "HTML" });
            chatBotMsgIds.push(sent.message_id);
          } catch {
            const sent = await api.sendMessage(chatId, chunks[i]!).catch(() => undefined);
            if (sent) chatBotMsgIds.push(sent.message_id);
          }
        }
      }
    }

    // Save to conversation history
    if (config.conversation && convCfg.enabled) {
      const toSave: Array<{
        chatId: number;
        role: ConversationRole;
        content: string;
        userId?: number;
        userName?: string;
        meta?: Record<string, unknown>;
      }> = [];

      // Save the event as a system message
      toSave.push({
        chatId,
        role: "system",
        content: `[事件] ${eventDescription}`,
      });

      // Save assistant reply
      if (text) {
        toSave.push({
          chatId,
          role: "assistant",
          content: text,
          meta: { trigger: "event_continuation" },
        });
      }

      config.conversation.addMessages(toSave).catch((err) => {
        config.onLog?.({
          level: "error",
          message: `Failed to save continuation conversation: ${err instanceof Error ? err.message : String(err)}`,
          meta: { chatId },
        });
      });

      config.conversation.triggerCompression(chatId);
    }

    config.onLog?.({
      level: "info",
      message: "continueChat completed",
      meta: { chatId, textLength: text?.length ?? 0 },
    });
  } catch (err) {
    config.onLog?.({
      level: "error",
      message: `continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { chatId },
    });
  }
}
