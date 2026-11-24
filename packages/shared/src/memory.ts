import { DEFAULT_AI_MAX_STEPS } from "./ai-execution.js";

export interface MemoryConfig {
  enabled: boolean;
  maxSteps: number;
  autoReadProfile: boolean;
  autoUpdateLastSeen: boolean;
  toolChoice: "auto" | "required";
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  maxSteps: DEFAULT_AI_MAX_STEPS,
  autoReadProfile: true,
  autoUpdateLastSeen: true,
  toolChoice: "auto",
};

export interface PeopleProfile {
  telegramId: number;
  username: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  isPremium: boolean;
  hasAvatar: boolean;
  avatarVersion: string | null;
  notes: string | null;
  traits: string[];
  interests: string[];
  relationship: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface PeopleProfileObservation {
  telegramId: number;
  username: string | null;
  displayName: string;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  isPremium: boolean;
}

export interface PeopleProfileAvatarUpdate {
  telegramId: number;
  profileId: number;
  refreshVersion: number;
  avatarPath: string | null;
  avatarVersion: string | null;
}

export interface PeopleProfileAvatarRefresh {
  telegramId: number;
  profileId: number;
}

export interface PeopleProfileAvatarUpdateResult {
  previousAvatarPath: string | null;
}

export type PeopleProfileAvatarMediaType = "image/jpeg" | "image/png" | "image/webp";

export type PeopleProfileAvatarResult =
  | {
      status: "available";
      telegramId: number;
      avatarVersion: string | null;
      mediaType: PeopleProfileAvatarMediaType;
      data: Uint8Array;
    }
  | {
      status: "not_found" | "no_avatar" | "cache_unavailable" | "forbidden" | "unavailable";
    };

export interface PeopleProfileTouchResult {
  created: boolean;
  profileId: number;
}

export interface MemorySearchResult {
  role: string;
  content: string;
  userName: string | null;
  chatId: number;
  createdAt: string;
}

export interface MemoryCallbacks {
  getProfile(telegramId: number): Promise<PeopleProfile | null>;
  getProfileAvatar?(
    telegramId: number,
    requesterTelegramId: number,
  ): Promise<PeopleProfileAvatarResult>;
  upsertProfile(data: {
    telegramId: number;
    username?: string;
    displayName?: string;
    notes?: string;
    traits?: string[];
    interests?: string[];
    relationship?: string;
  }): Promise<PeopleProfile>;
  searchProfiles(query: string): Promise<PeopleProfile[]>;
  searchHistory(params: {
    query: string;
    chatId?: number;
    userId?: number;
    limit?: number;
  }): Promise<MemorySearchResult[]>;
  touchProfile(observation: PeopleProfileObservation): Promise<PeopleProfileTouchResult>;
  beginProfileAvatarRefresh(refresh: PeopleProfileAvatarRefresh): Promise<number | null>;
  updateProfileAvatar(
    update: PeopleProfileAvatarUpdate,
  ): Promise<PeopleProfileAvatarUpdateResult | null>;
}

// Bot Memory types
export type BotMemoryKind = "fact" | "preference" | "event" | "commitment" | "relationship";

export interface BotMemory {
  id: number;
  botId: string;
  telegramId: number | null;
  content: string;
  category: string | null;
  kind: BotMemoryKind | null;
  scopeChatId: number | null;
  origin: string | null;
  sourceChatId: number | null;
  sourceMessageId: number | null;
  sourceUserId: number | null;
  expiresAt: string | null;
  factValidAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryConsolidationConfig {
  enabled?: boolean;
  intervalHours?: number;
  maxCallsPerRun?: number;
  groupImpressions?: boolean;
  retentionDays?: number;
  providerId?: string;
  modelId?: string;
}

export const DEFAULT_MEMORY_CONSOLIDATION_CONFIG = {
  enabled: true,
  groupImpressions: true,
  intervalHours: 12,
  maxCallsPerRun: 4,
} as const satisfies MemoryConsolidationConfig;

export interface BotMemoryConfig {
  consolidation?: MemoryConsolidationConfig;
  enabled: boolean;
  maxMemories: number;
  autoInjectMemories: boolean;
}

export const DEFAULT_BOT_MEMORY_CONFIG: BotMemoryConfig = {
  enabled: false,
  maxMemories: 20,
  autoInjectMemories: true,
};

export interface BotMemoryCallbacks {
  saveMemory(params: {
    content: string;
    category?: string;
    telegramId?: number;
    kind?: BotMemoryKind;
    scopeChatId?: number;
    origin?: string;
    sourceChatId?: number;
    sourceMessageId?: number;
    sourceUserId?: number;
    expiresAt?: string;
    factValidAt?: string;
  }): Promise<BotMemory>;
  recallMemories(params: {
    query?: string;
    category?: string;
    telegramId?: number;
    scopeChatId?: number;
    includeUnscopedPersonal?: boolean;
    scope?: "general_only" | "user_only" | "all";
    limit?: number;
  }): Promise<BotMemory[]>;
  updateMemory(
    memoryId: number,
    data: {
      content?: string;
      expectedContent?: string;
      category?: string | null;
      kind?: BotMemoryKind | null;
      expiresAt?: string | null;
      factValidAt?: string | null;
    },
    access: BotMemoryAccess,
  ): Promise<BotMemory | null>;
  retireMemory(
    memoryId: number,
    supersededById: number | undefined,
    access: BotMemoryAccess,
    expectedContent: string,
  ): Promise<boolean>;
  deleteMemory(memoryId: number, access: BotMemoryAccess): Promise<boolean>;
  getMemoriesForPrompt(
    telegramId?: number,
    limit?: number,
    scopeChatId?: number,
    includeUnscopedPersonal?: boolean,
  ): Promise<BotMemory[]>;
  getMemoriesForQuery?(params: {
    query?: string;
    telegramId?: number;
    scopeChatId?: number;
    includeUnscopedPersonal?: boolean;
    limit?: number;
  }): Promise<BotMemory[]>;
  searchProfiles?(query: string, telegramId?: number): Promise<PeopleProfile[]>;
}

export interface BotMemoryAccess {
  userId?: number;
  chatId: number;
  includeUnscopedPersonal?: boolean;
}
