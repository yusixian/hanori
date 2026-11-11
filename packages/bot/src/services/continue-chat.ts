import type { ScheduledTaskPort } from "@cos-tool-bot/shared";
import { imageToolCompletion } from "../utils/image-generation-status.js";
import type { PluginRuntimePort, PluginTurnSession } from "@cos-tool-bot/shared";
import {
  createTurnToolset,
  resolveImageGenerationActor,
  type TurnToolsetConfig,
} from "../tools/turn-toolset.js";
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
  GenerationLibraryActor,
  GenerationLibraryPort,
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
import { prepareFinalAnswerStep } from "../utils/final-answer-step.js";
import type { Api } from "grammy";
import type { MoodInfo, RssToolsOptions } from "../tools/index.js";
import { isTextCoveredByDeliveries } from "../utils/delivery.js";
import { sendMarkdownWithFallback } from "../utils/rich-message.js";
import { splitMessage } from "../utils/split-message.js";
import { sleep } from "../utils/sleep.js";
import { createOnceGuard, createPerStepAbort, createRequestCache } from "../tools/utils.js";
import { streamToChat } from "../utils/stream-reply.js";
import type { DataFilesConfig } from "../utils/data-files.js";
import type { BotSkillDefinition } from "../skills/catalog.js";
import { filterMetaPrefixStream, stripMetaPrefix } from "../utils/strip-meta-prefix.js";
import { filterThinkingStream, stripThinkingContent } from "../utils/strip-thinking.js";
import { extractCacheTokenUsage } from "../utils/cache-usage.js";
import { startChatActionHeartbeat } from "../utils/chat-action-heartbeat.js";
import { composeTurnTools } from "../utils/tool-pipeline.js";
import { createCacheFingerprint, createToolSchemaHash } from "../utils/prompt-cache.js";
import { appendCurrentRequest, buildContinueChatPromptBundle } from "./context-assembler.js";
import type { PendingActionRegistry } from "./pending-actions.js";
import type { PendingAdminActionRegistry } from "./pending-github-actions.js";
import { KeyedIngressLock } from "./ai-ingress-lock.js";
import { createAiTurnLogger } from "../utils/ai-turn-log.js";
import { throwCapturedStreamError } from "../utils/stream-error.js";
import { getTurnResponseTexts } from "../utils/turn-response-text.js";

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
  agentToolsFactory?: (
    actor?: GenerationLibraryActor,
    plugins?: (signal?: AbortSignal) => Promise<PluginTurnSession>,
  ) => Record<string, Tool>;
}

export interface ContinueChatRunContext {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface ContinueChatConfig {
  scheduledTasks?: ScheduledTaskPort;
  onOwnMessageEdited?: (chatId: number, messageId: number, content: string) => void;
  diagnosticSecrets?: readonly string[];
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
  unifiedSearchEnabled?: boolean;
  plugins?: PluginRuntimePort;
  agentToolsConfig?: AgentToolsConfig;
  artworkToolsConfig?: ArtworkToolsConfig;
  timeoutConfig?: TimeoutConfig;
  webTools?: Record<string, Tool>;
  imageGenerationPort?: ImageGenerationPort;
  imageGenerationConfirmation?: "always" | "never";
  groupOverrides?: Record<string, import("@cos-tool-bot/shared").AiGroupOverride>;
  generationLibraryPort?: GenerationLibraryPort;
  skills?: readonly BotSkillDefinition[];
  isDelegatedGroupAdmin?: (chatId: number, userId: number) => Promise<boolean>;
  usageGovernance?: UsageGovernancePort;
  dataFiles?: DataFilesConfig;
  pendingActions: PendingActionRegistry;
  pendingAdminActions: PendingAdminActionRegistry;
  recentBotMessageIds: Map<number, number[]>;
  moodState: Map<number, MoodInfo>;
  onTimerFired?: (chatId: number, timerId: string, reason: string) => Promise<void>;
  onTimerCreate?: (params: {
    timerId: string;
    chatId: number;
    seconds: number;
    reason: string;
    userId: number;
    handle: ReturnType<typeof setTimeout>;
  }) => void | Promise<void>;
  onTimerCancel?: (timerId: string) => void | Promise<void>;
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
        error,
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
        error,
      },
    });
    return false;
  }
}

export async function continueChat(
  api: Api,
  inputConfig: ContinueChatConfig,
  event: ContinueChatEvent,
): Promise<boolean> {
  const config: ContinueChatConfig = {
    ...inputConfig,
    onLog: createAiTurnLogger(
      inputConfig.onLog,
      {
        botId: inputConfig.botId,
        chatId: event.chatId,
        userId: event.userId,
        eventType: "continuation",
      },
      inputConfig.diagnosticSecrets,
    ),
  };
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
      return doContinueChat(api, executionConfig, event, executionContext, privacyMode);
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
            error,
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
  privacyMode?: "normal" | "isolated" | "off",
): Promise<boolean> {
  const { chatId, eventDescription } = event;
  const convCfg = config.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;

  let successfulToolEffectCount = 0;
  let imageCompletion: string | undefined;
  let visibleDeliveryCount = 0;
  let providerStreamError: unknown;
  let selectedProviderId: string | undefined;
  let selectedModelId: string | undefined;

  config.onLog?.({
    level: "info",
    message: "continueChat triggered",
    meta: { chatId, userId: event.userId, eventDescriptionLength: eventDescription.length },
  });

  let disposePluginTools: (() => Promise<void>) | undefined;
  let manualAbort: AbortController | null = null;
  let stopChatActionHeartbeat: (() => void) | undefined;
  const isExecutionCancelled = () =>
    !!config.isAiDisabled?.() ||
    !!manualAbort?.signal.aborted ||
    !!executionContext?.signal.aborted ||
    executionContext?.isCurrent() === false;
  try {
    manualAbort = new AbortController();
    config.registerAbortController?.(manualAbort);
    const selection = config.resolveSelection(chatId);
    selectedProviderId = selection.providerId;
    selectedModelId = selection.modelId;

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
              meta: { chatId: tChatId, timerId, error: err },
            });
            throw err;
          }
        }
      : undefined;

    const deliveredMultiMessages: string[] = [];
    const deliveredMessages = new Map<number, string>();
    let replyableMessageIds: readonly number[] = [];
    const isPrivate = chatId > 0;
    const toolsetConfig: TurnToolsetConfig = {
      botId: config.botId,
      adminIds: config.adminIds,
      memoryConfig: config.memoryConfig,
      memory: config.memory,
      botMemoryConfig: config.botMemoryConfig,
      botMemory: config.botMemory,
      messageConfig: config.messageConfig,
      webTools: config.webTools,
      unifiedSearchEnabled: config.unifiedSearchEnabled === true,
      plugins: config.plugins,
      artworkToolsConfig: config.artworkToolsConfig,
      timeoutConfig: config.timeoutConfig,
      dataFiles: config.dataFiles,
      skills: config.skills,
      generationLibraryPort: config.generationLibraryPort,
      imageGenerationPort: config.imageGenerationPort,
      scheduledTasks: config.scheduledTasks,
      imageGenerationConfirmation: config.imageGenerationConfirmation,
      groupOverrides: config.groupOverrides,
      isDelegatedGroupAdmin: config.isDelegatedGroupAdmin,
      rssCallbacks: config.rssCallbacks,
      pendingAdminActions: config.pendingAdminActions,
    };
    const toolset = await createTurnToolset({
      signal: AbortSignal.any([
        ...(executionContext ? [executionContext.signal] : []),
        ...(manualAbort ? [manualAbort.signal] : []),
      ]),
      entry: { kind: "continue", timerDepth, allowRssWrites: event.allowRssWrites },
      chatId,
      isPrivate,
      userId: event.userId,
      privacyMode,
      imageGenerationActor: await resolveImageGenerationActor(toolsetConfig, {
        chatId,
        isPrivate,
        userId: event.userId,
      }),
      api,
      config: toolsetConfig,
      interaction: {
        recentBotMessageIds: chatBotMsgIds,
        onceGuard,
        telegram: {
          getReplyableMessageIds: () => replyableMessageIds,
          conversation: convCfg.enabled ? config.conversation : undefined,
          richMessageEnabled: isRichMessageEnabled(config.messageConfig),
          onTextMessageSent: (id, content) => {
            deliveredMessages.set(id, content);
          },
          onOwnMessageEdited: (id, content) => {
            if (deliveredMessages.has(id)) deliveredMessages.set(id, content);
            config.onOwnMessageEdited?.(chatId, id, content);
          },
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
          onMultiMessageSent: (text, id) => {
            deliveredMessages.set(id, text);
            deliveredMultiMessages.push(text);
            visibleDeliveryCount += 1;
          },
        },
      },
      delegation: selection.agentToolsFactory,
      onLog: config.onLog,
    });
    disposePluginTools = toolset.dispose;

    const promptBundle = await buildContinueChatPromptBundle({
      systemPrompt: config.systemPrompt,
      behavioralPrompt: config.behavioralPrompt,
      groupBehavioralPrompt: config.groupBehavioralPrompt,
      conversationConfig: config.conversationConfig,
      conversation: config.conversation,
      chatId,
      messageConfig: config.messageConfig,
      moodState: config.moodState,
      toolCapabilities: toolset.capabilities,
      webToolsConfig: config.webToolsConfig,
      skills: config.skills,
      agentToolsConfig: config.agentToolsConfig,
      dataFiles: config.dataFiles,
      botMemoryConfig: config.botMemoryConfig,
      botMemory: config.botMemory,
      retrievalQuery: eventDescription,
      userId: event.userId,
      privacyMode,
      timerMaxSeconds: config.timerMaxSeconds,
    });
    replyableMessageIds = promptBundle.replyableMessageIds;

    const { messages, trace: promptTrace } = appendCurrentRequest(promptBundle, {
      role: "user",
      content: `[系统事件通知] ${eventDescription}`,
    });

    const isStreamMode = isStreamReplyMode(config.messageConfig);
    const toolSchemaHash = createToolSchemaHash(toolset.tools);
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
        eventDescription,
        userName: event.userName,
        timerDepth: event.timerDepth,
        messages,
        staticPrefixHash: promptTrace.staticPrefixHash,
        toolSchemaHash,
        cacheFingerprint,
        toolsEnabled: Object.keys(toolset.tools),
      },
    });

    const startTime = Date.now();
    let streamedMessageCount = 0;
    let stepCounter = 0;
    const requestCache = createRequestCache();
    const abortSignals: AbortSignal[] = [
      AbortSignal.timeout(config.timeoutConfig?.aiReplyMs ?? DEFAULT_TIMEOUT_CONFIG.aiReplyMs),
      manualAbort.signal,
    ];
    if (executionContext) abortSignals.push(executionContext.signal);
    const perStepAbort = createPerStepAbort(
      config.timeoutConfig?.perStepMs ?? DEFAULT_TIMEOUT_CONFIG.perStepMs,
      AbortSignal.any(abortSignals),
    );
    const providerAbort = new AbortController();

    await api.sendChatAction(chatId, "typing").catch(() => {});
    stopChatActionHeartbeat = startChatActionHeartbeat(() => api.sendChatAction(chatId, "typing"));

    // ─── streamText (ai v6 API) ───
    const result = streamText({
      model: selection.model,
      messages,
      tools: composeTurnTools(toolset.tools, {
        secrets: config.diagnosticSecrets,
        requestCache,
        onLog: config.onLog,
        getStep: () => stepCounter + 1,
        onEffect: () => {
          successfulToolEffectCount += 1;
        },
        onResult: (name, output) => {
          const completion = imageToolCompletion(name, output);
          if (completion) imageCompletion = completion;
        },
      }),
      prepareStep: prepareFinalAnswerStep(
        config.memoryConfig?.maxSteps ?? DEFAULT_MEMORY_CONFIG.maxSteps,
        toolset.prepareStep,
      ),
      stopWhen: stepCountIs(config.memoryConfig?.maxSteps ?? DEFAULT_MEMORY_CONFIG.maxSteps),
      toolChoice: "auto",
      abortSignal: AbortSignal.any([perStepAbort.signal, providerAbort.signal]),
      temperature: selection.temperature,
      maxOutputTokens: selection.maxTokens,
      providerOptions: selection.providerOptions,
      experimental_onToolCallStart: () => perStepAbort.pause(),
      experimental_onToolCallFinish: () => perStepAbort.resume(),
      onStepFinish: () => {
        stepCounter++;
        perStepAbort.reset();
      },
      onError: ({ error }) => {
        providerStreamError ??= error;
        config.onLog?.({
          level: "error",
          message: "AI continuation provider stream error",
          meta: {
            providerId: selection.providerId,
            model: selection.modelId,
            error,
          },
        });
        providerAbort.abort(error);
        stopChatActionHeartbeat?.();
        stopChatActionHeartbeat = undefined;
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
          const { sentMessages, text: streamedContent } = await streamToChat(
            api,
            chatId,
            filteredStream,
            isRichMessageEnabled(config.messageConfig),
          );
          for (const msg of sentMessages) {
            chatBotMsgIds.push(msg.message_id);
            const content = msg.text ?? (msg.rich_message ? streamedContent : undefined);
            if (content) deliveredMessages.set(msg.message_id, content);
          }
          streamedMessageCount = sentMessages.length;
        } catch (streamErr) {
          streamFailed = true;
          config.onLog?.({
            level: "warn",
            message: `streamToChat failed, falling back to text: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
            meta: { chatId, error: streamErr },
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

    throwCapturedStreamError(providerStreamError, false);
    const finalText = await result.text;
    const steps = await result.steps;
    const rawResponseTexts = getTurnResponseTexts(finalText, steps);
    const rawResponseText = rawResponseTexts.join("\n\n");
    const responseTexts = rawResponseTexts
      .map((rawText) => {
        const afterThink = stripThinkingContent(rawText, ({ pattern, strippedLength }) => {
          config.onLog?.({
            level: "info",
            message: `Stripped thinking content from continueChat segment (pattern: ${pattern}, ${strippedLength} chars)`,
            meta: { chatId },
          });
        });
        return stripMetaPrefix(afterThink, ({ pattern, strippedLength }) => {
          config.onLog?.({
            level: "warn",
            message: `Stripped meta prefix from continueChat segment (pattern: ${pattern}, ${strippedLength} chars)`,
            meta: { chatId },
          });
        });
      })
      .filter((text) => text.trim());
    const text = responseTexts.join("\n\n");
    config.onLog?.({
      level: "debug",
      message: "AI continuation response",
      meta: {
        providerId: selection.providerId,
        model: selection.modelId,
        rawResponseText,
        responseText: text,
      },
    });
    stopChatActionHeartbeat();
    stopChatActionHeartbeat = undefined;
    const deliveredMultiMessageContent = deliveredMultiMessages.join("\n");
    const sentViaMultiMessage = deliveredMultiMessages.length > 0;
    const pendingText = responseTexts
      .filter((part) => !isTextCoveredByDeliveries(part, deliveredMultiMessages))
      .join("\n\n");
    const deliveredFinalChunks: string[] = [];

    // Send text unless its complete content is already confirmed as delivered.
    if ((!isStreamMode || streamFailed) && pendingText) {
      const msgCfg = config.messageConfig ?? DEFAULT_MESSAGE_CONFIG;
      const threshold = msgCfg.autoSplitThreshold ?? 0;
      const chunks = splitMessage(pendingText, threshold > 0 ? threshold : 4096);
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
                  error,
                },
              });
            },
          );
          chatBotMsgIds.push(message.message_id);
          deliveredMessages.set(message.message_id, chunk);
          deliveredFinalChunks.push(chunk);
          visibleDeliveryCount += 1;
        } catch (sendError) {
          config.onLog?.({
            level: "error",
            message: `Rich Message fallbacks failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
            meta: { chatId, error: sendError },
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
          imageCompletion ?? "(事件已处理，但 AI 未生成回复内容)",
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
    const totalUsage = await result.totalUsage;
    const durationMs = Date.now() - startTime;

    // Record token usage
    config.onTokenUsage?.({
      chatId,
      userId: event.userId,
      model: selection.modelId,
      promptTokens: totalUsage.inputTokens ?? 0,
      completionTokens: totalUsage.outputTokens ?? 0,
      totalTokens: totalUsage.totalTokens ?? 0,
      ...extractCacheTokenUsage(
        totalUsage,
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
      for (const [id, content] of deliveredMessages) {
        toSave.push({
          chatId,
          role: "assistant",
          content,
          meta: { trigger: "event_continuation", tgMessageId: id },
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
          meta: { chatId, error: err },
        });
      }
    }

    config.onLog?.({
      level: "info",
      message: "continueChat completed",
      meta: {
        chatId,
        providerId: selection.providerId,
        model: selection.modelId,
        eventDescription,
        responseText: assistantContent,
        textLength: assistantContent.length,
        responseTextLength: text?.length ?? 0,
        multiMessageSentCount: deliveredMultiMessages.length,
      },
    });
    return visibleDeliveryCount > 0 || successfulToolEffectCount > 0;
  } catch (caughtError) {
    const err = providerStreamError ?? caughtError;
    config.onLog?.({
      level: "error",
      message: `continueChat failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: {
        chatId,
        providerId: selectedProviderId,
        model: selectedModelId,
        eventDescription,
        error: err,
        ...(providerStreamError !== undefined ? { providerError: providerStreamError } : {}),
      },
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
    await disposePluginTools?.();
    stopChatActionHeartbeat?.();
    if (manualAbort) config.unregisterAbortController?.(manualAbort);
  }
}
