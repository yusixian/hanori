import type { ScheduledTaskPort } from "@cos-tool-bot/shared";
import type { MediaTranscriptionPort, PluginRuntimePort } from "@cos-tool-bot/shared";
import type {
  BotTimerHandlers,
  TelegramObservationCallbacks,
  NsfwChecker,
} from "@cos-tool-bot/bot";
import type { Database, bots } from "@cos-tool-bot/database";
import type { ImageGenerationPort, TimerRecord, UsageGovernancePort } from "@cos-tool-bot/shared";
import type { Logger } from "pino";
import type { HarnessService } from "../../harness/service.js";
import type { AiConfigRuntime } from "../ai-config-runtime.js";
import type { BackupService } from "../backup.js";
import type { BotManagerConfig, BotManagerOptions } from "../bot-manager.js";
import type { BotMemoryStore } from "../bot-memory-store.js";
import type { ChatAiSelectionRuntimeRegistry } from "../chat-ai-selection-runtime-registry.js";
import type { ChatAiSelectionService } from "../chat-ai-selection-service.js";
import type { ChatSummaryService } from "../chat-summary-service.js";
import type { ConversationStore } from "../conversation-store.js";
import type { DbLogger } from "../db-logger.js";
import type { EmbeddingService } from "../embedding-service.js";
import type { EngagementSampleService } from "../engagement-sample-service.js";
import type { GenerationLibraryService } from "../generation-library-service.js";
import type { PendingGenerationInsertFallbackTracker } from "../generation-recovery.js";
import type { GitWorkspaceService } from "../git-workspace-service.js";
import type { GitHubIssueProposalService } from "../github-issue-proposals.js";
import type { GitHubAppCredentialService } from "../github-app-credentials.js";
import type { GitHubCredentialGenerationGate } from "../github-credential-policy.js";
import type { McpClientManager } from "../mcp-client-manager.js";
import type { PeopleProfileAvatarService } from "../people-profile-avatar-service.js";
import type { PeopleProfileStore } from "../people-profile-store.js";
import type { RssFeedService } from "../rss-feed-service.js";
import type { SummaryConfigService } from "../summary-config-service.js";
import type { TimerRegistry } from "../timer-registry.js";
import type { UserPrivacyService } from "../user-privacy-service.js";

export type ChatAiSelectionPort = Pick<
  ChatAiSelectionService,
  | "loadRuntimeSnapshot"
  | "retryPublish"
  | "setModelFromTelegram"
  | "resetModelFromTelegram"
  | "setProviderFromTelegram"
  | "resetProviderFromTelegram"
>;

export interface BotRuntimeInput {
  bot: Pick<typeof bots.$inferSelect, "id" | "name" | "adminChatIds" | "cosInsideConfig">;
  token: string;
  aiRuntime: AiConfigRuntime | null;
  dbLogger: DbLogger;
  miniAppUrl?: string;
}

/**
 * What BotPool holds: its own stores plus the services attached after construction. Assembly
 * decides from it which features exist and with which config. Only calls made inside callbacks
 * can bind late: some callbacks look their service up again on each call, others keep the
 * instance they were assembled with.
 */
export interface BotRuntimeServices {
  scheduledTasks?: ScheduledTaskPort;
  plugins?: PluginRuntimePort;
  mediaTranscriptionPort?: MediaTranscriptionPort;
  nsfwChecker?: NsfwChecker;
  db: Database;
  logger: Logger;
  timerRegistry: TimerRegistry;
  conversationStore: ConversationStore;
  profileStore: PeopleProfileStore;
  profileAvatarService: PeopleProfileAvatarService;
  botMemoryStore: BotMemoryStore;
  userPrivacyService: UserPrivacyService;
  generationLibraryService: GenerationLibraryService;
  githubCredentialGenerations: GitHubCredentialGenerationGate;
  generationInsertFallbacks: PendingGenerationInsertFallbackTracker;
  chatAiSelectionService?: ChatAiSelectionPort;
  chatAiSelectionRuntimeRegistry?: ChatAiSelectionRuntimeRegistry;
  backupService?: BackupService;
  rssFeedService?: RssFeedService;
  mcpClientManager?: McpClientManager;
  imageGenerationPort?: ImageGenerationPort;
  usageGovernance?: UsageGovernancePort;
  summaryService?: ChatSummaryService;
  summaryConfigService?: SummaryConfigService;
  gitWorkspaceService?: GitWorkspaceService;
  githubAppCredentialService?: GitHubAppCredentialService;
  githubIssueProposalService?: GitHubIssueProposalService;
  harnessService?: HarnessService;
  engagementSampleService?: Pick<EngagementSampleService, "persist">;
  telegramObservation?: TelegramObservationCallbacks;
}

/** BotPool capabilities that the Bot's callbacks call back into while it runs. */
export interface BotRuntimeHost {
  getRuntimeStatus?(
    botId: string,
  ): { status: "running" | "stopped" | "restarting"; uptime: number | null } | undefined;
  restartBot(botId: string): Promise<void>;
  /** Capture a deferred restart request that expires with the current runtime. */
  createDeferredRestart(botId: string): () => void;
  withAiConfigLock<T>(botId: string, operation: () => Promise<T>): Promise<T>;
  isDelegatedGroupAdmin(botId: string, chatId: number, userId: number): Promise<boolean>;
  triggerConversationCleanup(botId: string, retentionDays: number): void;
  fireRecoveredTimer(
    timerId: string,
    botId: string,
    chatId: number,
    meta: Record<string, unknown> | null,
    delayed?: boolean,
  ): Promise<void>;
  getActiveTimersForBot(botId: string): TimerRecord[];
  cancelTimerForBot(botId: string, timerId: string): Promise<boolean>;
  attachTimerHandlers(botId: string, handlers: BotTimerHandlers): void;
  /** Disposes the Bot's previous AI selection runtime, then keeps the disposer `register` returns. */
  replaceAiSelectionRuntime(botId: string, register: () => () => void): void;
}

export interface BotRuntime {
  config: BotManagerConfig;
  managerOptions: BotManagerOptions;
  /** Created for this start; register it for Pool-level memory writes once the Bot runs. */
  embeddingService?: EmbeddingService;
  runInitialHistoryGovernance?: () => Promise<void>;
}
