import { createTurnInteractionTools } from "../tools/turn-interaction.js";
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
  ImageGenerationPort,
  TimeoutConfig,
  TokenUsageRecord,
  UsageGovernancePort,
  UserPrivacyCallbacks,
  WebToolsConfig,
} from "@cos-tool-bot/shared";
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
import { createDanbooruTools, createImageGenerationTools, createRssTools } from "../tools/index.js";
import type { MoodInfo, RssToolsOptions } from "../tools/index.js";
import { isTextCoveredByDeliveries } from "../utils/delivery.js";
import { sendMarkdownWithFallback } from "../utils/rich-message.js";
import { splitMessage } from "../utils/split-message.js";
import { sleep } from "../utils/sleep.js";
import { createOnceGuard, createPerStepAbort, createRequestCache } from "../tools/utils.js";
import { createFileTools } from "../tools/file-tools.js";
import { streamToChat } from "../utils/stream-reply.js";
import type { DataFilesConfig } from "../utils/data-files.js";
import type { BotSkillDefinition } from "../skills/catalog.js";
import { createSkillTools } from "../tools/skills.js";
import { filterMetaPrefixStream, stripMetaPrefix } from "../utils/strip-meta-prefix.js";
import { filterThinkingStream, stripThinkingContent } from "../utils/strip-thinking.js";
import { extractCacheTokenUsage } from "../utils/cache-usage.js";
import { startChatActionHeartbeat } from "../utils/chat-action-heartbeat.js";
import { composeTurnTools } from "../utils/tool-pipeline.js";
import {
  createCacheFingerprint,
  createToolSchemaHash,
  sortToolsForPromptCache,
} from "../utils/prompt-cache.js";
import { appendCurrentRequest, buildContinueChatPromptBundle } from "./context-assembler.js";
import type { PendingActionRegistry } from "./pending-actions.js";
import type { PendingAdminActionRegistry } from "./pending-github-actions.js";
import { KeyedIngressLock } from "./ai-ingress-lock.js";

/**
 * Serialises continuations for callers that supply no `runWithExecution`, keyed by
 * (botId, chatId) so two Bot runtimes in the same Chat never queue behind each other.
 */
export const fallbackExecutionLock = new KeyedIngressLock<string>();

export interface ContinueChatSelection {
  model: LanguageModel;
  modelId: string;
  providerId: string;
  temperature?: number;
  maxTokens?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  agentToolsFactory?: () => Record<string, Tool>;
}

export interface ContinueChatRunContext {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface ContinueChatConfig {
  botId: string;
  resolveSelection: (chatId: number) => Readonly<ContinueChatSelection>;
  isAiDisabled?: () => boolean;
  registerAbortController?: (c: AbortController) => void;
  unregisterAbortController?: (c: AbortController) => void;
  runWithExecution?: <T>(
    scope: { chatId: number; userId?: number },
    operation: (context: ContinueChatRunContext) => Promise<T>,
  ) => Promise<T>;
  systemPrompt: string;
  behavioralPrompt?: string;
  groupBehavioralPrompt?: string;
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
  imageGenerationPort?: ImageGenerationPort;
  skills?: readonly BotSkillDefinition[];
  isDelegatedGroupAdmin?: (chatId: number, userId: number) => Promise<boolean>;
  usageGovernance?: UsageGovernancePort;
  dataFiles?: DataFilesConfig;
  pendingActions: PendingActionRegistry;
  pendingAdminActions: PendingAdminActionRegistry;
  recentBotMessageIds: Map<number, number[]>;
  moodState: Map<number, MoodInfo>;
  stickerPacks?: string[];
  onTimerFired?: (chatId: number, timerId: string, reason: string) => Promise<void>;
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
  /** Longest set_timer duration, in seconds. Falls back to DEFAULT_TIMER_MAX_SECONDS. */
  timerMaxSeconds?: number;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  adminIds?: number[];
  rssCallbacks?: Omit<
    RssToolsOptions,
    "chatId" | "userId" | "adminChatIds" | "api" | "pendingActions" | "forceAdmin" | "allowWrites"
  >;
}

export interface ContinueChatEvent {
  chatId: number;
  eventDescription: string;
  userId?: number;
  userName?: string;
  timerDepth?: number;
  memoryless?: boolean;
  requireDelivery?: boolean;
  failureMessage?: string;
  allowRssWrites?: boolean;
}

export type ContinuationNotDeliveredReason =
  | "ownerless_private_event"
  | "ai_disabled"
  | "usage_denied"
  | "privacy_off"
  | "execution_cancelled";

const CONTINUATION_NOT_DELIVERED_MESSAGES: Record<ContinuationNotDeliveredReason, string> = {
  ownerless_private_event: "ownerless private event",
  ai_disabled: "AI is disabled",
  usage_denied: "usage limit reached",
  privacy_off: "personalization is off",
  execution_cancelled: "reply was aborted",
};

export class ContinuationNotDeliveredError extends Error {
  readonly code = "CONTINUATION_NOT_DELIVERED";

  constructor(readonly reason: ContinuationNotDeliveredReason) {
    super(`Continuation was not delivered: ${CONTINUATION_NOT_DELIVERED_MESSAGES[reason]}`);
    this.name = "ContinuationNotDeliveredError";
  }
}

function requireContinuationDelivery(
  event: ContinueChatEvent,
  reason: ContinuationNotDeliveredReason,
): void {
  if (event.requireDelivery) throw new ContinuationNotDeliveredError(reason);
}

async function sendContinuationFailureNotice(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
  executionContext?: ContinueChatRunContext,
): Promise<boolean> {
  if (!event.failureMessage || config.isAiDisabled?.()) return false;
  if (
    executionContext?.signal.aborted ||
    executionContext?.isCurrent() === false ||
    config.isAiDisabled?.()
  ) {
    return false;
  }
  try {
    await api.sendMessage(event.chatId, event.failureMessage);
    return true;
  } catch (error) {
    config.onLog?.({
      level: "error",
      message: "Failed to deliver continuation error",
      meta: {
        chatId: event.chatId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  }
}

async function scheduleContinuationFailureNotice(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
): Promise<boolean> {
  if (!event.failureMessage || config.isAiDisabled?.()) return false;
  const eventUserId = event.userId;
  const privacy = config.privacy;
  const sendWithPrivacy = (executionContext?: ContinueChatRunContext): Promise<boolean> => {
    if (eventUserId === undefined || !privacy) {
      return sendContinuationFailureNotice(api, config, event, executionContext);
    }
    return privacy.runExclusive(eventUserId, async () => {
      if ((await privacy.getMode(eventUserId)) === "off") {
        config.onLog?.({
          level: "info",
          message: "Continuation error delivery skipped because personalization is off",
          meta: { chatId: event.chatId, userId: eventUserId },
        });
        return false;
      }
      return sendContinuationFailureNotice(api, config, event, executionContext);
    });
  };
  try {
    if (config.runWithExecution) {
      return await config.runWithExecution(
        { chatId: event.chatId, userId: event.userId },
        sendWithPrivacy,
      );
    }
    return await fallbackExecutionLock.run(`${config.botId}:${event.chatId}`, () =>
      sendWithPrivacy(),
    );
  } catch (error) {
    config.onLog?.({
      level: "info",
      message: "Continuation error delivery cancelled",
      meta: {
        chatId: event.chatId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  }
}

export async function continueChat(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
): Promise<boolean> {
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
  const eventUserId = event.userId;
  const privacy = config.privacy;
  if (eventUserId === undefined && privacy && event.chatId > 0) {
    config.onLog?.({
      level: "warn",
      message: "Ownerless private continuation skipped because privacy cannot be evaluated",
      meta: { chatId: event.chatId },
    });
    requireContinuationDelivery(event, "ownerless_private_event");
    return false;
  }

  // Admit continuations before they enter the per-chat execution queue. Only the
  // scheduler's concurrency policy is allowed to queue work; usage ceilings reject
  // immediately and the reservation spans cancellation/privacy re-checks as well.
  if (config.isAiDisabled?.()) {
    config.onLog?.({
      level: "info",
      message: "continueChat skipped — AI disabled",
      meta: { chatId: event.chatId },
    });
    requireContinuationDelivery(event, "ai_disabled");
    return false;
  }
  const usageReservation = await config.usageGovernance?.reserve({
    botId: config.botId,
    resource: "ai_reply",
    chatKind: event.chatId > 0 ? "private" : "group",
    chatId: event.chatId,
    // System continuations count against Bot/chat ceilings, never an individual user.
    userId: undefined,
  });
  if (usageReservation && !usageReservation.allowed) {
    config.onLog?.({
      level: "info",
      message: "continueChat skipped by usage governance",
      meta: {
        chatId: event.chatId,
        reason: usageReservation.reason,
        scope: usageReservation.scope,
      },
    });
    if (await scheduleContinuationFailureNotice(api, executionConfig, event)) return true;
    requireContinuationDelivery(event, "usage_denied");
    return false;
  }
  const usageReservationId = usageReservation?.allowed ? usageReservation.reservationId : undefined;

  const runWithPrivacy = (executionContext?: ContinueChatRunContext): Promise<boolean> => {
    if (eventUserId === undefined || !privacy) {
      return doContinueChat(api, executionConfig, event, executionContext);
    }

    return privacy.runExclusive(eventUserId, async () => {
      // Re-read under the user lock so a queued continuation cannot use a stale mode.
      const privacyMode = await privacy.getMode(eventUserId);
      if (privacyMode === "off") {
        config.onLog?.({
          level: "info",
          message: "Personalized continuation skipped because personalization is off",
          meta: { chatId: event.chatId, userId: eventUserId },
        });
        requireContinuationDelivery(event, "privacy_off");
        return false;
      }
      return doContinueChat(api, executionConfig, event, executionContext);
    });
  };

  let succeeded = false;
  try {
    const result = config.runWithExecution
      ? await config.runWithExecution(
          { chatId: event.chatId, userId: event.userId },
          runWithPrivacy,
        )
      : await fallbackExecutionLock.run(`${config.botId}:${event.chatId}`, () => runWithPrivacy());
    succeeded = result;
    return result;
  } finally {
    if (usageReservationId && config.usageGovernance) {
      const operation = succeeded
        ? config.usageGovernance.settle({
            reservationId: usageReservationId,
            botId: config.botId,
            resource: "ai_reply",
          })
        : config.usageGovernance.refund({
            reservationId: usageReservationId,
            botId: config.botId,
            resource: "ai_reply",
          });
      await operation.catch((error) => {
        config.onLog?.({
          level: "error",
          message: "Failed to finalize continuation usage reservation",
          meta: {
            chatId: event.chatId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
  }
}

async function doContinueChat(
  api: Api,
  config: ContinueChatConfig,
  event: ContinueChatEvent,
  executionContext?: ContinueChatRunContext,
): Promise<boolean> {
  const { chatId, eventDescription } = event;
  const convCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
  const memCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const botMemCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;

  let successfulToolEffectCount = 0;
  let visibleDeliveryCount = 0;

  config.onLog?.({
    level: "info",
    message: "continueChat triggered",
    meta: { chatId, userId: event.userId, eventDescriptionLength: eventDescription.length },
  });

  let manualAbort: AbortController | null = null;
  let stopChatActionHeartbeat: (() => void) | undefined;
  const isExecutionCancelled = () =>
    !!config.isAiDisabled?.() ||
    !!manualAbort?.signal.aborted ||
    !!executionContext?.signal.aborted ||
    executionContext?.isCurrent() === false;
  try {
    const selection = config.resolveSelection(chatId);
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
      groupBehavioralPrompt: config.groupBehavioralPrompt,
      conversationConfig: config.conversationConfig,
      conversation: config.conversation,
      chatId,
      messageConfig: config.messageConfig,
      moodState: config.moodState,
      webToolsConfig: config.webToolsConfig,
      webTools: config.webTools,
      hasImageGeneration: !!config.imageGenerationPort,
      skills: config.skills,
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
      timerMaxSeconds: config.timerMaxSeconds,
    });

    const { messages, trace: promptTrace } = appendCurrentRequest(promptBundle, {
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
      ? async (tChatId: number, timerId: string, reason: string) => {
          const eventDescription = `定时器到期 (ID: ${timerId}): ${reason}\n请根据定时器的用途继续对话。`;
          try {
            await continueChat(api, config, {
              chatId: tChatId,
              eventDescription,
              userId: event.userId,
              timerDepth: timerDepth + 1,
              memoryless: event.memoryless,
              requireDelivery: true,
              allowRssWrites: event.allowRssWrites,
            });
          } catch (err) {
            config.onLog?.({
              level: "error",
              message: `Timer continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
              meta: { chatId: tChatId, timerId },
            });
            throw err;
          }
        }
      : undefined;

    const deliveredMultiMessages: string[] = [];
    const { telegramTools, behaviorTools, artworkTools } = createTurnInteractionTools({
      api,
      chatId,
      recentBotMessageIds: chatBotMsgIds,
      onceGuard,
      telegram: {
        userId: event.userId,
        getReplyableMessageIds: () => promptBundle.replyableMessageIds,
        pendingActions: config.pendingActions,
        onTimerFired: wrappedOnTimerFired,
        onTimerCreate:
          config.onTimerCreate && timerUserId !== undefined
            ? (params) => config.onTimerCreate?.({ ...params, userId: timerUserId })
            : undefined,
        onTimerCancel: config.onTimerCancel,
        onTimerFiredPersist: config.onTimerFiredPersist,
        timerMaxSeconds: config.timerMaxSeconds,
      },
      behavior: {
        moodState: config.moodState,
        richMessageEnabled: isRichMessageEnabled(config.messageConfig),
        onLog: config.onLog,
        onMultiMessageSent: (text) => {
          deliveredMultiMessages.push(text);
          visibleDeliveryCount += 1;
        },
      },
      artwork: config.artworkToolsConfig
        ? { config: config.artworkToolsConfig, timeoutConfig: config.timeoutConfig }
        : undefined,
    });

    const allTools: Record<string, Tool> = {
      ...telegramTools,
      ...behaviorTools,
      ...config.webTools,
      ...createDanbooruTools({ timeoutConfig: config.timeoutConfig }),
      ...createSkillTools({
        skills: config.skills ?? [],
        hasImageGeneration: !!config.imageGenerationPort && event.userId !== undefined,
        hasWebSearch: !!config.webTools?.web_search,
      }),
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

    if (selection.agentToolsFactory) {
      Object.assign(allTools, selection.agentToolsFactory());
    }

    if (memoryTools) Object.assign(allTools, memoryTools);
    if (botMemoryTools) Object.assign(allTools, botMemoryTools);

    if (config.imageGenerationPort && event.userId !== undefined) {
      const eventUserId = event.userId;
      const isPrivate = chatId > 0;
      const isBotAdmin = config.adminIds?.includes(eventUserId) === true;
      const isDelegatedGroupAdmin =
        !isPrivate && !isBotAdmin
          ? (await config.isDelegatedGroupAdmin?.(chatId, eventUserId)) === true
          : false;
      Object.assign(
        allTools,
        await createImageGenerationTools({
          port: config.imageGenerationPort,
          getActor: () => ({
            botId: config.botId,
            chatId,
            userId: eventUserId,
            chatType: isPrivate ? "private" : "supergroup",
            isBotAdmin,
            isDelegatedGroupAdmin,
          }),
        }),
      );
    }

    Object.assign(allTools, artworkTools);

    // RSS tools
    if (config.rssCallbacks) {
      const rssTools = createRssTools({
        ...config.rssCallbacks,
        chatId: event.chatId,
        userId: event.userId,
        adminChatIds: config.adminIds ?? [],
        api,
        pendingActions: config.pendingAdminActions,
        forceAdmin: event.userId == null,
        allowWrites: event.userId != null && event.allowRssWrites !== false,
      });
      Object.assign(allTools, rssTools);
    }

    // Remove multi_message tool in stream mode
    const isStreamMode = isStreamReplyMode(config.messageConfig);
    if (isStreamMode) {
      delete allTools.multi_message;
    }

    const stableTools = sortToolsForPromptCache(allTools);
    const toolSchemaHash = createToolSchemaHash(stableTools);
    const cacheFingerprint = createCacheFingerprint({
      providerId: selection.providerId,
      model: selection.modelId,
      staticPrefixHash: promptTrace.staticPrefixHash,
      toolSchemaHash,
    });
    config.onLog?.({
      level: "debug",
      message: "AI continuation request",
      meta: {
        chatId,
        providerId: selection.providerId,
        model: selection.modelId,
        staticPrefixHash: promptTrace.staticPrefixHash,
        toolSchemaHash,
        cacheFingerprint,
        toolsEnabled: Object.keys(stableTools),
      },
    });

    const startTime = Date.now();
    let streamedMessageCount = 0;
    let stepCounter = 0;
    const requestCache = createRequestCache();
    manualAbort = new AbortController();
    config.registerAbortController?.(manualAbort);
    const abortSignals: AbortSignal[] = [
      AbortSignal.timeout(config.timeoutConfig?.aiReplyMs ?? DEFAULT_TIMEOUT_CONFIG.aiReplyMs),
      manualAbort.signal,
    ];
    if (executionContext) abortSignals.push(executionContext.signal);
    const perStepAbort = createPerStepAbort(
      config.timeoutConfig?.perStepMs ?? DEFAULT_TIMEOUT_CONFIG.perStepMs,
      AbortSignal.any(abortSignals),
    );

    await api.sendChatAction(chatId, "typing").catch(() => {});
    stopChatActionHeartbeat = startChatActionHeartbeat(() => api.sendChatAction(chatId, "typing"));

    // ─── streamText (ai v6 API) ───
    const result = streamText({
      model: selection.model,
      messages,
      tools: composeTurnTools(stableTools, {
        requestCache,
        onLog: config.onLog,
        getStep: () => stepCounter + 1,
        onEffect: () => {
          successfulToolEffectCount += 1;
        },
      }),
      stopWhen: stepCountIs(config.memoryConfig?.maxSteps ?? DEFAULT_MEMORY_CONFIG.maxSteps),
      toolChoice: "auto",
      abortSignal: perStepAbort.signal,
      temperature: selection.temperature,
      maxOutputTokens: selection.maxTokens,
      providerOptions: selection.providerOptions,
      experimental_onToolCallStart: () => perStepAbort.pause(),
      experimental_onToolCallFinish: () => perStepAbort.resume(),
      onStepFinish: () => {
        stepCounter++;
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
          streamedMessageCount = sentMessages.length;
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
    visibleDeliveryCount += streamedMessageCount;

    // If /stop fired while streamText was running, drop all pending sends + saves.
    if (isExecutionCancelled()) {
      config.onLog?.({
        level: "info",
        message: "continueChat aborted mid-reply, dropping pending sends",
        meta: { chatId },
      });
      if (successfulToolEffectCount === 0 && visibleDeliveryCount === 0) {
        requireContinuationDelivery(event, "execution_cancelled");
      }
      return successfulToolEffectCount > 0 || visibleDeliveryCount > 0;
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
    stopChatActionHeartbeat();
    stopChatActionHeartbeat = undefined;
    const deliveredMultiMessageContent = deliveredMultiMessages.join("\n");
    const sentViaMultiMessage = deliveredMultiMessages.length > 0;
    const trailingTextCovered =
      sentViaMultiMessage && isTextCoveredByDeliveries(text, deliveredMultiMessages);
    const deliveredFinalChunks: string[] = [];

    // Send text unless its complete content is already confirmed as delivered.
    if ((!isStreamMode && !trailingTextCovered && text) || (streamFailed && text)) {
      const msgCfg = config.messageConfig ?? DEFAULT_MESSAGE_CONFIG;
      const threshold = msgCfg.autoSplitThreshold ?? 0;
      const chunks = splitMessage(text, threshold > 0 ? threshold : 4096);
      for (const [i, chunk] of chunks.entries()) {
        if (isExecutionCancelled()) break;
        if (i > 0) {
          await api.sendChatAction(chatId, "typing").catch(() => {});
          await sleep(msgCfg.splitDelayMs ?? 800);
          if (isExecutionCancelled()) break;
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
          deliveredFinalChunks.push(chunk);
          visibleDeliveryCount += 1;
        } catch (sendError) {
          config.onLog?.({
            level: "error",
            message: `Rich Message fallbacks failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
            meta: { chatId },
          });
          if (
            event.requireDelivery &&
            successfulToolEffectCount === 0 &&
            visibleDeliveryCount === 0
          ) {
            throw sendError;
          }
        }
      }
    }
    const assistantContent = sentViaMultiMessage
      ? [deliveredMultiMessageContent, ...deliveredFinalChunks].filter(Boolean).join("\n")
      : text;

    if (event.requireDelivery && visibleDeliveryCount === 0) {
      if (isExecutionCancelled()) {
        if (successfulToolEffectCount === 0) {
          requireContinuationDelivery(event, "execution_cancelled");
        }
        return true;
      }
      try {
        const { message } = await sendMarkdownWithFallback(
          api,
          chatId,
          "(事件已处理，但 AI 未生成回复内容)",
          isRichMessageEnabled(config.messageConfig),
        );
        chatBotMsgIds.push(message.message_id);
        visibleDeliveryCount += 1;
      } catch (emptyReplyError) {
        if (successfulToolEffectCount === 0) throw emptyReplyError;
        config.onLog?.({
          level: "warn",
          message: "Continuation fallback failed after a successful tool effect",
          meta: { chatId },
        });
      }
    }

    // Await full results for post-processing
    const steps = await result.steps;
    const usage = await result.usage;
    const durationMs = Date.now() - startTime;

    // Record token usage
    config.onTokenUsage?.({
      chatId,
      userId: event.userId,
      model: selection.modelId,
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      ...extractCacheTokenUsage(
        usage,
        steps.map((step) => step.usage),
      ),
      providerId: selection.providerId,
      staticPrefixHash: promptTrace.staticPrefixHash,
      toolSchemaHash,
      cacheFingerprint,
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
      if (assistantContent) {
        toSave.push({
          chatId,
          role: "assistant",
          content: assistantContent,
          meta: { trigger: "event_continuation" },
        });
      }

      if (isExecutionCancelled() && visibleDeliveryCount === 0) {
        if (successfulToolEffectCount === 0) {
          requireContinuationDelivery(event, "execution_cancelled");
        }
        return true;
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
        textLength: assistantContent.length,
        responseTextLength: text?.length ?? 0,
        multiMessageSentCount: deliveredMultiMessages.length,
      },
    });
    return visibleDeliveryCount > 0 || successfulToolEffectCount > 0;
  } catch (err) {
    config.onLog?.({
      level: "error",
      message: `continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { chatId },
    });
    if (successfulToolEffectCount > 0 || visibleDeliveryCount > 0) return true;
    if (isExecutionCancelled()) {
      requireContinuationDelivery(event, "execution_cancelled");
      return false;
    }
    if (await sendContinuationFailureNotice(api, config, event, executionContext)) return true;
    if (isExecutionCancelled()) {
      requireContinuationDelivery(event, "execution_cancelled");
      return false;
    }
    if (event.requireDelivery) throw err;
    return false;
  } finally {
    stopChatActionHeartbeat?.();
    if (manualAbort) config.unregisterAbortController?.(manualAbort);
  }
}
