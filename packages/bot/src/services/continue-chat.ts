import type {
  AgentToolsConfig,
  BotLogEntry,
  BotMemoryCallbacks,
  BotMemoryConfig,
  ConversationCallbacks,
  ConversationConfig,
  ConversationRole,
  MemoryCallbacks,
  MemoryConfig,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
} from "@cos-tool-bot/shared";
import type { CoreTool, LanguageModelV1 } from "ai";
import { generateText } from "ai";
import type { Api } from "grammy";
import { createBehaviorTools, createTelegramTools } from "../tools/index.js";
import type { MoodInfo } from "../tools/index.js";
import { markdownToTelegramHtml } from "../utils/format.js";
import type { PendingActionRegistry } from "./pending-actions.js";

const MAX_MESSAGE_LENGTH = 4096;

// Per-chat promise chain to prevent concurrent generateText calls
const chatLocks = new Map<number, Promise<void>>();

export interface ContinueChatConfig {
  model: LanguageModelV1;
  systemPrompt: string;
  behavioralPrompt?: string;
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  memoryConfig?: MemoryConfig;
  memory?: MemoryCallbacks;
  botMemoryConfig?: BotMemoryConfig;
  botMemory?: BotMemoryCallbacks;
  webToolsConfig?: WebToolsConfig;
  agentToolsConfig?: AgentToolsConfig;
  webTools?: Record<string, CoreTool>;
  agentToolsFactory?: () => Record<string, CoreTool>;
  pendingActions: PendingActionRegistry;
  recentBotMessageIds: Map<number, number[]>;
  moodState: Map<number, MoodInfo>;
  onTimerFired?: (chatId: number, timerId: string, reason: string) => void;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
}

export interface ContinueChatEvent {
  chatId: number;
  eventDescription: string;
  userId?: number;
  userName?: string;
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
    // Build messages
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

    // Load conversation history if available
    if (config.conversation && convCfg.enabled) {
      const history = await config.conversation.getHistory(chatId, convCfg.maxContextMessages);

      const parts: string[] = [config.systemPrompt];
      if (history.summary) parts.push(`[对话摘要]\n${history.summary}`);
      if (history.messages.length > 0) {
        const historyLines = history.messages.map((msg) => {
          if (msg.role === "context") return `[群聊上下文]\n${msg.content}`;
          const prefix = msg.role === "assistant" ? "AI" : msg.userName || "User";
          return `${prefix}: ${msg.content}`;
        });
        parts.push(`[对话历史]\n${historyLines.join("\n")}\n[对话历史结束]`);
      }

      messages.push({ role: "system", content: parts.join("\n\n") });
    } else {
      messages.push({ role: "system", content: config.systemPrompt });
    }

    // Inject behavioral prompt
    if (config.behavioralPrompt && messages[0]) {
      messages[0].content += `\n\n${config.behavioralPrompt}`;
    }

    // Inject mood
    const currentMood = config.moodState.get(chatId);
    if (currentMood && messages[0]) {
      const moodStr = currentMood.reason
        ? `[当前情绪: ${currentMood.mood}，原因: ${currentMood.reason}]`
        : `[当前情绪: ${currentMood.mood}]`;
      messages[0].content += `\n\n${moodStr}`;
    }

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

    const telegramTools = createTelegramTools({
      api,
      chatId,
      recentBotMessageIds: chatBotMsgIds,
      pendingActions: config.pendingActions,
      onTimerFired: config.onTimerFired,
    });

    const behaviorTools = createBehaviorTools({
      api,
      chatId,
      recentBotMessageIds: chatBotMsgIds,
      moodState: config.moodState,
      onLog: config.onLog,
    });

    const allTools: Record<string, CoreTool> = {
      ...telegramTools,
      ...behaviorTools,
      ...config.webTools,
    };

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

    const result = await generateText({
      model: config.model,
      messages,
      tools: allTools,
      maxSteps: 5,
      toolChoice: "auto",
    });

    const text = result.text?.trim();

    // Send reply and track message ID
    if (text) {
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
