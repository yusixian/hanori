import type { PluginActor, PluginRuntimePort, PluginTurnSession } from "@cos-tool-bot/shared";
import { createPluginTools } from "./plugins.js";
import type { RuntimeDiagnosticsPort } from "@cos-tool-bot/shared";
import { createRuntimeDiagnosticTools } from "./runtime-diagnostics.js";
import type {
  ArtworkToolsConfig,
  AiGroupOverride,
  BotLogEntry,
  BotMemoryCallbacks,
  BotMemoryConfig,
  GenerationLibraryActor,
  GenerationLibraryPort,
  ImageGenerationActor,
  ImageGenerationPort,
  MemoryCallbacks,
  MemoryConfig,
  MessageConfig,
  TimeoutConfig,
  UserPrivacyMode,
} from "@cos-tool-bot/shared";
import {
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  isRichMessageEnabled,
  isStreamReplyMode,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import type { Api } from "grammy";
import type { PendingAdminActionRegistry } from "../services/pending-github-actions.js";
import type { BotSkillDefinition } from "../skills/catalog.js";
import type { DataFilesConfig } from "../utils/data-files.js";
import { sortToolsForPromptCache } from "../utils/prompt-cache.js";
import {
  deriveCapabilitiesFromTools,
  type ToolPromptCapability,
} from "../utils/tool-capabilities.js";
import {
  createBotMemoryTools,
  explicitlyRequestsMemoryForget,
  type BotMemoryTurnContext,
} from "./bot-memory.js";
import { createDanbooruTools } from "./danbooru.js";
import { createFileTools } from "./file-tools.js";
import { createGenerationLibraryTools } from "./generation-library.js";
import { createGitHubTools, type GitHubToolsOptions } from "./github.js";
import { createImageGenerationTools } from "./image-generation.js";
import { createActionTools, createMemoryTools } from "./index.js";
import { createMcpTools, type McpToolsOptions } from "./mcp.js";
import { createProfileAvatarTools } from "./profile-avatar.js";
import { createRssTools, type RssToolsOptions } from "./rss.js";
import { createSkillTools } from "./skills.js";
import { createBuiltinSearchProviders, createUnifiedSearchTools } from "./search.js";
import {
  createTurnInteractionTools,
  type TurnInteractionToolsOptions,
} from "./turn-interaction.js";
import type { OnceGuardContext } from "./utils.js";

/** Continuations this many timers deep may not schedule another one, bounding timer chains. */
const MAX_TIMER_CHAIN_DEPTH = 2;

/** Bot configuration and long-lived ports a turn's tools are bound from. */
export interface TurnToolsetConfig {
  botId: string;
  runtimeDiagnostics?: RuntimeDiagnosticsPort;
  adminIds?: number[];
  memoryConfig?: MemoryConfig;
  memory?: MemoryCallbacks;
  botMemoryConfig?: BotMemoryConfig;
  botMemory?: BotMemoryCallbacks;
  messageConfig?: MessageConfig;
  stickerPacks?: readonly string[];
  webTools?: Readonly<Record<string, Tool>>;
  unifiedSearchEnabled?: boolean;
  plugins?: PluginRuntimePort;
  artworkToolsConfig?: ArtworkToolsConfig;
  timeoutConfig?: TimeoutConfig;
  dataFiles?: DataFilesConfig;
  skills?: readonly BotSkillDefinition[];
  generationLibraryPort?: GenerationLibraryPort;
  imageGenerationPort?: ImageGenerationPort;
  imageGenerationConfirmation?: "always" | "never";
  groupOverrides?: Record<string, AiGroupOverride>;
  isDelegatedGroupAdmin?: (chatId: number, userId: number) => Promise<boolean>;
  rssCallbacks?: Omit<
    RssToolsOptions,
    "chatId" | "userId" | "adminChatIds" | "api" | "pendingActions" | "forceAdmin" | "allowWrites"
  >;
  pendingAdminActions: PendingAdminActionRegistry;
}

/** The Telegram message a reply turn answers. */
export interface TurnMessage {
  id: number;
  text: string;
  /** Forwarded content was not written by the sender, so it never authorizes memory writes. */
  forwarded: boolean;
  replyToMessageId?: number;
}

export interface ReplyTurn {
  kind: "reply";
  message: TurnMessage;
  /** A queued turn resolves its queue notice in place, which multi_message cannot do. */
  preserveQueuedMessage: boolean;
  stickerCache: Map<string, string[]>;
  mcp?: McpToolsOptions;
  github?: Pick<
    GitHubToolsOptions,
    "config" | "codeCallbacks" | "codingModel" | "issueProposals" | "threadId"
  >;
}

export interface ContinueTurn {
  kind: "continue";
  /** 0 for events, 1 for a timer a reply set, +1 for each timer a continuation set. */
  timerDepth: number;
  allowRssWrites?: boolean;
}

export interface TurnInteractionInput {
  recentBotMessageIds: number[];
  onceGuard: OnceGuardContext;
  telegram: Omit<TurnInteractionToolsOptions["telegram"], "userId">;
  behavior: Pick<TurnInteractionToolsOptions["behavior"], "moodState" | "onMultiMessageSent">;
}

export interface TurnToolsetInput {
  threadId?: number;
  currentTraceId?: string;
  signal?: AbortSignal;
  entry: ReplyTurn | ContinueTurn;
  chatId: number;
  isPrivate: boolean;
  userId?: number;
  privacyMode?: UserPrivacyMode;
  /** From resolveImageGenerationActor; image tools need both this actor and the port. */
  imageGenerationActor: ImageGenerationActor | undefined;
  api: Api;
  config: TurnToolsetConfig;
  interaction: TurnInteractionInput;
  /** Builds delegate_task for the turn's model selection; absent when delegation is off. */
  delegation?: (
    actor?: GenerationLibraryActor,
    plugins?: (signal?: AbortSignal) => Promise<PluginTurnSession>,
  ) => Record<string, Tool>;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
}

type MemoryWritePolicy = Required<
  Pick<BotMemoryTurnContext, "allowSave" | "allowMutations" | "allowHardDelete">
>;

export interface TurnToolset {
  dispose?(): Promise<void>;
  /** Sorted by name: the order sent to the provider and hashed for prompt caching. */
  tools: Record<string, Tool>;
  /** Read from `tools`, so the prompt never describes a tool this turn lacks. */
  capabilities: ReadonlySet<ToolPromptCapability>;
  /** Must reach streamText: it feeds avatar images read by a tool back to the model. */
  prepareStep: ReturnType<typeof createProfileAvatarTools>["prepareStep"];
}

/**
 * Only a message its sender wrote may change long-term memory; continuations have none.
 * Profile tools (update_profile) keep their own contract and are not governed here.
 */
function resolveMemoryWritePolicy(entry: ReplyTurn | ContinueTurn): MemoryWritePolicy {
  if (entry.kind === "continue" || entry.message.forwarded) {
    return { allowSave: false, allowMutations: false, allowHardDelete: false };
  }
  return {
    allowSave: true,
    allowMutations: true,
    allowHardDelete: explicitlyRequestsMemoryForget(entry.message.text),
  };
}

export async function resolveImageGenerationActor(
  config: Pick<
    TurnToolsetConfig,
    | "botId"
    | "adminIds"
    | "imageGenerationPort"
    | "isDelegatedGroupAdmin"
    | "imageGenerationConfirmation"
    | "groupOverrides"
  >,
  scope: { chatId: number; isPrivate: boolean; userId?: number },
): Promise<ImageGenerationActor | undefined> {
  const { chatId, isPrivate, userId } = scope;
  if (!config.imageGenerationPort || userId === undefined) return undefined;
  const isBotAdmin = config.adminIds?.includes(userId) === true;
  const isDelegatedGroupAdmin =
    !isPrivate && !isBotAdmin
      ? (await config.isDelegatedGroupAdmin?.(chatId, userId)) === true
      : false;
  const imageConfirmationPolicy =
    config.groupOverrides?.[String(chatId)]?.imageGenerationConfirmation ??
    config.imageGenerationConfirmation ??
    "always";
  return {
    botId: config.botId,
    chatId,
    userId,
    chatType: isPrivate ? "private" : "supergroup",
    isBotAdmin,
    isDelegatedGroupAdmin,
    ...(imageConfirmationPolicy === "always" ? {} : { imageConfirmationPolicy }),
  };
}

function createReplyGitHubTools(
  input: TurnToolsetInput,
  entry: ReplyTurn,
  isAdmin: boolean,
): Record<string, Tool> {
  const github = entry.github;
  if (!github?.config.enabled || input.userId === undefined) return {};
  if (!isAdmin && !github.config.publicReadEnabled) return {};
  return createGitHubTools({
    ...github,
    isAdmin,
    userId: input.userId,
    chatId: input.chatId,
    api: input.api,
    pendingActions: input.config.pendingAdminActions,
  });
}

function createReplyMcpTools(
  input: TurnToolsetInput,
  mcp: McpToolsOptions,
  isAdmin: boolean,
): Record<string, Tool> {
  const tools = createMcpTools(mcp, { includeAdminTools: isAdmin }, input.interaction.onceGuard);
  const names = Object.keys(tools);
  if (names.length > 0) {
    input.onLog?.({ level: "info", message: `MCP tools injected: ${names.join(", ")}` });
  } else {
    input.onLog?.({
      level: "warn",
      message: "MCP config present but no tools available (servers may be disconnected)",
    });
  }
  return tools;
}

/**
 * Decides every tool an AI turn may call. Families are merged in a fixed precedence (later
 * wins on a name clash, which only owner-prefixed MCP tools can cause); the merged set is then
 * sorted, so assembly order never changes the provider request or its schema hash.
 */
export async function createTurnToolset(input: TurnToolsetInput): Promise<TurnToolset> {
  const { entry, config, api, chatId, userId, onLog } = input;
  const personalized = input.privacyMode !== "off";
  const isAdmin = userId !== undefined && config.adminIds?.includes(userId) === true;
  const libraryActor: GenerationLibraryActor | undefined =
    config.generationLibraryPort && userId !== undefined
      ? { botId: config.botId, source: "telegram", telegramUserId: userId, isAdmin }
      : undefined;
  const memoryEnabled = personalized && (config.memoryConfig ?? DEFAULT_MEMORY_CONFIG).enabled;
  const botMemoryEnabled =
    personalized && (config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG).enabled;
  const profileAvatars = createProfileAvatarTools(
    memoryEnabled ? config.memory : undefined,
    userId,
    config.unifiedSearchEnabled === true,
  );

  const { telegramTools, behaviorTools, artworkTools } = createTurnInteractionTools({
    api,
    chatId,
    recentBotMessageIds: input.interaction.recentBotMessageIds,
    onceGuard: input.interaction.onceGuard,
    telegram: { ...input.interaction.telegram, userId },
    behavior: {
      ...input.interaction.behavior,
      richMessageEnabled: isRichMessageEnabled(config.messageConfig),
      onLog,
    },
    artwork: config.artworkToolsConfig
      ? {
          config: config.artworkToolsConfig,
          timeoutConfig: config.timeoutConfig,
          unifiedSearchEnabled: config.unifiedSearchEnabled === true,
        }
      : undefined,
  });
  if (!personalized) {
    delete telegramTools.set_timer;
    delete behaviorTools.set_mood;
  }
  if (entry.kind === "continue" && entry.timerDepth >= MAX_TIMER_CHAIN_DEPTH) {
    delete telegramTools.set_timer;
    onLog?.({
      level: "warn",
      message: "set_timer disabled due to timer depth limit",
      meta: { chatId, timerDepth: entry.timerDepth },
    });
  }

  const imageActor = input.imageGenerationActor;
  const imageTools =
    config.imageGenerationPort && imageActor
      ? await createImageGenerationTools({
          port: config.imageGenerationPort,
          api,
          getActor: () => ({
            ...imageActor,
            requestContext: {
              ...(entry.kind === "reply" ? { messageId: entry.message.id } : {}),
              threadId: input.threadId,
              traceId: input.currentTraceId,
            },
          }),
          replyMessageId: entry.kind === "reply" ? entry.message.replyToMessageId : undefined,
        })
      : {};

  const pluginActor: PluginActor = {
    botId: config.botId,
    chatId,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    userId,
    isAdmin,
    isPrivate: input.isPrivate,
    readOnly: entry.kind === "continue" || !personalized,
  };
  const researcherPlugins = config.plugins
    ? (signal?: AbortSignal) =>
        config.plugins!.createSession({ ...pluginActor, readOnly: true }, signal)
    : undefined;

  const tools: Record<string, Tool> = {
    ...(entry.kind === "reply" && isAdmin && userId !== undefined && config.runtimeDiagnostics
      ? createRuntimeDiagnosticTools({
          port: config.runtimeDiagnostics,
          adminIds: config.adminIds ?? [],
          actor: {
            chatId,
            userId,
            messageId: entry.message.id,
            currentTraceId: input.currentTraceId,
          },
        })
      : {}),
    ...(memoryEnabled && config.memory
      ? { ...createMemoryTools(config.memory), ...profileAvatars.tools }
      : {}),
    ...(botMemoryEnabled && config.botMemory
      ? createBotMemoryTools(config.botMemory, {
          chatId,
          userId,
          messageId: entry.kind === "reply" ? entry.message.id : undefined,
          privacyMode: input.privacyMode,
          unifiedSearchEnabled: config.unifiedSearchEnabled === true,
          ...resolveMemoryWritePolicy(entry),
        })
      : {}),
    ...(entry.kind === "reply"
      ? createActionTools({
          api,
          chatId,
          messageId: entry.message.id,
          stickerCache: entry.stickerCache,
          onceGuard: input.interaction.onceGuard,
        })
      : {}),
    ...telegramTools,
    ...behaviorTools,
    ...config.webTools,
    ...input.delegation?.(libraryActor, researcherPlugins),
    ...(entry.kind === "reply" ? createReplyGitHubTools(input, entry, isAdmin) : {}),
    ...artworkTools,
    ...(config.dataFiles
      ? createFileTools({
          dataDir: config.dataFiles.dataDir,
          protectedFiles: config.dataFiles.injectableFiles,
        })
      : {}),
    ...createSkillTools({
      skills: config.skills ?? [],
      hasImageGeneration: !!imageTools.get_image_generation,
      hasWebSearch: !!config.webTools?.web_search,
      unifiedSearchEnabled: config.unifiedSearchEnabled === true,
    }),
    ...createDanbooruTools({
      timeoutConfig: config.timeoutConfig,
      generationLibraryPort: config.generationLibraryPort,
      getActor: libraryActor ? () => libraryActor : undefined,
      onLog,
      persistSearchResults: config.unifiedSearchEnabled !== true,
    }),
    ...(config.generationLibraryPort && libraryActor
      ? createGenerationLibraryTools({
          port: config.generationLibraryPort,
          getActor: () => libraryActor,
          readOnly: entry.kind === "continue",
          trackSearchHits: config.unifiedSearchEnabled !== true,
        })
      : {}),
    ...(config.rssCallbacks
      ? createRssTools({
          ...config.rssCallbacks,
          chatId,
          userId,
          adminChatIds: config.adminIds ?? [],
          api,
          pendingActions: config.pendingAdminActions,
          forceAdmin: userId === undefined,
          allowWrites:
            userId !== undefined && (entry.kind === "reply" || entry.allowRssWrites !== false),
        })
      : {}),
    ...(entry.kind === "reply" && entry.mcp ? createReplyMcpTools(input, entry.mcp, isAdmin) : {}),
    ...imageTools,
  };

  if (
    isStreamReplyMode(config.messageConfig) ||
    (entry.kind === "reply" && entry.preserveQueuedMessage)
  ) {
    delete tools.multi_message;
  }

  const pluginSession = await config.plugins?.createSession(pluginActor, input.signal);
  try {
    if (pluginSession) {
      const pluginTools = createPluginTools(pluginSession);
      if (Object.keys(pluginTools).some((name) => Object.hasOwn(tools, name)))
        throw new Error("Plugin tool name conflict");
      Object.assign(tools, pluginTools);
    }
    if (config.unifiedSearchEnabled === true || pluginSession?.searchProviders.length) {
      const { providers, migratedToolNames } =
        config.unifiedSearchEnabled === true
          ? createBuiltinSearchProviders(tools, { chatId })
          : { providers: [], migratedToolNames: [] };
      for (const name of migratedToolNames) delete tools[name];
      Object.assign(
        tools,
        createUnifiedSearchTools([...providers, ...(pluginSession?.searchProviders ?? [])]),
      );
    }
    const sortedTools = sortToolsForPromptCache(tools);
    return {
      tools: sortedTools,
      capabilities: deriveCapabilitiesFromTools(sortedTools, config.stickerPacks),
      prepareStep: profileAvatars.prepareStep,
      ...(pluginSession ? { dispose: () => pluginSession.dispose() } : {}),
    };
  } catch (error) {
    await pluginSession?.dispose();
    throw error;
  }
}
