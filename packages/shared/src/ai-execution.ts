import { DEFAULT_TIMER_MAX_SECONDS } from "./timers.js";

export const DEFAULT_AI_MAX_STEPS = 128;
export const MAX_TOOL_CALLS_PER_REQUEST = 512;
export const DEFAULT_SUB_AGENT_MAX_STEPS = 64;
export const MAX_SUB_AGENT_STEPS = 128;
export const MAX_CONCURRENT_AI_REPLIES = 128;

export interface TimeoutConfig {
  /** 主 AI generateText 总超时 (ms) */
  aiReplyMs?: number;
  /** 每个 AI step（单轮 API 调用）超时 (ms) */
  perStepMs?: number;
  /** 搜索请求超时 (ms) */
  searchMs?: number;
  /** 网页抓取超时 (ms) */
  fetchPageMs?: number;
  /** 图片生成超时 (ms) */
  imageGenerationMs?: number;
  /** researcher agent 超时 (ms) */
  researcherAgentMs?: number;
  /** 其他 agent 超时 (ms) */
  defaultAgentMs?: number;
  /** 图片下载超时 (ms) */
  imageDownloadMs?: number;
  /** PixAI 后台任务轮询超时 (ms) */
  pixaiTaskMs?: number;
}

export const DEFAULT_TIMEOUT_CONFIG: Required<TimeoutConfig> = {
  aiReplyMs: 60 * 60 * 1000,
  perStepMs: 5 * 60 * 1000,
  searchMs: 2 * 60 * 1000,
  fetchPageMs: 2 * 60 * 1000,
  imageGenerationMs: 60 * 60 * 1000,
  researcherAgentMs: 30 * 60 * 1000,
  defaultAgentMs: 30 * 60 * 1000,
  imageDownloadMs: 5 * 60 * 1000,
  pixaiTaskMs: 6 * 60 * 60 * 1000,
};

/** Keeps PixAI polling below the bounded pending-insert fallback retention window. */
export const PIXAI_TASK_TIMEOUT_MAX_MS = 23 * 60 * 60 * 1000;

export interface AiExecutionConfig {
  /** Maximum number of AI replies that may execute concurrently across chats for one Bot. */
  maxConcurrentReplies: number;
  /** Longest duration the AI may request from set_timer, in seconds. */
  timerMaxSeconds?: number;
  queueNotice: {
    enabled: boolean;
    /** Plain-text notice sent when an AI reply must wait for a scheduler slot. */
    text: string;
  };
}

export const DEFAULT_AI_EXECUTION_CONFIG: AiExecutionConfig = {
  maxConcurrentReplies: 32,
  timerMaxSeconds: DEFAULT_TIMER_MAX_SECONDS,
  queueNotice: {
    enabled: true,
    text: "正在处理中，请稍候～",
  },
};
