import type { Database } from "@cos-tool-bot/database";
import {
  DEFAULT_CONVERSATION_CONFIG,
  type AiConfigStored,
  type AiProviderEntry,
  type EmbeddingConfig,
  type GitHubToolsConfigStored,
} from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import { encrypt } from "../../utils/crypto.js";
import { toAiConfigRuntime } from "../ai-config-runtime.js";
import { BotMemoryStore } from "../bot-memory-store.js";
import { ConversationStore } from "../conversation-store.js";
import type { DbLogger } from "../db-logger.js";
import { GenerationLibraryService } from "../generation-library-service.js";
import { PendingGenerationInsertFallbackTracker } from "../generation-recovery.js";
import { GitHubCredentialGenerationGate } from "../github-credential-policy.js";
import { PeopleProfileAvatarService } from "../people-profile-avatar-service.js";
import { PeopleProfileStore } from "../people-profile-store.js";
import type { TimerRegistry } from "../timer-registry.js";
import { UserPrivacyService } from "../user-privacy-service.js";
import type { BotRuntimeHost, BotRuntimeInput, BotRuntimeServices } from "./types.js";

export const BOT_ID = "00000000-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = "bot-runtime-test-key";

export function chatProvider(overrides: Partial<AiProviderEntry> = {}): AiProviderEntry {
  return {
    id: "chat-provider",
    label: "Chat Provider",
    encryptedApiKey: encrypt("chat-key", ENCRYPTION_KEY),
    baseURL: "https://chat.example/v1",
    providerFormat: "openai",
    defaultModel: "chat-model",
    ...overrides,
  };
}

/** An enabled AI config whose only Provider key decrypts with the test key. */
export function aiConfig(overrides: Partial<AiConfigStored> = {}): AiConfigStored {
  return {
    enabled: true,
    encryptedApiKey: null,
    baseURL: "",
    model: "",
    systemPrompt: "Be helpful.",
    triggerConfig: {
      replyToBot: true,
      mentionBot: true,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
    },
    groupOverrides: {},
    providers: [chatProvider()],
    activeProviderId: "chat-provider",
    conversationConfig: { ...DEFAULT_CONVERSATION_CONFIG, maxRawMessagesPerChat: 0 },
    ...overrides,
  };
}

/** GitHub coding tools with a legacy token that decrypts with the test key. */
export function githubToolsConfig(): GitHubToolsConfigStored {
  return {
    enabled: true,
    publicReadEnabled: true,
    codingAgentEnabled: true,
    encryptedToken: encrypt("github-token", ENCRYPTION_KEY),
    authorName: "Runtime Bot",
    authorEmail: "runtime-bot@example.test",
    repositories: ["owner/repo"],
  };
}

export function embeddingConfig(): EmbeddingConfig {
  return {
    enabled: true,
    encryptedApiKey: encrypt("embedding-key", ENCRYPTION_KEY),
    baseURL: "https://embedding.example/v1",
    model: "embedding-model",
    dimensions: 3072,
  };
}

export function runtimeInput(
  dbLogger: DbLogger,
  options: {
    bot?: Partial<BotRuntimeInput["bot"]>;
    aiConfig?: AiConfigStored | null;
    miniAppUrl?: string;
  } = {},
): BotRuntimeInput {
  return {
    bot: {
      id: BOT_ID,
      name: "Runtime Bot",
      adminChatIds: [],
      cosInsideConfig: null,
      ...options.bot,
    },
    token: "123:runtime-token",
    aiRuntime: toAiConfigRuntime(options.aiConfig ?? null, ENCRYPTION_KEY),
    dbLogger,
    miniAppUrl: options.miniAppUrl,
  };
}

/** BotPool's own stores over `db`; attached services are absent unless given. */
export function runtimeServices(
  db: unknown,
  logger: Logger,
  attached: Partial<BotRuntimeServices> = {},
): BotRuntimeServices {
  const database = db as Database;
  const userPrivacyService = new UserPrivacyService(database);
  const profileStore = new PeopleProfileStore(database);
  return {
    db: database,
    logger,
    timerRegistry: {} as TimerRegistry,
    conversationStore: new ConversationStore(database),
    profileStore,
    profileAvatarService: new PeopleProfileAvatarService(profileStore, userPrivacyService),
    botMemoryStore: new BotMemoryStore(database),
    userPrivacyService,
    generationLibraryService: new GenerationLibraryService(database, userPrivacyService),
    githubCredentialGenerations: new GitHubCredentialGenerationGate(),
    generationInsertFallbacks: new PendingGenerationInsertFallbackTracker(),
    ...attached,
  };
}

/** A host whose capabilities do nothing; tests replace the ones they observe. */
export function runtimeHost(overrides: Partial<BotRuntimeHost> = {}): BotRuntimeHost {
  return {
    restartBot: async () => {},
    withAiConfigLock: (_botId, operation) => operation(),
    isDelegatedGroupAdmin: async () => false,
    triggerConversationCleanup: () => {},
    fireRecoveredTimer: async () => {},
    getActiveTimersForBot: () => [],
    cancelTimerForBot: async () => false,
    attachTimerHandlers: () => {},
    replaceAiSelectionRuntime: (_botId, register) => {
      register();
    },
    ...overrides,
  };
}
