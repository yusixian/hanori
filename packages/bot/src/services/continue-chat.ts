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
  PixAIGenerationRecord,
  TimeoutConfig,
  TokenUsageRecord,
  UserPrivacyCallbacks,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
import type { PixAIRateLimiter } from "./pixai-rate-limiter.js";
import {
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
  DEFAULT_TIMEOUT_CONFIG,
  isRichMessageEnabled,
  isStreamReplyMode,
} from "@cos-tool-bot/shared";
import type { JSONValue, LanguageModel, Tool } from "ai";
import { stepCountIs, streamText } from "ai";
import type { Api } from "grammy";
import {
  createBehaviorTools,
  createRssTools,
  createTelegramTools,
  injectPixAITool,
} from "../tools/index.js";
import type { MoodInfo, RssToolsOptions } from "../tools/index.js";
import { sendMarkdownWithFallback } from "../utils/rich-message.js";
import { splitMessage } from "../utils/split-message.js";
import { sleep } from "../utils/sleep.js";
import {
  createOnceGuard,
  createPerStepAbort,
  createRequestCache,
  wrapToolsWithCache,
} from "../tools/utils.js";
import { createFileTools } from "../tools/file-tools.js";
import { streamToChat } from "../utils/stream-reply.js";
import type { DataFilesConfig } from "../utils/data-files.js";
import { filterMetaPrefixStream, stripMetaPrefix } from "../utils/strip-meta-prefix.js";
import { filterThinkingStream, stripThinkingContent } from "../utils/strip-thinking.js";
import { appendCurrentRequest, buildContinueChatPromptBundle } from "./context-assembler.js";
import type { PendingActionRegistry } from "./pending-actions.js";
import { withChatLock } from "./chat-lock.js";

export interface ContinueChatConfig {
  model: LanguageModel;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  isAiDisabled?: () => boolean;
  registerAbortController?: (c: AbortController) => void;
  unregisterAbortController?: (c: AbortController) => void;
  systemPrompt: string;
  behavioralPrompt?: string;
  conversationConfig?: ConversationConfig;
  conversation?: ConversationCallbacks;
  privacy?: UserPrivacyCallbacks;
  memoryConfig?: MemoryConfig;
  memory?: MemoryCallbacks;
  botMemoryConfig?: BotMemoryConfig;
  botMemory?: BotMemoryCallbacks;
  messageConfig?: MessageConfig;
  webToolsConfig?: WebToolsConfig;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsConfig?: ArtworkToolsConfig;
  timeoutConfig?: TimeoutConfig;
  webTools?: Record<string, Tool>;
  agentToolsFactory?: () => Record<string, Tool>;
  dataFiles?: DataFilesConfig;
  pendingActions: PendingActionRegistry;
  recentBotMessageIds: Map<number, number[]>;
  moodState: Map<number, MoodInfo>;
  stickerPacks?: string[];
  onTimerFired?: (chatId: number, timerId: string, reason: string) => void;
  onTimerCreate?: (params: {
    timerId: string;
    chatId: number;
    seconds: number;
    reason: string;
    userId: number;
  }) => void;
  onTimerCancel?: (timerId: string) => void;
  onTimerFiredPersist?: (timerId: string) => void;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  onGenerationTrack?: (record: PixAIGenerationRecord) => void | Promise<void>;
  imageGenerationAllowed?: boolean;
  rateLimiter?: PixAIRateLimiter;
  adminIds?: number[];
  rssCallbacks?: Omit<RssToolsOptions, "chatId" | "adminChatIds">;
}

export interface ContinueChatEvent {
  chatId: number;
  eventDescription: string;
  userId?: number;
  userName?: string;
  timerDepth?: number;
  memoryless?: boolean;
}

export async function continueChat(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
): Promise<void> {
  const executionConfig = event.memoryless
    ? {
        ...config,
        memory: undefined,
        memoryConfig: { ...DEFAULT_MEMORY_CONFIG, enabled: false },
        botMemory: undefined,
        botMemoryConfig: { ...DEFAULT_BOT_MEMORY_CONFIG, enabled: false },
        moodState: new Map<number, MoodInfo>(),
      }
    : config;
  const run = () =>
    // Shared per-chat lock: mutually exclusive with the main AI-reply handler's streamText.
    withChatLock(event.chatId, () => doContinueChat(api, executionConfig, event));
  const eventUserId = event.userId;
  const privacy = config.privacy;
  if (eventUserId === undefined && privacy && event.chatId > 0) {
    config.onLog?.({
      level: "warn",
      message: "Ownerless private continuation skipped because privacy cannot be evaluated",
      meta: { chatId: event.chatId },
    });
    return;
  }
  if (eventUserId === undefined || !privacy) {
    await run();
    return;
  }

  await privacy.runExclusive(eventUserId, async () => {
    const privacyMode = await privacy.getMode(eventUserId);
    if (privacyMode === "off") {
      config.onLog?.({
        level: "info",
        message: "Personalized continuation skipped because personalization is off",
        meta: { chatId: event.chatId, userId: eventUserId },
      });
      return;
    }
    await run();
  });
}

async function doContinueChat(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
): Promise<void> {
  const { chatId, eventDescription } = event;
  const convCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const memCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const botMemCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;

  // Global AI kill switch check — skip entirely if /stop is active
  if (config.isAiDisabled?.()) {
    config.onLog?.({
      level: "info",
      message: "continueChat skipped — AI disabled",
      meta: { chatId },
    });
    return;
  }

  config.onLog?.({
    level: "info",
    message: `continueChat triggered: ${eventDescription}`,
    meta: { chatId, userId: event.userId },
  });

  let manualAbort: AbortController | null = null;
  try {
    let memoryTools: Record<string, Tool> | undefined;
    if (memCfg.enabled && config.memory) {
      const { createMemoryTools } = await import("../tools/index.js");
      memoryTools = createMemoryTools(config.memory);
    }
    let botMemoryTools: Record<string, Tool> | undefined;
    if (botMemCfg.enabled && config.botMemory) {
      const { createBotMemoryTools } = await import("../tools/bot-memory.js");
      botMemoryTools = createBotMemoryTools(config.botMemory);
    }

    // Build messages using ContextAssembler
    const promptBundle = await buildContinueChatPromptBundle({
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
      memoryTools,
      botMemoryTools,
      botMemoryConfig: config.botMemoryConfig,
      botMemory: config.botMemory,
      retrievalQuery: eventDescription,
      userId: event.userId,
    });

    const { messages } = appendCurrentRequest(promptBundle, {
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
    const timerUserId = event.userId;

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
            userId: event.userId,
            timerDepth: timerDepth + 1,
            memoryless: event.memoryless,
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
      userId: event.userId,
      recentBotMessageIds: chatBotMsgIds,
      pendingActions: config.pendingActions,
      onTimerFired: wrappedOnTimerFired,
      onTimerCreate:
        config.onTimerCreate && timerUserId !== undefined
          ? (params) => config.onTimerCreate?.({ ...params, userId: timerUserId })
          : undefined,
      onTimerCancel: config.onTimerCancel,
      onTimerFiredPersist: config.onTimerFiredPersist,
      onceGuard,
    });

    const deliveredMultiMessages: string[] = [];
    const behaviorTools = createBehaviorTools({
      api,
      chatId,
      recentBotMessageIds: chatBotMsgIds,
      moodState: config.moodState,
      richMessageEnabled: isRichMessageEnabled(config.messageConfig),
      onLog: config.onLog,
      onMultiMessageSent: (text) => deliveredMultiMessages.push(text),
    });

    const allTools: Record<string, Tool> = {
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

    if (memoryTools) Object.assign(allTools, memoryTools);
    if (botMemoryTools) Object.assign(allTools, botMemoryTools);

    // PixAI image generation (per-request, fire-and-forget) + permission control + rate limiting
    injectPixAITool(allTools, {
      allowed: !!config.imageGenerationAllowed,
      webToolsConfig: config.webToolsConfig,
      api,
      chatId,
      userId: event.userId,
      recentBotMessageIds: chatBotMsgIds,
      timeoutConfig: config.timeoutConfig,
      onLog: config.onLog,
      onGenerationTrack: config.onGenerationTrack,
      rateLimiter: config.rateLimiter,
      adminIds: config.adminIds,
    });

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

    // RSS tools
    if (config.rssCallbacks) {
      const rssTools = createRssTools({
        ...config.rssCallbacks,
        chatId: event.chatId,
        adminChatIds: config.adminIds ?? [],
        forceAdmin: event.userId == null,
      });
      Object.assign(allTools, rssTools);
    }

    // Remove multi_message tool in stream mode
    const isStreamMode = isStreamReplyMode(config.messageConfig);
    if (isStreamMode) {
      delete allTools.multi_message;
    }

    const startTime = Date.now();
    const requestCache = createRequestCache();
    manualAbort = new AbortController();
    config.registerAbortController?.(manualAbort);
    const perStepAbort = createPerStepAbort(
      config.timeoutConfig?.perStepMs ?? DEFAULT_TIMEOUT_CONFIG.perStepMs,
      AbortSignal.any([
        AbortSignal.timeout(config.timeoutConfig?.aiReplyMs ?? DEFAULT_TIMEOUT_CONFIG.aiReplyMs),
        manualAbort.signal,
      ]),
    );

    // ─── streamText (ai v6 API) ───
    const result = streamText({
      model: config.model,
      messages,
      tools: wrapToolsWithCache(allTools, requestCache),
      stopWhen: stepCountIs(5),
      toolChoice: "auto",
      abortSignal: perStepAbort.signal,
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens,
      providerOptions: config.providerOptions,
      experimental_onToolCallStart: () => perStepAbort.pause(),
      experimental_onToolCallFinish: () => perStepAbort.resume(),
      onStepFinish: () => {
        perStepAbort.reset();
      },
    });

    let streamFailed = false;
    try {
      if (isStreamMode) {
        // Stream mode: pipe text chunks through the configured Telegram draft format.
        // multi_message is deleted in stream mode.
        try {
          const thinkFiltered = filterThinkingStream(
            result.textStream,
            ({ pattern, strippedLength }) => {
              config.onLog?.({
                level: "info",
                message: `Stripped thinking content from continueChat stream (pattern: ${pattern}, ${strippedLength} chars)`,
                meta: { chatId },
              });
            },
          );
          const filteredStream = filterMetaPrefixStream(
            thinkFiltered,
            ({ pattern, strippedLength }) => {
              config.onLog?.({
                level: "warn",
                message: `Stripped meta prefix from continueChat stream (pattern: ${pattern}, ${strippedLength} chars)`,
                meta: { chatId },
              });
            },
          );
          const { sentMessages } = await streamToChat(
            api,
            chatId,
            filteredStream,
            isRichMessageEnabled(config.messageConfig),
          );
          for (const msg of sentMessages) {
            chatBotMsgIds.push(msg.message_id);
          }
        } catch (streamErr) {
          streamFailed = true;
          config.onLog?.({
            level: "warn",
            message: `streamToChat failed, falling back to text: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
            meta: { chatId },
          });
        }
      } else {
        // Segment mode: drain the stream to drive tool execution, then send text manually.
        // We do NOT call streamToChat here to avoid sending empty drafts to Telegram.
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional drain
        for await (const _ of result.textStream) {
        }
      }
    } finally {
      perStepAbort.cleanup();
    }

    // If /stop fired while streamText was running, drop all pending sends + saves.
    if (config.isAiDisabled?.() || manualAbort.signal.aborted) {
      config.onLog?.({
        level: "info",
        message: "continueChat aborted mid-reply, dropping pending sends",
        meta: { chatId },
      });
      return;
    }

    const afterThink = stripThinkingContent(
      (await result.text).trim(),
      ({ pattern, strippedLength }) => {
        config.onLog?.({
          level: "info",
          message: `Stripped thinking content from continueChat segment (pattern: ${pattern}, ${strippedLength} chars)`,
          meta: { chatId },
        });
      },
    );
    const text = stripMetaPrefix(afterThink, ({ pattern, strippedLength }) => {
      config.onLog?.({
        level: "warn",
        message: `Stripped meta prefix from continueChat segment (pattern: ${pattern}, ${strippedLength} chars)`,
        meta: { chatId },
      });
    });
    const deliveredMultiMessageContent = deliveredMultiMessages.join("\n");
    const sentViaMultiMessage = deliveredMultiMessages.length > 0;

    // Send text if multi_message wasn't used (segment mode) or stream failed
    if ((!isStreamMode && !sentViaMultiMessage && text) || (streamFailed && text)) {
      const msgCfg = config.messageConfig ?? DEFAULT_MESSAGE_CONFIG;
      const threshold = msgCfg.autoSplitThreshold ?? 0;
      const chunks = splitMessage(text, threshold > 0 ? threshold : 4096);
      for (const [i, chunk] of chunks.entries()) {
        if (config.isAiDisabled?.() || manualAbort.signal.aborted) break;
        if (i > 0) {
          await api.sendChatAction(chatId, "typing").catch(() => {});
          await sleep(msgCfg.splitDelayMs ?? 800);
          if (config.isAiDisabled?.() || manualAbort.signal.aborted) break;
        }
        try {
          const { message } = await sendMarkdownWithFallback(
            api,
            chatId,
            chunk,
            isRichMessageEnabled(config.messageConfig),
            undefined,
            (mode, error) => {
              config.onLog?.({
                level: "warn",
                message: `${mode === "rich" ? "Rich Message" : "HTML"} continueChat delivery failed, falling back`,
                meta: {
                  chatId,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            },
          );
          chatBotMsgIds.push(message.message_id);
        } catch (sendError) {
          config.onLog?.({
            level: "error",
            message: `Rich Message fallbacks failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
            meta: { chatId },
          });
        }
      }
    }

    // Await full results for post-processing
    const usage = await result.usage;
    const durationMs = Date.now() - startTime;

    // Record token usage
    config.onTokenUsage?.({
      chatId,
      userId: event.userId,
      model: config.modelId,
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      durationMs,
      trigger: "event_continuation",
    });

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

      // Save the exact assistant content delivered to the chat.
      const assistantContent = sentViaMultiMessage ? deliveredMultiMessageContent : text;
      if (assistantContent) {
        toSave.push({
          chatId,
          role: "assistant",
          content: assistantContent,
          meta: { trigger: "event_continuation" },
        });
      }

      try {
        await config.conversation.addMessages(toSave);
        await config.conversation.triggerCompression(chatId);
      } catch (err) {
        config.onLog?.({
          level: "error",
          message: `Failed to save continuation conversation: ${err instanceof Error ? err.message : String(err)}`,
          meta: { chatId },
        });
      }
    }

    config.onLog?.({
      level: "info",
      message: "continueChat completed",
      meta: {
        chatId,
        textLength: sentViaMultiMessage ? deliveredMultiMessageContent.length : (text?.length ?? 0),
        responseTextLength: text?.length ?? 0,
        multiMessageSentCount: deliveredMultiMessages.length,
      },
    });
  } catch (err) {
    config.onLog?.({
      level: "error",
      message: `continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { chatId },
    });
  } finally {
    if (manualAbort) config.unregisterAbortController?.(manualAbort);
  }
}
