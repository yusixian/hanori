import {
  DEFAULT_BOT_MEMORY_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
  isStreamReplyMode,
  type GenerationLibraryActor,
  type ImageGenerationActor,
  type ImageGenerationPort,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createToolSchemaHash } from "../utils/prompt-cache.js";
import { createAgentTools } from "./agents.js";
import { createBotMemoryTools, explicitlyRequestsMemoryForget } from "./bot-memory.js";
import { createDanbooruTools } from "./danbooru.js";
import { createFileTools } from "./file-tools.js";
import { createGenerationLibraryTools } from "./generation-library.js";
import { createGitHubTools } from "./github.js";
import { createImageGenerationTools } from "./image-generation.js";
import { createActionTools, createMemoryTools } from "./index.js";
import { createMcpTools } from "./mcp.js";
import { createProfileAvatarTools } from "./profile-avatar.js";
import { createRssTools } from "./rss.js";
import { createSkillTools } from "./skills.js";
import { createTurnInteractionTools } from "./turn-interaction.js";
import {
  ADMIN_ID,
  FORGET_REQUEST,
  IMAGE_ROUTE,
  MEMBER_ID,
  continuation,
  createToolsetConfig,
  reply,
  run,
  turnInput,
  type InputOverrides,
} from "./turn-toolset-test-helpers.js";
import {
  createTurnToolset,
  type ContinueTurn,
  type ReplyTurn,
  type TurnToolsetInput,
} from "./turn-toolset.js";
import { createOnceGuard } from "./utils.js";

type Turn<Entry> = TurnToolsetInput & { entry: Entry };

function legacyInteraction(input: TurnToolsetInput) {
  return createTurnInteractionTools({
    api: input.api,
    chatId: input.chatId,
    recentBotMessageIds: [],
    onceGuard: createOnceGuard(),
    telegram: { ...input.interaction.telegram, userId: input.userId },
    behavior: { moodState: new Map(), richMessageEnabled: true },
    artwork: input.config.artworkToolsConfig
      ? { config: input.config.artworkToolsConfig, timeoutConfig: input.config.timeoutConfig }
      : undefined,
  });
}

/** createAiReplyHandler's per-turn tool assembly at aea299b, before createTurnToolset. */
async function legacyReplyTools(input: Turn<ReplyTurn>): Promise<Record<string, Tool>> {
  const { api, chatId, config, entry, isPrivate } = input;
  const userId = input.userId!;
  const isAdmin = config.adminIds!.includes(userId);
  const personalized = input.privacyMode !== "off";
  const memoryCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const botMemoryCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
  const memoryTools =
    memoryCfg.enabled && config.memory ? createMemoryTools(config.memory) : undefined;
  const skillTools = createSkillTools({
    skills: config.skills ?? [],
    hasImageGeneration: !!config.imageGenerationPort,
    hasWebSearch: !!config.webTools?.web_search,
  });
  const fileTools = config.dataFiles
    ? createFileTools({
        dataDir: config.dataFiles.dataDir,
        protectedFiles: config.dataFiles.injectableFiles,
      })
    : undefined;
  const actionTools = createActionTools({
    api,
    chatId,
    messageId: entry.message.id,
    stickerCache: entry.stickerCache,
  });
  const isDelegatedGroupAdmin =
    config.imageGenerationPort && !isPrivate && !isAdmin
      ? (await config.isDelegatedGroupAdmin?.(chatId, userId)) === true
      : false;
  const imageActor: ImageGenerationActor = {
    botId: config.botId,
    chatId,
    userId,
    chatType: isPrivate ? "private" : "supergroup",
    isBotAdmin: isAdmin,
    isDelegatedGroupAdmin,
  };
  const libraryActor = config.generationLibraryPort
    ? { botId: config.botId, source: "telegram" as const, telegramUserId: userId, isAdmin }
    : undefined;
  const { telegramTools, behaviorTools, artworkTools } = legacyInteraction(input);
  if (!personalized) delete telegramTools.set_timer;
  if (!personalized) delete behaviorTools.set_mood;
  const agentTools = input.delegation?.(libraryActor) ?? {};
  const github = entry.github;
  const githubTools =
    github?.config.enabled && (isAdmin || github.config.publicReadEnabled)
      ? createGitHubTools({
          ...github,
          isAdmin,
          userId,
          chatId,
          api,
          pendingActions: config.pendingAdminActions,
        })
      : {};
  const profileAvatars = createProfileAvatarTools(
    personalized && memoryCfg.enabled ? config.memory : undefined,
    userId,
  );
  const requestMemoryTools =
    personalized && memoryTools ? { ...memoryTools, ...profileAvatars.tools } : undefined;
  const forwarded = entry.message.forwarded;
  const requestBotMemoryTools =
    personalized && botMemoryCfg.enabled && config.botMemory
      ? createBotMemoryTools(config.botMemory, {
          chatId,
          userId,
          messageId: entry.message.id,
          privacyMode: input.privacyMode,
          allowSave: !forwarded,
          allowMutations: !forwarded,
          allowHardDelete: !forwarded && explicitlyRequestsMemoryForget(entry.message.text),
        })
      : undefined;
  const tools: Record<string, Tool> = {
    ...requestMemoryTools,
    ...requestBotMemoryTools,
    ...actionTools,
    ...telegramTools,
    ...behaviorTools,
    ...config.webTools,
    ...agentTools,
    ...githubTools,
    ...artworkTools,
    ...fileTools,
    ...skillTools,
    ...createDanbooruTools({
      timeoutConfig: config.timeoutConfig,
      generationLibraryPort: config.generationLibraryPort,
      getActor: libraryActor ? () => libraryActor : undefined,
    }),
  };
  if (config.generationLibraryPort && libraryActor) {
    Object.assign(
      tools,
      createGenerationLibraryTools({
        port: config.generationLibraryPort,
        getActor: () => libraryActor,
      }),
    );
  }
  if (config.rssCallbacks) {
    Object.assign(
      tools,
      createRssTools({
        ...config.rssCallbacks,
        chatId,
        userId,
        adminChatIds: config.adminIds!,
        api,
        pendingActions: config.pendingAdminActions,
      }),
    );
  }
  if (entry.mcp) Object.assign(tools, createMcpTools(entry.mcp, { includeAdminTools: isAdmin }));
  if (config.imageGenerationPort) {
    Object.assign(
      tools,
      await createImageGenerationTools({
        port: config.imageGenerationPort,
        getActor: () => imageActor,
        replyMessageId: entry.message.replyToMessageId,
      }),
    );
  }
  if (isStreamReplyMode(config.messageConfig) || entry.preserveQueuedMessage) {
    delete tools.multi_message;
  }
  return tools;
}

/** doContinueChat's tool assembly at aea299b, before createTurnToolset. */
async function legacyContinueTools(input: Turn<ContinueTurn>): Promise<Record<string, Tool>> {
  const { api, chatId, config, entry, userId } = input;
  const memCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
  const botMemCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;
  const profileAvatars = createProfileAvatarTools(
    memCfg.enabled ? config.memory : undefined,
    userId,
  );
  const memoryTools =
    memCfg.enabled && config.memory
      ? { ...createMemoryTools(config.memory), ...profileAvatars.tools }
      : undefined;
  const botMemoryTools =
    botMemCfg.enabled && config.botMemory
      ? createBotMemoryTools(config.botMemory, {
          chatId,
          userId,
          privacyMode: input.privacyMode,
          allowSave: false,
          allowMutations: false,
          allowHardDelete: false,
        })
      : undefined;
  const { telegramTools, behaviorTools, artworkTools } = legacyInteraction(input);
  const libraryActor =
    config.generationLibraryPort && userId !== undefined
      ? {
          botId: config.botId,
          source: "telegram" as const,
          telegramUserId: userId,
          isAdmin: config.adminIds?.includes(userId) === true,
        }
      : undefined;
  const tools: Record<string, Tool> = {
    ...telegramTools,
    ...behaviorTools,
    ...config.webTools,
    ...createDanbooruTools({
      timeoutConfig: config.timeoutConfig,
      generationLibraryPort: config.generationLibraryPort,
      getActor: libraryActor ? () => libraryActor : undefined,
    }),
    ...createSkillTools({
      skills: config.skills ?? [],
      hasImageGeneration: !!config.imageGenerationPort && userId !== undefined,
      hasWebSearch: !!config.webTools?.web_search,
    }),
  };
  if (config.dataFiles)
    Object.assign(tools, createFileTools({ dataDir: config.dataFiles.dataDir }));
  if (entry.timerDepth >= 2) delete tools.set_timer;
  if (input.delegation) Object.assign(tools, input.delegation(libraryActor));
  if (config.generationLibraryPort && libraryActor) {
    Object.assign(
      tools,
      createGenerationLibraryTools({
        port: config.generationLibraryPort,
        getActor: () => libraryActor,
        readOnly: true,
      }),
    );
  }
  if (memoryTools) Object.assign(tools, memoryTools);
  if (botMemoryTools) Object.assign(tools, botMemoryTools);
  if (config.imageGenerationPort && userId !== undefined) {
    const isPrivate = chatId > 0;
    const isBotAdmin = config.adminIds?.includes(userId) === true;
    const isDelegatedGroupAdmin =
      !isPrivate && !isBotAdmin
        ? (await config.isDelegatedGroupAdmin?.(chatId, userId)) === true
        : false;
    Object.assign(
      tools,
      await createImageGenerationTools({
        port: config.imageGenerationPort,
        getActor: () => ({
          botId: config.botId,
          chatId,
          userId,
          chatType: isPrivate ? "private" : "supergroup",
          isBotAdmin,
          isDelegatedGroupAdmin,
        }),
      }),
    );
  }
  Object.assign(tools, artworkTools);
  if (config.rssCallbacks) {
    Object.assign(
      tools,
      createRssTools({
        ...config.rssCallbacks,
        chatId,
        userId,
        adminChatIds: config.adminIds ?? [],
        api,
        pendingActions: config.pendingAdminActions,
        forceAdmin: userId === undefined,
        allowWrites: userId !== undefined && entry.allowRssWrites !== false,
      }),
    );
  }
  if (isStreamReplyMode(config.messageConfig)) delete tools.multi_message;
  return tools;
}

function recordingInput(overrides: InputOverrides) {
  const listRoutes = vi.fn(async (..._args: Parameters<ImageGenerationPort["listRoutes"]>) => [
    IMAGE_ROUTE,
  ]);
  const delegation = vi.fn((actor?: GenerationLibraryActor) =>
    createAgentTools({
      provider: () => ({}) as never,
      model: "model-a",
      agentConfig: { enabled: true },
      getActor: actor ? () => actor : undefined,
    }),
  );
  const config = createToolsetConfig({
    ...overrides.config,
    imageGenerationPort: { listRoutes } as unknown as ImageGenerationPort,
  });
  return { listRoutes, delegation, overrides: { ...overrides, config, delegation } };
}

const streamMode = { messageConfig: { ...DEFAULT_MESSAGE_CONFIG, replyMode: "stream" as const } };
const delegatedAdmin = { isDelegatedGroupAdmin: async () => true };
const member = { userId: MEMBER_ID, config: createToolsetConfig(delegatedAdmin) };

const CASES: Array<[string, ReplyTurn | ContinueTurn, InputOverrides]> = [
  ["reply by a group admin", reply(), {}],
  ["reply to a delegated group member", reply(), member],
  ["reply in a private chat", reply(), { chatId: ADMIN_ID }],
  ["reply with topic and diagnostics", reply(), { threadId: 73, currentTraceId: "reply-trace" }],
  ["reply with personalization off", reply(), { privacyMode: "off" }],
  ["reply in stream mode", reply(), { config: createToolsetConfig(streamMode) }],
  ["reply to a forget request", reply({ text: FORGET_REQUEST }), {}],
  ["reply to a forwarded forget request", reply({ forwarded: true, text: FORGET_REQUEST }), {}],
  ["reply resolving a queue notice", reply({}, { preserveQueuedMessage: true }), {}],
  ["continuation for a group admin", continuation(), {}],
  ["continuation for a delegated group member", continuation(), member],
  ["continuation in a private chat", continuation(), { chatId: ADMIN_ID }],
  [
    "continuation with topic and diagnostics",
    continuation(),
    { threadId: 73, currentTraceId: "continue-trace" },
  ],
  ["ownerless continuation", continuation(), { userId: undefined }],
  ["continuation in stream mode", continuation(), { config: createToolsetConfig(streamMode) }],
  ["second timer continuation", continuation({ timerDepth: 2 }), {}],
  ["continuation without RSS writes", continuation({ allowRssWrites: false }), {}],
];

describe("turn toolset parity with the per-caller assembly it replaced", () => {
  it.each(CASES)("%s", async (_name, entry, caseOverrides) => {
    const { listRoutes, delegation, overrides } = recordingInput(caseOverrides);
    const input = await turnInput(entry, overrides);
    const { tools } = await createTurnToolset(input);
    const legacy =
      input.entry.kind === "reply"
        ? await legacyReplyTools(input as Turn<ReplyTurn>)
        : await legacyContinueTools(input as Turn<ContinueTurn>);

    expect(Object.keys(tools)).toEqual(Object.keys(legacy).sort((a, b) => a.localeCompare(b)));
    expect(createToolSchemaHash(tools)).toBe(createToolSchemaHash(legacy));
    const legacyCall = listRoutes.mock.calls[1];
    if (legacyCall) {
      expect(listRoutes.mock.calls[0]).toEqual([
        {
          ...legacyCall[0],
          requestContext: {
            ...(entry.kind === "reply" ? { messageId: entry.message.id } : {}),
            threadId: input.threadId,
            traceId: input.currentTraceId,
          },
        },
        legacyCall[1],
      ]);
    } else {
      expect(listRoutes.mock.calls[0]).toBeUndefined();
    }
    expect(delegation.mock.calls[0]).toEqual([...delegation.mock.calls[1]!, undefined]);
    await expect(run(tools, "load_skill", { skill: "prompt-atelier" })).resolves.toEqual(
      await run(legacy, "load_skill", { skill: "prompt-atelier" }),
    );
  });
});
