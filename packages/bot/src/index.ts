import type { RuntimeDiagnosticsPort } from "@cos-tool-bot/shared";
import type {
  BotLogEntry,
  ConversationCallbacks,
  ImageGenerationReceiptConfig,
  ImageGenerationRequestSnapshot,
  MediaTranscriptionPort,
  TokenUsageRecord,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_CONVERSATION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  resolveImageGenerationReceiptConfig,
} from "@cos-tool-bot/shared";
import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";
import { stream } from "@grammyjs/stream";
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, type Api } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import type { Logger } from "pino";
import { type BackupResult, createBackupCommand } from "./commands/backup.js";
import { createApiKeyCommand } from "./commands/api-key.js";
import { createClearCommand } from "./commands/clear.js";
import { createSummaryCommand, type SummaryCallbacks } from "./commands/summary.js";
import { createClearReceivedCommand } from "./commands/clear-received.js";
import { createCosInsideCommand, type CosInsideCommandConfig } from "./commands/cos-inside.js";
import { createDrawV2Command } from "./commands/draw-v2.js";
import { createImageCommand } from "./commands/image.js";
import { createQuotaCommand, type QuotaCommandConfig } from "./commands/quota.js";
import { createHelpCommand } from "./commands/help.js";
import { createMd2tgCommand } from "./commands/md2tg.js";
import { createModelCommand } from "./commands/model.js";
import { createProviderCommand } from "./commands/provider.js";
import { createPrivacyCommand } from "./commands/privacy.js";
import { createImageGenCommand } from "./commands/imagegen.js";
import { type McpCommandConfig, createMcpCommand } from "./commands/mcp.js";
import { createReplyModeCommand } from "./commands/reply-mode.js";
import { createRichTextCommand } from "./commands/rich-text.js";
import { createRestartCommand } from "./commands/restart.js";
import { createResumeCommand } from "./commands/resume.js";
import { startCommand } from "./commands/start.js";
import { createStatusCommand } from "./commands/status.js";
import { createStopCommand } from "./commands/stop.js";
import { ActiveCommandRegistry } from "./commands/registry.js";
import {
  createTimersCommand,
  isTimerCancelCallback,
  parseTimerCancelId,
} from "./commands/timers.js";
import { WrapperContext, type BotContext } from "./context.js";
import { createAiSelectionGuard, createAuthGuard, privateChatOnlyGuard } from "./guards/auth.js";
import { type AiReplyConfig, createAiReplyHandler } from "./handlers/ai-reply.js";
import type { AiSelectionMutations, AiSelectionSnapshot } from "./handlers/ai-selection.js";
import {
  createPollAnswerHandler,
  createCallbackQueryHandler,
  createAdminActionCallbackQueryHandler,
} from "./handlers/event-handlers.js";
import { createHarnessMiddleware, type HarnessMiddlewareOptions } from "./harness/middleware.js";
import { createHarnessTelegram } from "./harness/telegram.js";
import type { HarnessBotPort } from "./harness/types.js";
import { createLogMiddleware } from "./middleware/log.js";
import {
  createTelegramObservationMiddleware,
  type TelegramObservationCallbacks,
} from "./middleware/telegram-observation.js";
import { getUpdateConstraint, hasLeadingBotCommand } from "./middleware/update-constraint.js";
import { AiIngressLock } from "./services/ai-ingress-lock.js";
import { createMediaConfirmationCallbackQueryHandler } from "./handlers/media-confirmation.js";
import { formatImageGenerationCaption } from "./utils/image-generation-delivery.js";

export { sendMediaConfirmationMessage } from "./handlers/media-confirmation.js";

export type AiReplyBotConfig = Omit<
  AiReplyConfig,
  "adminChatIds" | "onLog" | "onTokenUsage" | "token" | "aiSelectionMutations"
>;

export interface BotAiSelectionRuntime {
  applyAiSelectionSnapshot(snapshot: AiSelectionSnapshot): void;
}

export interface AiSelectionCallbacks extends AiSelectionMutations {
  onBotReady?: (runtime: BotAiSelectionRuntime) => void;
}

export interface BotTimerHandlers {
  fireTimer: (
    chatId: number,
    timerId: string,
    reason: string,
    userId?: number,
    memoryless?: boolean,
    allowRssWrites?: boolean,
  ) => Promise<boolean>;
  cancelPendingTimer: (timerId: string) => void;
}

export interface TimerCallbacks {
  onTimerCreate?: (params: {
    timerId: string;
    chatId: number;
    seconds: number;
    reason: string;
    userId: number;
    handle: ReturnType<typeof setTimeout>;
  }) => void | Promise<void>;
  onTimerCancel?: (timerId: string) => void;
  onTimerFired?: (timerId: string) => Promise<void>;
  onGetTimers?: () => import("@cos-tool-bot/shared").TimerRecord[];
  onCancelTimer?: (timerId: string) => Promise<boolean>;
  onBotReady?: (handlers: BotTimerHandlers) => void;
}

export interface BotConfig {
  runtimeDiagnostics?: RuntimeDiagnosticsPort;
  token: string;
  botId: string;
  adminChatIds: number[];
  logger: Logger;
  onRestart?: () => void | Promise<void>;
  onBackup?: () => Promise<BackupResult>;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
  timerCallbacks?: TimerCallbacks;
  aiSelectionCallbacks?: AiSelectionCallbacks;
  mcpCallbacks?: McpCommandConfig;
  aiReply?: AiReplyBotConfig;
  mediaTranscriptionPort?: MediaTranscriptionPort;
  conversation?: ConversationCallbacks;
  privacy?: UserPrivacyCallbacks;
  summary?: SummaryCallbacks;
  quota?: QuotaCommandConfig;
  telegramObservation?: TelegramObservationCallbacks;
  miniAppUrl?: string;
  cosInside?: CosInsideCommandConfig;
  harness?: HarnessBotPort;
}

export async function sendLocalImageFiles(
  api: Api,
  chatId: number,
  files: string[],
  input: {
    prompt: string;
    detailUrl: string;
    presetKey?: string;
    requestSnapshot?: ImageGenerationRequestSnapshot;
    receiptConfig?: ImageGenerationReceiptConfig;
  },
): Promise<number[]> {
  if (files.length === 0) return [];
  const receiptConfig = resolveImageGenerationReceiptConfig(input.receiptConfig);
  const caption = formatImageGenerationCaption({
    prompt: input.prompt,
    imageCount: files.length,
    presetKey: input.presetKey,
    requestSnapshot: input.requestSnapshot,
    receiptConfig: input.receiptConfig,
    truncationNoticeUrl:
      files.length > 1 && !receiptConfig.albumNoticeEnabled ? input.detailUrl : undefined,
  }).html;
  const detailButton = new InlineKeyboard().url("查看任务详情", input.detailUrl);
  if (files.length === 1) {
    const message = await api.sendPhoto(chatId, new InputFile(files[0]!), {
      caption,
      parse_mode: "HTML",
      reply_markup: detailButton,
    });
    return [message.message_id];
  }
  const media: InputMediaPhoto[] = files.map((file, index) => ({
    type: "photo",
    media: new InputFile(file),
    ...(index === 0 ? { caption, parse_mode: "HTML" as const } : {}),
  }));
  const messages = await api.sendMediaGroup(chatId, media);
  if (receiptConfig.albumNoticeEnabled) {
    await api.sendMessage(chatId, receiptConfig.albumNoticeText, {
      reply_markup: detailButton,
      ...(messages[0]
        ? {
            reply_parameters: {
              message_id: messages[0].message_id,
              allow_sending_without_reply: true,
            },
          }
        : {}),
    });
  }
  return messages.map((message) => message.message_id);
}

const botDisposers = new WeakMap<object, () => void | Promise<void>>();

export async function disposeBot(bot: object): Promise<void> {
  const dispose = botDisposers.get(bot);
  if (!dispose) return;
  await dispose();
  if (botDisposers.get(bot) === dispose) botDisposers.delete(bot);
}

export function createBot(config: BotConfig) {
  const { token, adminChatIds, logger } = config;
  const aiIngressLock = config.aiReply ? new AiIngressLock() : undefined;

  // StreamFlavor adds plain and Rich Message streaming methods at runtime via stream() middleware,
  // so we need a double assertion to satisfy the type system while using our custom WrapperContext
  const bot = new Bot<BotContext>(token, {
    ContextConstructor: WrapperContext as unknown as new (
      ...args: ConstructorParameters<typeof WrapperContext>
    ) => BotContext,
  });
  bot.api.config.use(autoRetry());
  const commandRegistry = new ActiveCommandRegistry(bot);

  const authGuard = createAuthGuard(adminChatIds);
  const aiSelectionGuard = config.aiReply
    ? createAiSelectionGuard(adminChatIds, config.aiReply)
    : authGuard;
  let captureAiTurnCoalescingAdmission:
    | ReturnType<typeof createAiReplyHandler>["captureTurnCoalescingAdmission"]
    | undefined;
  let stopAiTurnCoalescing:
    | ReturnType<typeof createAiReplyHandler>["stopTurnCoalescing"]
    | undefined;

  // Register ordinary messages before sequentialize or any observation/stream middleware can
  // yield. This preserves arrival order against later destructive commands while the admission
  // remains short-lived and detaches before the long AI execution phase.
  const diagnosticTraces = new WeakMap<WrapperContext, string>();
  bot.use(async (ctx, next) => {
    let traceId: string | undefined;
    if (config.runtimeDiagnostics && ctx.message && ctx.chat && ctx.from) {
      traceId = config.runtimeDiagnostics.startTrace({
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        messageId: ctx.message.message_id,
        updateId: ctx.update.update_id,
      });
      diagnosticTraces.set(ctx, traceId);
      config.runtimeDiagnostics.record(traceId, { stage: "received", outcome: "started" });
    }
    try {
      await next();
      if (traceId && (hasLeadingBotCommand(ctx) || !config.aiReply)) {
        config.runtimeDiagnostics?.record(traceId, {
          stage: "complete",
          outcome: "skipped",
          code: hasLeadingBotCommand(ctx) ? "command" : "ai_disabled",
        });
      }
    } catch (error) {
      if (traceId)
        config.runtimeDiagnostics?.record(traceId, {
          stage: "complete",
          outcome: "failed",
          code: "failed",
        });
      throw error;
    }
  });
  if (aiIngressLock) {
    bot.use((ctx, next) => {
      if (!ctx.message) return next();
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (chatId === undefined || config.harness?.isHarnessChat(chatId)) return next();
      if (hasLeadingBotCommand(ctx)) {
        stopAiTurnCoalescing?.(chatId, ctx.message?.message_thread_id);
        return next();
      }
      if (userId === undefined) return next();
      captureAiTurnCoalescingAdmission?.(ctx, chatId, ctx.message?.message_thread_id);
      return aiIngressLock.runAdmittedMessage(ctx, chatId, userId, next);
    });
  }

  // Ordinary message ingress stays ordered per Chat and detaches after scheduler admission.
  // Command lanes use independent constraints, so control and configuration work never waits
  // for a long-running AI reply while conflicting command mutations remain serialized.
  bot.use(sequentialize(getUpdateConstraint));
  bot.use(stream());
  bot.use(
    createTelegramObservationMiddleware(config.botId, config.telegramObservation, config.onLog),
  );
  bot.use(createLogMiddleware(config.onLog));
  let resolveHarnessAssistant: HarnessMiddlewareOptions["resolveAssistant"];
  if (config.harness) {
    bot.use(
      createHarnessMiddleware(config.harness, {
        resolveAssistant: (chatId, userId) => resolveHarnessAssistant?.(chatId, userId),
      }),
    );
  }

  const mediaTranscriptionPort =
    config.mediaTranscriptionPort ?? config.aiReply?.mediaTranscriptionPort;
  if (mediaTranscriptionPort) {
    const mediaConfirmationHandler = createMediaConfirmationCallbackQueryHandler({
      api: bot.api,
      botId: config.botId,
      adminIds: adminChatIds,
      port: mediaTranscriptionPort,
    });
    bot.on("callback_query:data", async (ctx, next) => {
      if (!(await mediaConfirmationHandler(ctx))) await next();
    });
  }

  // Build AI handler + runtime state (created before commands so state is available)
  let aiHandler: ReturnType<typeof createAiReplyHandler>["handler"] | undefined;
  let aiState: ReturnType<typeof createAiReplyHandler>["state"] | undefined;
  let aiSetModelForChat: ReturnType<typeof createAiReplyHandler>["setModelForChat"] | undefined;
  let aiResetModelForChat: ReturnType<typeof createAiReplyHandler>["resetModelForChat"] | undefined;
  let aiSetProviderForChat:
    | ReturnType<typeof createAiReplyHandler>["setProviderForChat"]
    | undefined;
  let aiResetProviderForChat:
    | ReturnType<typeof createAiReplyHandler>["resetProviderForChat"]
    | undefined;
  let aiGetProvidersList: ReturnType<typeof createAiReplyHandler>["getProvidersList"] | undefined;
  let aiGetSelectionForChat:
    | ReturnType<typeof createAiReplyHandler>["getSelectionForChat"]
    | undefined;
  let aiGetReplyMode: ReturnType<typeof createAiReplyHandler>["getReplyMode"] | undefined;
  let aiSetReplyMode: ReturnType<typeof createAiReplyHandler>["setReplyMode"] | undefined;
  let aiGetRichMessageEnabled:
    | ReturnType<typeof createAiReplyHandler>["getRichMessageEnabled"]
    | undefined;
  let aiSetRichMessageEnabled:
    | ReturnType<typeof createAiReplyHandler>["setRichMessageEnabled"]
    | undefined;
  let aiGetImageGenEnabled:
    | ReturnType<typeof createAiReplyHandler>["getImageGenEnabled"]
    | undefined;
  let aiSetImageGenEnabled:
    | ReturnType<typeof createAiReplyHandler>["setImageGenEnabled"]
    | undefined;
  let aiUpdateWebToolApiKey:
    | ReturnType<typeof createAiReplyHandler>["updateWebToolApiKey"]
    | undefined;
  let aiSetAiEnabled: ReturnType<typeof createAiReplyHandler>["setAiEnabled"] | undefined;
  let aiWaitForUserProfileUpdates:
    | ReturnType<typeof createAiReplyHandler>["waitForUserProfileUpdates"]
    | undefined;
  let aiCancelChatRuns: ReturnType<typeof createAiReplyHandler>["cancelChatRuns"] | undefined;
  let aiCancelUserRuns: ReturnType<typeof createAiReplyHandler>["cancelUserRuns"] | undefined;
  let aiRunChatMutation: ReturnType<typeof createAiReplyHandler>["runChatMutation"] | undefined;
  let aiRunUserMutation: ReturnType<typeof createAiReplyHandler>["runUserMutation"] | undefined;
  let disposeAiRuntime: (() => Promise<void>) | undefined;
  let statusConfig: Parameters<typeof createStatusCommand>[0];

  if (config.aiReply) {
    const convCfg = config.aiReply.conversationConfig ?? DEFAULT_CONVERSATION_CONFIG;
    const memCfg = config.aiReply.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
    statusConfig = {
      model: config.aiReply.model,
      conversationEnabled: convCfg.enabled,
      memoryEnabled: memCfg.enabled,
      webToolsEnabled: !!config.aiReply.webToolsConfig?.enabled,
      agentToolsEnabled: !!config.aiReply.agentToolsConfig?.enabled,
      stickerPacksCount: config.aiReply.stickerPacks?.length ?? 0,
    };
    const result = createAiReplyHandler(
      {
        ...config.aiReply,
        runtimeDiagnostics: config.runtimeDiagnostics,
        getDiagnosticTraceId: (ctx) => diagnosticTraces.get(ctx),
        privacy: config.privacy,
        adminChatIds,
        onLog: config.onLog,
        onTokenUsage: config.onTokenUsage,
        onTimerCreate: config.timerCallbacks?.onTimerCreate,
        onTimerCancel: config.timerCallbacks?.onTimerCancel,
        onTimerFiredPersist: config.timerCallbacks?.onTimerFired,
        token,
        initialApi: bot.api,
        detachReplyExecution: true,
        aiSelectionMutations: config.aiSelectionCallbacks,
      },
      { ingressLock: aiIngressLock },
    );
    aiHandler = result.handler;
    aiState = result.state;
    aiSetModelForChat = result.setModelForChat;
    aiResetModelForChat = result.resetModelForChat;
    aiSetProviderForChat = result.setProviderForChat;
    aiResetProviderForChat = result.resetProviderForChat;
    aiGetProvidersList = result.getProvidersList;
    aiGetSelectionForChat = result.getSelectionForChat;
    aiGetReplyMode = result.getReplyMode;
    aiSetReplyMode = result.setReplyMode;
    aiGetRichMessageEnabled = result.getRichMessageEnabled;
    aiSetRichMessageEnabled = result.setRichMessageEnabled;
    aiGetImageGenEnabled = result.getImageGenEnabled;
    aiSetImageGenEnabled = result.setImageGenEnabled;
    aiUpdateWebToolApiKey = result.updateWebToolApiKey;
    aiSetAiEnabled = result.setAiEnabled;
    captureAiTurnCoalescingAdmission = result.captureTurnCoalescingAdmission;
    stopAiTurnCoalescing = result.stopTurnCoalescing;
    aiWaitForUserProfileUpdates = result.waitForUserProfileUpdates;
    aiCancelChatRuns = result.cancelChatRuns;
    aiCancelUserRuns = result.cancelUserRuns;
    aiRunChatMutation = result.runChatMutation;
    aiRunUserMutation = result.runUserMutation;
    disposeAiRuntime = result.destroy;

    config.aiSelectionCallbacks?.onBotReady?.({
      applyAiSelectionSnapshot: result.applyAiSelectionSnapshot,
    });

    resolveHarnessAssistant = (chatId, userId) => {
      if (!result.isAiEnabled()) return undefined;
      const { model, providerId, modelId } = result.resolveModelForChat(chatId);
      return {
        model,
        recordUsage: (usage) =>
          void Promise.resolve(
            config.onTokenUsage?.({
              chatId,
              userId,
              model: modelId,
              providerId,
              promptTokens: usage.inputTokens ?? 0,
              completionTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens ?? 0,
              durationMs: usage.durationMs,
              trigger: "harness_assistant",
            }),
          ).catch(() => {}),
      };
    };

    // Register bot handlers with server for timer recovery and external cancel
    if (config.timerCallbacks?.onBotReady) {
      const pendingActions = result.state.getPendingActions();
      config.timerCallbacks.onBotReady({
        fireTimer: result.fireTimerEvent,
        cancelPendingTimer: (timerId) => {
          pendingActions.removeTimer(timerId);
        },
      });
    }
  }

  commandRegistry.register("start", startCommand);
  commandRegistry.register(
    "help",
    createHelpCommand(() => commandRegistry.getActiveCommands()),
  );
  if (config.miniAppUrl) {
    commandRegistry.register("panel", async (ctx) => {
      if (ctx.chat.type === "private") {
        await ctx.reply("Open the Bot help and management panel:", {
          reply_markup: {
            inline_keyboard: [[{ text: "Open Panel", web_app: { url: config.miniAppUrl! } }]],
          },
        });
        return;
      }

      const username = ctx.me.username;
      await ctx.reply(
        "Telegram only provides signed panel access from a private chat. Open this Bot privately, then send /panel.",
        username
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "Open Bot Chat", url: `https://t.me/${username}` }]],
              },
            }
          : undefined,
      );
    });
  }
  commandRegistry.register(
    "md2tg",
    createMd2tgCommand({ getRichMessageEnabled: () => aiGetRichMessageEnabled?.() ?? false }),
  );
  commandRegistry.register("status", authGuard, createStatusCommand(statusConfig, aiState));
  commandRegistry.register("restart", authGuard, createRestartCommand(config.onRestart));
  commandRegistry.register("backup", authGuard, createBackupCommand(config.onBackup));
  if (config.cosInside) {
    const runCosInsideMutation = aiIngressLock
      ? <T>(targetChatId: number, actorUserId: number, operation: () => Promise<T>) =>
          aiIngressLock.runExecutionAdmission(targetChatId, actorUserId, operation)
      : undefined;
    commandRegistry.register(
      "cosinside",
      privateChatOnlyGuard,
      authGuard,
      createCosInsideCommand(config.cosInside, runCosInsideMutation),
    );
  }
  if (aiSetAiEnabled) {
    commandRegistry.register("stop", authGuard, createStopCommand(aiSetAiEnabled));
    commandRegistry.register("resume", authGuard, createResumeCommand(aiSetAiEnabled));
  }
  if (aiUpdateWebToolApiKey) {
    commandRegistry.register(
      "apikey",
      authGuard,
      createApiKeyCommand({
        updateApiKey: aiUpdateWebToolApiKey,
        onError: (target) =>
          config.onLog?.({
            level: "error",
            message: `Failed to update ${target} API key`,
          }),
      }),
    );
  }
  if (config.mcpCallbacks) {
    commandRegistry.register("mcp", authGuard, createMcpCommand(config.mcpCallbacks));
  }
  commandRegistry.register(
    "clear",
    createClearCommand(
      config.conversation,
      adminChatIds,
      aiCancelChatRuns ? async (chatId) => void (await aiCancelChatRuns(chatId)) : undefined,
      aiRunChatMutation,
    ),
  );
  if (config.privacy) {
    commandRegistry.register(
      "privacy",
      createPrivacyCommand({
        ...config.privacy,
        beforeMutate: aiCancelUserRuns
          ? async (userId) => void (await aiCancelUserRuns(userId))
          : undefined,
        runMutation: aiRunUserMutation,
        waitForPendingProfileUpdate: aiWaitForUserProfileUpdates,
      }),
    );
  }
  commandRegistry.register(
    "clearreceived",
    authGuard,
    createClearReceivedCommand(config.aiReply?.dataFiles?.dataDir),
  );

  // Register /timers command (admin only)
  if (config.timerCallbacks?.onGetTimers && config.timerCallbacks?.onCancelTimer) {
    commandRegistry.register(
      "timers",
      authGuard,
      createTimersCommand({
        onGetTimers: config.timerCallbacks.onGetTimers,
        onCancelTimer: config.timerCallbacks.onCancelTimer,
      }),
    );
  }

  // Register /model command if models are configured
  if (config.aiReply?.models?.length && aiSetModelForChat && aiGetSelectionForChat) {
    const modelCmd = createModelCommand({
      getSelectionForChat: aiGetSelectionForChat,
      setModelForChat: aiSetModelForChat,
      resetModelForChat: aiResetModelForChat!,
    });
    commandRegistry.registerConfigurable(
      "model",
      config.aiReply.modelCommandAccess === "all" ? "public" : "admin",
      aiSelectionGuard,
      modelCmd,
    );
  }

  // Register /provider command if providers are configured
  const providersList: Array<{ id: string; label: string; defaultModel: string }> =
    aiGetProvidersList?.() ?? [];
  if (
    providersList.length > 1 &&
    aiSetProviderForChat &&
    aiGetSelectionForChat &&
    aiResetProviderForChat
  ) {
    const providerCmd = createProviderCommand({
      getSelectionForChat: aiGetSelectionForChat,
      setProviderForChat: aiSetProviderForChat,
      resetProviderForChat: aiResetProviderForChat,
      providers: providersList,
    });
    commandRegistry.registerConfigurable(
      "provider",
      config.aiReply?.modelCommandAccess === "all" ? "public" : "admin",
      aiSelectionGuard,
      providerCmd,
    );
  }

  // Register /replymode command (admin only)
  if (config.aiReply && aiGetReplyMode && aiSetReplyMode) {
    commandRegistry.register(
      "replymode",
      authGuard,
      createReplyModeCommand({
        getReplyMode: aiGetReplyMode,
        setReplyMode: aiSetReplyMode,
      }),
    );
  }

  // Register /richtext command (admin only, persisted globally for this bot)
  if (aiGetRichMessageEnabled && aiSetRichMessageEnabled) {
    commandRegistry.register(
      "richtext",
      authGuard,
      createRichTextCommand({
        getEnabled: aiGetRichMessageEnabled,
        setEnabled: aiSetRichMessageEnabled,
      }),
    );
  }

  // Register /imagegen command (admin only, requires image generation config)
  if (
    config.aiReply?.webToolsConfig?.imageGeneration &&
    aiGetImageGenEnabled &&
    aiSetImageGenEnabled
  ) {
    commandRegistry.register(
      "imagegen",
      authGuard,
      createImageGenCommand({
        getImageGenEnabled: aiGetImageGenEnabled,
        setImageGenEnabled: aiSetImageGenEnabled,
      }),
    );
  }

  const imagePort = config.aiReply?.imageGenerationPort;
  const buildImageActor = imagePort
    ? async (chatId: number, userId: number, chatType: "private" | "group" | "supergroup") => {
        const isBotAdmin = adminChatIds.includes(userId);
        return {
          botId: config.botId,
          chatId,
          userId,
          chatType,
          isBotAdmin,
          isDelegatedGroupAdmin:
            chatType !== "private" && !isBotAdmin
              ? (await config.aiReply?.isDelegatedGroupAdmin?.(chatId, userId)) === true
              : false,
        } as const;
      }
    : undefined;
  if (imagePort && buildImageActor) {
    commandRegistry.register(
      "draw",
      createDrawV2Command({
        port: imagePort,
        getActor: (ctx) =>
          buildImageActor(
            ctx.chat!.id,
            ctx.from!.id,
            ctx.chat!.type === "private"
              ? "private"
              : ctx.chat!.type === "group"
                ? "group"
                : "supergroup",
          ),
      }),
    );
    commandRegistry.register(
      "image",
      createImageCommand({
        listPresets: async (input) =>
          imagePort.listPresets(
            await buildImageActor(input.chatId, input.userId, input.chatType),
            input.purpose,
          ),
        getGeneration: async (input) =>
          imagePort.get(
            await buildImageActor(input.chatId, input.userId, input.chatType),
            input.generationId,
          ),
        cancelGeneration: async (input) => {
          const result = await imagePort.cancel(
            await buildImageActor(input.chatId, input.userId, input.chatType),
            input.generationId,
          );
          return result.ok
            ? { ok: true, generation: result.generation }
            : { ok: false, generation: result.generation, message: result.message };
        },
      }),
    );
  }

  if (config.quota) commandRegistry.register("quota", createQuotaCommand(config.quota));

  const harness = config.harness;
  if (harness) {
    // Inside the harness chat the harness middleware answers first; elsewhere only point the way.
    const pointToHarnessChat =
      (command: string): Parameters<typeof commandRegistry.register>[1] =>
      async (ctx) => {
        if (ctx.from && harness.isOwner(ctx.from.id)) {
          await ctx.reply(`请在 Dev Harness 话题群中使用 /${command}。`);
        }
      };
    commandRegistry.register("harness", pointToHarnessChat("harness"));
    commandRegistry.register("bug", pointToHarnessChat("bug"));
    commandRegistry.register("task", pointToHarnessChat("task"));
    commandRegistry.register("list", pointToHarnessChat("list"));
    commandRegistry.register("cancel", pointToHarnessChat("cancel"));
    commandRegistry.register("retry", pointToHarnessChat("retry"));
    commandRegistry.register("release", pointToHarnessChat("release"));
  }

  if (config.summary) {
    commandRegistry.register("summary", createSummaryCommand(config.summary));
  }

  if (aiHandler && aiState) {
    // Register event handlers for interactive tools (polls, choices)
    const pendingActions = aiState.getPendingActions();

    const pollAnswerHandler = createPollAnswerHandler({
      api: bot.api,
      pendingActions,
      getContinueChatConfig: (chatId) => aiState!.getContinueChatConfig(chatId),
      isPrivateChat: (chatId) => aiState!.isPrivateChat(chatId),
    });

    const callbackQueryHandler = createCallbackQueryHandler({
      api: bot.api,
      pendingActions,
      getContinueChatConfig: (chatId) => aiState!.getContinueChatConfig(chatId),
      onLog: config.onLog,
    });
    const adminActionCallbackQueryHandler = createAdminActionCallbackQueryHandler({
      api: bot.api,
      pendingActions: aiState.getPendingAdminActions(),
      adminIds: adminChatIds,
    });

    bot.on("poll_answer", async (ctx) => {
      await pollAnswerHandler(ctx.pollAnswer);
    });

    bot.on("callback_query:data", async (ctx) => {
      // Handle timer cancel callbacks
      const data = ctx.callbackQuery.data;
      if (isTimerCancelCallback(data) && config.timerCallbacks?.onCancelTimer) {
        const timerId = parseTimerCancelId(data);
        if (timerId) {
          const cancelled = await config.timerCallbacks.onCancelTimer(timerId);
          await ctx.api.raw.answerCallbackQuery({
            callback_query_id: ctx.callbackQuery.id,
            text: cancelled ? `定时器 ${timerId} 已取消` : "定时器未找到或已过期",
          });
          if (cancelled && ctx.callbackQuery.message) {
            try {
              await ctx.api.editMessageText(
                ctx.callbackQuery.message.chat.id,
                ctx.callbackQuery.message.message_id,
                `${ctx.callbackQuery.message.text ?? ""}\n\n✅ 定时器 ${timerId} 已取消`,
              );
            } catch {
              // ignore edit errors
            }
          }
          return;
        }
      }
      if (await adminActionCallbackQueryHandler(ctx)) return;
      await callbackQueryHandler(ctx);
    });

    bot.on("message", aiHandler);
  }

  bot.api.setMyCommands(commandRegistry.getTelegramCommands()).catch((err) => {
    const desc = err instanceof GrammyError ? err.description : String(err);
    logger.warn(`Failed to set commands: ${desc}`);
  });

  bot.catch(async (err) => {
    const ctx = err.ctx;
    const errorMsg = buildUpdateErrorMessage(ctx.update.update_id, err.error);
    logger.error(errorMsg);
    config.onLog?.({ level: "error", message: errorMsg, meta: { updateId: ctx.update.update_id } });
    // Plain text on purpose: error descriptions are arbitrary strings and must
    // never be re-parsed as Markdown/HTML, or the error report itself fails.
    await ctx.resolveWait(errorMsg).catch(() => {});
  });

  harness?.onBotReady(createHarnessTelegram(bot.api));
  botDisposers.set(bot, () => disposeAiRuntime?.());
  return bot;
}

export function buildUpdateErrorMessage(updateId: number, error: unknown): string {
  const head = `处理消息 ${updateId} 时出错:\n`;
  if (error instanceof GrammyError) return head + "Error in request: " + error.description;
  if (error instanceof HttpError) return head + "Could not contact Telegram: " + error;
  return head + "Unknown error: " + ((error as Error)?.message ?? String(error));
}

export { WrapperContext, type BotContext } from "./context.js";
export {
  buildPromptBundle,
  appendCurrentRequest,
  assemblePromptPreview,
  type CompletedPromptBundle,
  type ContextAssemblyInput,
  type PromptBundle,
  type PromptPreviewInput,
  type PromptPreviewResult,
  type PromptSectionStatus,
  type PromptSectionTrace,
  type PromptStability,
  type PromptTrace,
  type PromptTrust,
} from "./services/context-assembler.js";
export type { McpCommandConfig } from "./commands/mcp.js";
export {
  HARNESS_CALLBACK_PREFIX,
  type HarnessAssistantRuntime,
  type HarnessAssistantUsage,
  type HarnessAttachment,
  type HarnessBotPort,
  type HarnessCallbackAnswer,
  type HarnessCallbackRequest,
  type HarnessCommandName,
  type HarnessCommandRequest,
  type HarnessEditMessage,
  type HarnessEditResult,
  type HarnessInlineButton,
  type HarnessKeyboard,
  type HarnessMessageKind,
  type HarnessOutgoingMessage,
  type HarnessReply,
  type HarnessReplyRequest,
  type HarnessTelegram,
  type HarnessTopicMessageRequest,
} from "./harness/types.js";
export type {
  CosInsideAuditEntry,
  CosInsideCommandConfig,
  CosInsideHistoryEntry,
  CosInsideHistoryFailure,
} from "./commands/cos-inside.js";
export type { SummaryCallbacks } from "./commands/summary.js";
export {
  createTelegramObservationMiddleware,
  isValidTelegramGroupChatId,
  projectTelegramObservations,
  type TelegramBotMembershipObservation,
  type TelegramBotMembershipStatus,
  type TelegramChatMigrationObservation,
  type TelegramChatObservation,
  type TelegramGroupChatType,
  type TelegramObservationCallbacks,
} from "./middleware/telegram-observation.js";
export type { DataFilesConfig } from "./utils/data-files.js";
export { createUsageAwareOpenAICompatible } from "./utils/openai-compatible.js";
export { createModelFetch } from "./utils/model-fetch.js";
export {
  DEFAULT_BOT_SKILL_IDS,
  isBuiltInSkillId,
  listBotSkills,
  resolveBotSkills,
  type BotSkillDefinition,
  type BotSkillSummary,
} from "./skills/catalog.js";
export type {
  AiProviderRuntime,
  AiSelectionMutations,
  AiSelectionPair,
  AiSelectionSnapshot,
} from "./handlers/ai-selection.js";
export { getActiveBotCommands } from "./commands/registry.js";
export { NsfwChecker } from "./services/nsfw-checker.js";
export type { NsfwCheckerConfig, NsfwCheckResult } from "./services/nsfw-checker.js";
export {
  cleanupBotAvatarFiles,
  cleanupProfileAvatarFiles,
  MAX_PROFILE_AVATAR_BYTES,
  readProfileAvatarFile,
  removeProfileAvatarFile,
} from "./services/profile-avatar-files.js";
export {
  isTerminalPixAIRecoveryError,
  PixAIRecoveryTerminalError,
  PixAITaskTerminalError,
  recoverPixAIGeneration,
  type PixAIRecoveryTerminalReason,
  type PixAITaskTerminalStatus,
  type RecoverPixAIGenerationOptions,
} from "./tools/pixai.js";
export type { McpToolEntry, McpToolsOptions } from "./tools/mcp.js";
export { sendLocalVideoFile } from "./services/video-download-delivery.js";
