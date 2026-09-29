/** Shared fixtures for the turn toolset tests. */
import {
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MESSAGE_CONFIG,
  type BotMemoryCallbacks,
  type GenerationLibraryPort,
  type ImageGenerationPort,
  type ImageRouteCapabilities,
  type MemoryCallbacks,
} from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import type { Api } from "grammy";
import { PendingActionRegistry } from "../services/pending-actions.js";
import { PendingAdminActionRegistry } from "../services/pending-github-actions.js";
import { resolveBuiltInSkills } from "../skills/catalog.js";
import { createAgentTools } from "./agents.js";
import {
  createTurnToolset,
  resolveImageGenerationActor,
  type ContinueTurn,
  type ReplyTurn,
  type TurnToolsetConfig,
  type TurnToolsetInput,
} from "./turn-toolset.js";
import { createOnceGuard } from "./utils.js";
import { createWebTools } from "./web.js";

export const ADMIN_ID = 42;
export const MEMBER_ID = 7;
export const GROUP_ID = -1001;
export const FORGET_REQUEST = "请忘记我喜欢咖啡这件事";

export const IMAGE_ROUTE: ImageRouteCapabilities = {
  purpose: "anime_illustration",
  provider: "mcp_pixai",
  enabled: true,
  label: "Anime illustration",
  useWhen: "anime portraits",
  avoidWhen: "",
  examples: [],
  presets: [],
};

const unused = async (): Promise<never> => {
  throw new Error("not used by tool assembly");
};

export function createToolsetConfig(overrides: Partial<TurnToolsetConfig> = {}): TurnToolsetConfig {
  return {
    botId: "bot-1",
    adminIds: [ADMIN_ID],
    memoryConfig: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
    memory: { getProfileAvatar: unused } as unknown as MemoryCallbacks,
    botMemoryConfig: { enabled: true, maxMemories: 5, autoInjectMemories: true },
    botMemory: {} as BotMemoryCallbacks,
    messageConfig: DEFAULT_MESSAGE_CONFIG,
    stickerPacks: ["pack"],
    webTools: createWebTools({
      config: { enabled: true, search: { provider: "tavily", apiKey: "search-key" } },
    }),
    artworkToolsConfig: { enabled: true },
    dataFiles: {
      dataDir: "/tmp/turn-toolset-test",
      injectableFiles: new Set(["IDENTITY.md"]),
      loadFiles: async () => [],
    },
    skills: resolveBuiltInSkills(["prompt-atelier"]),
    generationLibraryPort: {} as GenerationLibraryPort,
    imageGenerationPort: {
      listRoutes: async () => [IMAGE_ROUTE],
    } as unknown as ImageGenerationPort,
    isDelegatedGroupAdmin: async () => false,
    rssCallbacks: {
      onListCollections: unused,
      onGetNewItems: unused,
      onListFeeds: unused,
      onMarkDigested: unused,
      onAddFeed: unused,
      onRemoveFeed: unused,
      onCreateCollection: unused,
    },
    pendingAdminActions: new PendingAdminActionRegistry(),
    ...overrides,
  };
}

export function reply(
  message: Partial<ReplyTurn["message"]> = {},
  extra: Partial<ReplyTurn> = {},
): ReplyTurn {
  return {
    kind: "reply",
    message: { id: 900, text: "hello", forwarded: false, replyToMessageId: 800, ...message },
    preserveQueuedMessage: false,
    stickerCache: new Map(),
    mcp: {
      getTools: () => [
        { serverId: 1, name: "lookup", description: "Lookup", inputSchema: {} },
        {
          serverId: 1,
          name: "rotate_keys",
          description: "Admin",
          inputSchema: {},
          adminOnly: true,
        },
      ],
      callTool: unused,
    },
    github: {
      config: {
        enabled: true,
        publicReadEnabled: false,
        codingAgentEnabled: false,
        authorName: "Ai-chan",
        authorEmail: "ai@example.com",
        repositories: ["owner/repo"],
      },
    },
    ...extra,
  };
}

export function continuation(extra: Partial<ContinueTurn> = {}): ContinueTurn {
  return { kind: "continue", timerDepth: 0, ...extra };
}

export type InputOverrides = Partial<Omit<TurnToolsetInput, "entry" | "imageGenerationActor">>;

/** A turn in a group chat by the admin unless overridden; isPrivate follows the chat id. */
export async function turnInput(
  entry: TurnToolsetInput["entry"],
  overrides: InputOverrides = {},
): Promise<TurnToolsetInput> {
  const config = overrides.config ?? createToolsetConfig();
  const chatId = overrides.chatId ?? GROUP_ID;
  const isPrivate = overrides.isPrivate ?? chatId > 0;
  const userId = "userId" in overrides ? overrides.userId : ADMIN_ID;
  return {
    privacyMode: "normal",
    api: {} as Api,
    interaction: {
      recentBotMessageIds: [],
      onceGuard: createOnceGuard(),
      telegram: { pendingActions: new PendingActionRegistry() },
      behavior: { moodState: new Map() },
    },
    delegation: (actor) =>
      createAgentTools({
        provider: () => ({}) as never,
        model: "model-a",
        agentConfig: { enabled: true },
        getActor: actor ? () => actor : undefined,
      }),
    ...overrides,
    entry,
    chatId,
    isPrivate,
    userId,
    config,
    imageGenerationActor: await resolveImageGenerationActor(config, { chatId, isPrivate, userId }),
  };
}

export async function assemble(entry: TurnToolsetInput["entry"], overrides: InputOverrides = {}) {
  return createTurnToolset(await turnInput(entry, overrides));
}

export function run(tools: Record<string, Tool>, name: string, input: unknown) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`Missing executable tool: ${name}`);
  return execute(input as never, { toolCallId: "test", messages: [] });
}
