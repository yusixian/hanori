import { randomUUID } from "node:crypto";
import type {
  RuntimeDiagnosticCode,
  RuntimeDiagnosticActor,
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticReaders,
  RuntimeDiagnosticRequest,
  RuntimeDiagnosticResponse,
  RuntimeDiagnosticScope,
  RuntimeDiagnosticTrace,
  RuntimeDiagnosticsPort,
  RuntimeEffectiveConfig,
} from "@cos-tool-bot/shared";
import { RUNTIME_DIAGNOSTIC_CODES, RUNTIME_DIAGNOSTIC_OPERATIONS } from "@cos-tool-bot/shared";

interface Trace extends RuntimeDiagnosticTrace {
  scope: RuntimeDiagnosticScope;
}
interface Options {
  adminIds: readonly number[];
  audit(entry: {
    actor: RuntimeDiagnosticActor;
    operation: string;
    outcome: string;
    windowMs?: number;
    limit?: number;
    offset?: number;
    resultCount: number;
    traceId?: string;
    messageId?: number;
    toolCallId?: string;
    previous?: boolean;
  }): Promise<void>;
  runtime(
    chatId: number,
    userId: number,
  ): Promise<NonNullable<RuntimeDiagnosticResponse["runtime"]>>;
  secrets?: readonly string[];
  now?: () => number;
  retentionMs?: number;
  maxTraces?: number;
  maxEvents?: number;
}
const STAGES = new Set([
  "received",
  "trigger",
  "queue",
  "model",
  "tool",
  "delivery",
  "complete",
  "ingress",
  "persistence",
  "access",
  "engagement",
  "context",
  "response",
  "recovery",
]);
const OUTCOMES = new Set([
  "started",
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
  "queued",
  "timed_out",
  "coalesced",
]);
const DIAGNOSTIC_CODES = new Set<string>(RUNTIME_DIAGNOSTIC_CODES);
const MAX_WINDOW = 24 * 60 * 60 * 1000;

/** Owns only explicit structured events for one Bot boot. Never reads application logs. */
export class RuntimeDiagnostics implements RuntimeDiagnosticsPort {
  private readonly traces = new Map<string, Trace>();
  private readonly actors = new Map<string, { startedAt: number; count: number }>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly processStartedAt: number;
  private readers?: RuntimeDiagnosticReaders;
  private rate = { startedAt: 0, count: 0 };
  private evicted = false;
  private auditsInFlight = 0;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.retentionMs = Math.max(1, Math.min(options.retentionMs ?? 3_600_000, MAX_WINDOW));
    this.processStartedAt = this.now();
  }
  bindRuntime(readers: RuntimeDiagnosticReaders): void {
    this.readers = readers;
  }
  private sweep(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, trace] of this.traces)
      if ((trace.events.at(-1)?.at ?? trace.startedAt) < cutoff) this.traces.delete(id);
    for (const [id, bucket] of this.actors)
      if (bucket.startedAt < this.now() - 60_000) this.actors.delete(id);
  }
  startTrace(scope: RuntimeDiagnosticScope): string {
    this.sweep();
    const traceId = randomUUID();
    if (
      !Number.isSafeInteger(scope.chatId) ||
      !Number.isSafeInteger(scope.userId) ||
      scope.userId <= 0 ||
      !Number.isSafeInteger(scope.messageId)
    )
      return traceId;
    while (this.traces.size >= Math.max(1, Math.min(this.options.maxTraces ?? 500, 500))) {
      const oldest = this.traces.keys().next().value;
      if (!oldest) break;
      this.traces.delete(oldest);
      this.evicted = true;
    }
    this.traces.set(traceId, {
      traceId,
      scope: { ...scope },
      messageId: scope.messageId,
      startedAt: this.now(),
      events: [],
      truncated: false,
    });
    return traceId;
  }
  private safeIdentifier(value: unknown, modelId = false): string | undefined {
    const pattern = modelId ? /^[a-zA-Z0-9_-]+(?:[./-][a-zA-Z0-9_-]+)*$/ : /^[a-zA-Z0-9_.:-]+$/;
    if (typeof value !== "string" || value.length > 100 || !pattern.test(value)) return undefined;
    if (this.options.secrets?.some((secret) => secret.length > 0 && value.includes(secret)))
      return undefined;
    return value;
  }
  private number(value: unknown): number | undefined {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER
      ? value
      : undefined;
  }
  private eventCode(code: unknown): RuntimeDiagnosticCode | undefined {
    return typeof code === "string" && DIAGNOSTIC_CODES.has(code)
      ? (code as RuntimeDiagnosticCode)
      : undefined;
  }
  record(traceId: string, event: RuntimeDiagnosticEvent): void {
    this.sweep();
    const trace = this.traces.get(traceId);
    if (!trace || !event || !STAGES.has(event.stage) || !OUTCOMES.has(event.outcome)) return;
    if (trace.events.length >= Math.max(1, Math.min(this.options.maxEvents ?? 64, 64))) {
      trace.truncated = true;
      trace.events.splice(trace.events.length > 1 ? 1 : 0, 1);
    }
    trace.events.push({
      stage: event.stage,
      outcome: event.outcome,
      at: this.now(),
      code: this.eventCode(event.code),
      parentTraceId:
        typeof event.parentTraceId === "string" && /^[a-f0-9-]{36}$/i.test(event.parentTraceId)
          ? event.parentTraceId
          : undefined,
      toolCallId: this.safeIdentifier(event.toolCallId),
      updateId: this.number(event.updateId),
      toolName: this.safeIdentifier(event.toolName),
      durationMs: this.number(event.durationMs),
      inputTokens: this.number(event.inputTokens),
      outputTokens: this.number(event.outputTokens),
    });
  }
  private projectConfig(raw: RuntimeEffectiveConfig): RuntimeEffectiveConfig {
    const config: RuntimeEffectiveConfig = { enabled: raw.enabled === true };
    for (const key of [
      "providerId",
      "modelId",
      "providerFormat",
      "triggerMode",
      "engagementMode",
    ] as const)
      config[key] = this.safeIdentifier(raw[key], key === "modelId");
    for (const key of ["conversationEnabled", "memoryEnabled"] as const)
      if (typeof raw[key] === "boolean") config[key] = raw[key];
    config.timeoutMs = this.number(raw.timeoutMs);
    config.maxSteps = this.number(raw.maxSteps);
    config.perStepMs = this.number(raw.perStepMs);
    config.aiReplyMs = this.number(raw.aiReplyMs);
    config.concurrency = this.number(raw.concurrency);
    config.replyMode = this.safeIdentifier(raw.replyMode);
    config.source = "runtime";
    if (Array.isArray(raw.skillNames))
      config.skillNames = raw.skillNames
        .slice(0, 100)
        .map((name) => this.safeIdentifier(name))
        .filter((name): name is string => name !== undefined);
    if (Array.isArray(raw.toolNames))
      config.toolNames = raw.toolNames
        .slice(0, 100)
        .map((name) => this.safeIdentifier(name))
        .filter((name): name is string => name !== undefined);
    return config;
  }
  private limited(actor: RuntimeDiagnosticActor): boolean {
    const now = this.now();
    if (this.rate.startedAt <= now - 60_000) this.rate = { startedAt: now, count: 0 };
    this.rate.count++;
    const key = `${actor.chatId}:${actor.userId}`;
    let bucket = this.actors.get(key);
    if (!bucket) {
      if (this.actors.size >= 200) return true;
      bucket = { startedAt: now, count: 0 };
      this.actors.set(key, bucket);
    }
    bucket.count++;
    return this.rate.count > 60 || bucket.count > 10;
  }
  async query(
    actor: RuntimeDiagnosticActor,
    request: RuntimeDiagnosticRequest,
  ): Promise<RuntimeDiagnosticResponse> {
    this.sweep();
    let response: RuntimeDiagnosticResponse = {
      ok: true,
      retentionMs: this.retentionMs,
      processStartedAt: this.processStartedAt,
      truncated: this.evicted,
    };
    const deny = (code: RuntimeDiagnosticResponse["code"]) => {
      response = { ...response, ok: false, code };
    };
    const operation = request?.operation;
    if (
      !this.options.adminIds.includes(actor.userId) ||
      !Number.isSafeInteger(actor.chatId) ||
      !Number.isSafeInteger(actor.messageId)
    )
      deny("forbidden");
    else if (this.limited(actor)) deny("rate_limited");
    else if (
      !RUNTIME_DIAGNOSTIC_OPERATIONS.includes(operation) ||
      Object.keys(request).some(
        (key) =>
          ![
            "operation",
            "traceId",
            "previous",
            "windowMs",
            "limit",
            "offset",
            "messageId",
            "toolCallId",
          ].includes(key),
      ) ||
      (request.windowMs !== undefined &&
        (!Number.isInteger(request.windowMs) ||
          request.windowMs < 1 ||
          request.windowMs > MAX_WINDOW)) ||
      (request.limit !== undefined &&
        (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50)) ||
      (request.offset !== undefined &&
        (!Number.isInteger(request.offset) || request.offset < 0 || request.offset > 500)) ||
      (request.traceId !== undefined &&
        (typeof request.traceId !== "string" || request.traceId.length > 100)) ||
      (request.messageId !== undefined &&
        (!Number.isSafeInteger(request.messageId) || request.messageId < 0)) ||
      (request.toolCallId !== undefined && !this.safeIdentifier(request.toolCallId)) ||
      (request.previous !== undefined && typeof request.previous !== "boolean")
    )
      deny("invalid_request");
    else {
      try {
        if (operation === "get_runtime_status") {
          response.runtime = await this.options.runtime(actor.chatId, actor.userId);
          for (const trace of this.traces.values()) {
            if (trace.scope.chatId !== actor.chatId) continue;
            for (const event of trace.events) {
              const key =
                event.stage === "model"
                  ? "lastModelEvent"
                  : event.stage === "delivery"
                    ? "lastDeliveryEvent"
                    : undefined;
              if (key && (!response.runtime[key] || response.runtime[key].at <= event.at)) {
                response.runtime[key] = { at: event.at, outcome: event.outcome, code: event.code };
              }
            }
          }
        }
        if (operation === "get_runtime_status" && this.readers) {
          const scheduler = this.readers.scheduler(actor.chatId);
          response.runtime!.scheduler = {
            active: this.number(scheduler.active) ?? null,
            queued: this.number(scheduler.queued) ?? null,
            asyncTasks: this.number(scheduler.asyncTasks) ?? null,
          };
        }
        if (operation === "get_effective_config") {
          if (this.readers)
            response.config = this.projectConfig(this.readers.effectiveConfig(actor.chatId));
          else deny("unavailable");
        }
        if (
          ["get_request_trace", "query_sanitized_logs", "get_recent_errors"].includes(operation)
        ) {
          let traces = [...this.traces.values()].filter(
            (trace) =>
              trace.scope.chatId === actor.chatId &&
              (trace.events.at(-1)?.at ?? trace.startedAt) >=
                this.now() - Math.min(request.windowMs ?? this.retentionMs, this.retentionMs),
          );
          traces.reverse();
          if (request.traceId) traces = traces.filter((trace) => trace.traceId === request.traceId);
          if (request.messageId !== undefined)
            traces = traces.filter((trace) => trace.messageId === request.messageId);
          if (request.toolCallId !== undefined)
            traces = traces.filter((trace) =>
              trace.events.some((event) => event.toolCallId === request.toolCallId),
            );
          if (operation === "get_request_trace") {
            if (
              request.previous !== false &&
              !request.traceId &&
              request.messageId === undefined &&
              !request.toolCallId
            )
              traces = traces
                .filter(
                  (trace) =>
                    trace.scope.userId === actor.userId &&
                    trace.messageId < actor.messageId &&
                    trace.traceId !== actor.currentTraceId,
                )
                .slice(0, 1);
            else if (request.traceId || (request.messageId === undefined && !request.toolCallId))
              traces = traces.filter(
                (trace) => trace.traceId === (request.traceId ?? actor.currentTraceId),
              );
          }
          if (operation === "get_request_trace") {
            const selected = [...traces];
            const ids = new Set(traces.map((trace) => trace.traceId));
            for (
              let parentIndex = 0;
              parentIndex < selected.length && parentIndex < 64;
              parentIndex++
            ) {
              const trace = selected[parentIndex]!;
              for (const event of trace.events) {
                const parent = event.parentTraceId
                  ? this.traces.get(event.parentTraceId)
                  : undefined;
                if (parent && parent.scope.chatId === actor.chatId && !ids.has(parent.traceId)) {
                  traces.push(parent);
                  selected.push(parent);
                  ids.add(parent.traceId);
                }
              }
            }
          }
          if (operation !== "get_request_trace") {
            const cutoff =
              this.now() - Math.min(request.windowMs ?? this.retentionMs, this.retentionMs);
            traces = traces
              .map((trace) => ({
                ...trace,
                events: trace.events.filter(
                  (event) =>
                    event.at >= cutoff &&
                    (request.toolCallId === undefined || event.toolCallId === request.toolCallId) &&
                    (operation !== "get_recent_errors" ||
                      event.outcome === "failed" ||
                      event.outcome === "timed_out"),
                ),
              }))
              .filter((trace) => trace.events.length > 0);
          }
          if (operation === "get_recent_errors")
            traces = traces.filter((trace) =>
              trace.events.some(
                (event) => event.outcome === "failed" || event.outcome === "timed_out",
              ),
            );
          if (operation === "get_recent_errors") {
            const groups = new Map<
              string,
              {
                code: string;
                stage: RuntimeDiagnosticEvent["stage"];
                count: number;
                lastAt: number;
              }
            >();
            for (const trace of traces)
              for (const event of trace.events)
                if (
                  (event.outcome === "failed" || event.outcome === "timed_out") &&
                  event.at >=
                    this.now() - Math.min(request.windowMs ?? this.retentionMs, this.retentionMs)
                ) {
                  const code = event.code ?? "failed";
                  const key = `${event.stage}:${code}`;
                  const old = groups.get(key);
                  groups.set(key, {
                    code,
                    stage: event.stage,
                    count: (old?.count ?? 0) + 1,
                    lastAt: Math.max(old?.lastAt ?? 0, event.at),
                  });
                }
            response.errors = [...groups.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 50);
          }
          response.total = traces.length;
          response.traces = [];
          for (const trace of traces.slice(
            request.offset ?? 0,
            (request.offset ?? 0) + (request.limit ?? 10),
          )) {
            const projected = {
              traceId: trace.traceId,
              messageId: trace.messageId,
              startedAt: trace.startedAt,
              truncated: trace.truncated,
              events: trace.events.map((event) => ({ ...event })),
            };
            // Keep a usable first trace, including its latest event, even when unusually
            // dense tool metadata would otherwise consume the entire response budget.
            while (
              response.traces.length === 0 &&
              projected.events.length > 1 &&
              JSON.stringify(response).length + JSON.stringify(projected).length > 24_000
            ) {
              projected.events.splice(projected.events.length > 2 ? 1 : 0, 1);
              projected.truncated = true;
            }
            if (JSON.stringify(response).length + JSON.stringify(projected).length > 24_000) {
              response.truncated = true;
              break;
            }
            response.traces.push(projected);
          }
          if (operation === "get_request_trace" && response.total === 0) deny("not_found");
        }
      } catch {
        response = {
          ok: false,
          code: "unavailable",
          retentionMs: this.retentionMs,
          processStartedAt: this.processStartedAt,
          truncated: this.evicted,
        };
      }
    }
    if (this.auditsInFlight >= 4) throw new Error("Diagnostic audit unavailable");
    this.auditsInFlight++;
    let auditTimeout: ReturnType<typeof setTimeout> | undefined;
    const audit = Promise.resolve()
      .then(() =>
        this.options.audit({
          actor,
          operation: this.safeIdentifier(operation) ?? "invalid",
          outcome: response.code ?? "succeeded",
          windowMs: response.ok ? (request.windowMs ?? this.retentionMs) : undefined,
          limit: response.ok ? (request.limit ?? 10) : undefined,
          offset: response.ok ? (request.offset ?? 0) : undefined,
          traceId:
            response.ok &&
            typeof request.traceId === "string" &&
            /^[a-f0-9-]{36}$/i.test(request.traceId)
              ? request.traceId
              : undefined,
          messageId: response.ok ? request.messageId : undefined,
          toolCallId: response.ok ? this.safeIdentifier(request.toolCallId) : undefined,
          previous:
            response.ok && operation === "get_request_trace"
              ? (request.previous ??
                (!request.traceId && request.messageId === undefined && !request.toolCallId))
              : undefined,
          resultCount: response.traces?.length ?? (response.config || response.runtime ? 1 : 0),
        }),
      )
      .finally(() => {
        this.auditsInFlight--;
      });
    try {
      await Promise.race([
        audit,
        new Promise((_, reject) => {
          auditTimeout = setTimeout(() => reject(new Error("Diagnostic audit unavailable")), 1000);
        }),
      ]);
    } catch {
      // Driver errors may contain connection strings. They must never become model input.
      throw new Error("Diagnostic audit unavailable");
    } finally {
      if (auditTimeout) clearTimeout(auditTimeout);
    }
    return response;
  }
}
