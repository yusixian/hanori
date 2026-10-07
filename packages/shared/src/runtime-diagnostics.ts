import type { ImageDeliveryState, ImageGenerationState } from "./image-generation.js";
import type { UsageResource, UsageWindow } from "./usage-governance.js";

export const RUNTIME_DIAGNOSTIC_CODES = [
  "queue_full",
  "empty_response",
  "command",
  "unsupported_content",
  "ai_disabled",
  "usage_limited",
  "accepted",
  "denied",
  "not_triggered",
  "triggered",
  "admin_bypass",
  "engagement_allowed",
  "engagement_denied",
  "context_loaded",
  "model_started",
  "model_succeeded",
  "model_failed",
  "model_timeout",
  "provider_error",
  "tool_started",
  "tool_succeeded",
  "tool_failed",
  "delivery_failed",
  "response_sent",
  "cancelled",
  "timed_out",
  "coalesced",
  "queued",
  "failed",
  "completed",
  "persistence_failed",
  "recovered",
] as const;
export type RuntimeDiagnosticCode = (typeof RUNTIME_DIAGNOSTIC_CODES)[number];
export const RUNTIME_DIAGNOSTIC_OPERATIONS = [
  "get_runtime_status",
  "get_effective_config",
  "get_request_trace",
  "query_sanitized_logs",
  "get_recent_errors",
] as const;
export type RuntimeDiagnosticOperation = (typeof RUNTIME_DIAGNOSTIC_OPERATIONS)[number];
export interface RuntimeDiagnosticScope {
  chatId: number;
  userId: number;
  messageId: number;
  updateId?: number;
}
export interface RuntimeDiagnosticActor extends RuntimeDiagnosticScope {
  currentTraceId?: string;
}
export interface RuntimeDiagnosticEvent {
  generationId?: string;
  providerOperationId?: string;
  deliveryState?: ImageDeliveryState;
  stage:
    | "received"
    | "trigger"
    | "queue"
    | "model"
    | "tool"
    | "delivery"
    | "complete"
    | "ingress"
    | "persistence"
    | "access"
    | "engagement"
    | "context"
    | "response"
    | "recovery";
  outcome:
    | "started"
    | "succeeded"
    | "skipped"
    | "failed"
    | "cancelled"
    | "queued"
    | "timed_out"
    | "coalesced";
  code?: RuntimeDiagnosticCode;
  parentTraceId?: string;
  toolCallId?: string;
  updateId?: number;
  toolName?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}
export interface RuntimeEffectiveConfig {
  enabled: boolean;
  providerId?: string;
  modelId?: string;
  providerFormat?: string;
  triggerMode?: string;
  engagementMode?: string;
  conversationEnabled?: boolean;
  memoryEnabled?: boolean;
  timeoutMs?: number;
  perStepMs?: number;
  aiReplyMs?: number;
  replyMode?: string;
  concurrency?: number;
  source?: "runtime";
  skillNames?: string[];
  maxSteps?: number;
  toolNames?: string[];
}
export interface RuntimeSchedulerSnapshot {
  active: number | null;
  queued: number | null;
  asyncTasks: number | null;
}
export interface RuntimeDiagnosticReaders {
  effectiveConfig(chatId: number): RuntimeEffectiveConfig;
  scheduler(chatId: number): RuntimeSchedulerSnapshot;
}
export interface RuntimeDiagnosticRequest {
  operation: RuntimeDiagnosticOperation;
  traceId?: string;
  messageId?: number;
  toolCallId?: string;
  previous?: boolean;
  windowMs?: number;
  limit?: number;
  offset?: number;
}
export interface RuntimeDiagnosticTrace {
  traceId: string;
  messageId: number;
  startedAt: number;
  events: (RuntimeDiagnosticEvent & { at: number })[];
  truncated: boolean;
}
export interface RuntimeDiagnosticResponse {
  ok: boolean;
  code?: "forbidden" | "rate_limited" | "invalid_request" | "not_found" | "unavailable";
  /** Records are limited to the current process; empty history does not establish absence of errors. */
  historyScope?: "current_process";
  retentionMs: number;
  processStartedAt: number;
  truncated: boolean;
  total?: number;
  traces?: RuntimeDiagnosticTrace[];
  config?: RuntimeEffectiveConfig;
  errors?: {
    code: string;
    stage: RuntimeDiagnosticEvent["stage"];
    count: number;
    lastAt: number;
  }[];
  runtime?: {
    botStatus: "running" | "stopped" | "restarting" | "unknown";
    uptimeMs: number | null;
    version: string;
    environment: "development" | "production" | "test" | "unknown";
    startedAt: number;
    checkedAt: number;
    server?: "responding";
    telegramMode?: "polling";
    rss: "unobserved" | { activeCollections: number; lastDigestAt: number | null };
    imageTasks:
      | "unobserved"
      | {
          windowMs: number;
          states: Partial<Record<ImageGenerationState | "unknown", number>>;
        };
    quota?:
      | "unobserved"
      | {
          resource: UsageResource;
          scope: "chat" | "chat_user";
          active: number;
          concurrencyLimit?: number;
          windows: {
            window: UsageWindow;
            used: number;
            limit: number;
            remaining: number;
            resetsAt?: number;
          }[];
        }[];
    githubTasks: "unobserved";
    database: "reachable" | "unavailable";
    redis: "not_configured";
    model: "unknown";
    telegram: "unknown";
    lastModelEvent?: Pick<RuntimeDiagnosticEvent, "outcome" | "code"> & { at: number };
    lastDeliveryEvent?: Pick<RuntimeDiagnosticEvent, "outcome" | "code"> & { at: number };
    scheduler?: RuntimeSchedulerSnapshot;
    activeTimers: number;
  };
}
export interface RuntimeDiagnosticsPort {
  startTrace(scope: RuntimeDiagnosticScope): string;
  record(traceId: string, event: RuntimeDiagnosticEvent): void;
  bindRuntime(readers: RuntimeDiagnosticReaders): void;
  query(
    actor: RuntimeDiagnosticActor,
    request: RuntimeDiagnosticRequest,
  ): Promise<RuntimeDiagnosticResponse>;
}
