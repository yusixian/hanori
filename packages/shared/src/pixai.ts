// Image generation size constraints (single source of truth)
export const IMAGE_MIN_SIZE = 1;
export const IMAGE_MAX_SIZE = 3072;

export interface PixAIRateLimitConfig {
  maxConcurrentTasks?: number; // 全局并发上限，默认 6
  maxQueueDepth?: number; // 排队深度，默认 10
  userCooldownSec?: number; // 用户冷却秒数，默认 10
  chatCooldownSec?: number; // 群聊冷却秒数，默认 5
  hourlyLimit?: number; // 每小时限额（非管理员），默认 100
  adminBypass?: boolean; // 管理员绕过，默认 true
}

export const DEFAULT_PIXAI_RATE_LIMIT: Required<PixAIRateLimitConfig> = {
  maxConcurrentTasks: 6,
  maxQueueDepth: 10,
  userCooldownSec: 10,
  chatCooldownSec: 5,
  hourlyLimit: 100,
  adminBypass: true,
};

export interface PixAIConfig {
  // 限流配置
  rateLimit?: PixAIRateLimitConfig;

  // 基本参数
  negativePrompts?: string;
  samplingSteps?: number; // default 20, range 8-50
  cfgScale?: number; // default 5, range 1.1-15
  width?: number; // default 832, range IMAGE_MIN_SIZE-IMAGE_MAX_SIZE
  height?: number; // default 1472, range IMAGE_MIN_SIZE-IMAGE_MAX_SIZE
  batchSize?: number; // default 1, range 1-4
  promptHelper?: boolean; // default false (额外扣费)

  // 系统生图提示词（附加在每次生图 prompt 前面）
  systemImagePrompt?: string;

  // API 模式
  apiMode?: "graphql" | "rest"; // 默认 "graphql"

  // 通用参数
  priority?: number; // 默认 1000
  seed?: string; // 空字符串=随机
  clipSkip?: number; // 默认 2
  lightning?: boolean; // 快速模式

  // 模型相关
  modelStyle?: { type: "key"; keyId: string };
  inferenceProfile?: string; // 如 "standard"
  samplingMethod?: string; // 如 "Euler"
  qualityTag?: { prefix: string; suffix: string };

  // 高级
  isPrivate?: boolean;

  // NSFW 检测
  nsfwThreshold?: number; // NSFW 综合分数阈值，默认 0.5
}

// NSFW detection types

export const DEFAULT_NSFW_THRESHOLD = 0.5;

export interface NsfwScores {
  porn: number;
  sexy: number;
  hentai: number;
  neutral: number;
  drawing: number;
}

// PixAI generation tracking types

export type PixAIGenerationStatus = "pending" | "completed" | "failed";

export interface PixAIGenerationRecord {
  chatId: number;
  userId?: number;
  taskId: string;
  prompt: string;
  negativePrompt?: string;
  modelId: string;
  width: number;
  height: number;
  batchSize: number;
  samplingSteps?: number;
  cfgScale?: number;
  promptHelper?: boolean;
  pixaiConfig?: PixAIConfig;
  status: PixAIGenerationStatus;
  mediaUrls?: string[];
  mediaIds?: string[];
  localFiles?: string[];
  nsfwScores?: NsfwScores[];
  errorMessage?: string;
  durationMs?: number;
}
