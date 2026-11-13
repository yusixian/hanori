import {
  APICallError,
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolCallRepairFunction,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import {
  DEFAULT_MODEL_RECOVERY,
  type BotLogEntry,
  type ModelRecoveryConfig,
} from "@cos-tool-bot/shared";
import { modelErrorSummary } from "./model-error-summary.js";

type Model = ReturnType<typeof wrapLanguageModel>;
type CallOptions = Parameters<Model["doStream"]>[0];
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

export interface RecoverySelection {
  model: LanguageModel;
  modelId: string;
  providerId: string;
  providerFormat?: "openai" | "gemini";
  temperature?: number;
  maxTokens?: number;
  providerOptions?: CallOptions["providerOptions"];
}

function retryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403 || status === 404 || status === 422) return false;
    // This is an upstream message parsing failure, not our tool schema validator.
    if (status === 400) return /Failed to parse parameters from your message/i.test(error.message);
    return (
      error.isRetryable ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status !== undefined && status >= 500)
    );
  }
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  return (
    error.name === "TimeoutError" ||
    (error instanceof TypeError && /fetch failed|network|terminated/i.test(error.message)) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|UND_ERR_(CONNECT_TIMEOUT|SOCKET)/.test(
      String((error.cause as { code?: string } | undefined)?.code ?? ""),
    )
  );
}

/** One recovery budget per turn; replay only a model request, never the agent/tool loop. */
export function createModelRecovery(options: {
  primary: RecoverySelection;
  fallback?: RecoverySelection;
  config?: ModelRecoveryConfig;
  onLog?: (entry: BotLogEntry) => void | Promise<void>;
  secrets?: readonly string[];
  signal?: AbortSignal;
  onSelectionChange?: (selection: RecoverySelection) => void;
}): {
  model: Model;
  repairToolCall: ToolCallRepairFunction<ToolSet>;
  selection: () => RecoverySelection;
  streamSelections: readonly RecoverySelection[];
  repairUsages: readonly { selection: RecoverySelection; usage: LanguageModelUsage }[];
} {
  const policy = options.config ?? DEFAULT_MODEL_RECOVERY;
  let current = options.primary;
  const streamSelections: RecoverySelection[] = [];
  const repairUsages: { selection: RecoverySelection; usage: LanguageModelUsage }[] = [];
  let remaining = policy.maxRetries;
  let switched = false;
  let requestNumber = 0;
  let currentSignal = options.signal;
  const alternate =
    options.fallback &&
    (options.fallback.providerId !== current.providerId ||
      options.fallback.modelId !== current.modelId)
      ? options.fallback
      : undefined;

  const log = (decision: string, stage: string, error?: unknown, failedSelection = current) => {
    const entry: BotLogEntry = {
      level: decision === "stopped" ? "warn" : "info",
      message: "AI model recovery",
      meta: {
        decision,
        stage,
        model: current.modelId,
        providerId: current.providerId,
        providerFormat: current.providerFormat,
        requestNumber,
        remainingRetries: remaining,
        ...(error !== undefined
          ? {
              failedModel: failedSelection.modelId,
              failedProviderId: failedSelection.providerId,
              errorSummary: modelErrorSummary(error, options.secrets),
            }
          : {}),
      },
    };
    try {
      void Promise.resolve(options.onLog?.(entry)).catch(() => {});
    } catch {
      /* Diagnostics do not affect execution. */
    }
  };
  if (policy.fallback && !alternate)
    log(options.fallback ? "same_model_ignored" : "fallback_unavailable", "configuration");

  async function recover(
    error: unknown,
    exposed: boolean,
    stage: "model" | "tool_parameters",
    signal?: AbortSignal,
  ) {
    if (
      signal?.aborted ||
      options.signal?.aborted ||
      exposed ||
      (stage === "model" && !retryable(error))
    ) {
      log("stopped", exposed ? "partial_stream" : stage, error);
      return false;
    }
    if (remaining > 0) {
      remaining--;
      log(stage === "tool_parameters" ? "repair" : "retry", stage, error);
      // A brief bounded backoff is cancellable and remains inside the caller's deadline.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal?.removeEventListener("abort", abort);
          options.signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          clearTimeout(timer);
          cleanup();
          reject(signal?.reason ?? options.signal?.reason);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, 250);
        signal?.addEventListener("abort", abort, { once: true });
        options.signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted || options.signal?.aborted) abort();
      });
      return true;
    }
    if (!switched && alternate) {
      const failedSelection = current;
      current = alternate;
      switched = true;
      options.onSelectionChange?.(current);
      log("fallback", stage, error, failedSelection);
      return true;
    }
    log("budget_exhausted", stage, error);
    return false;
  }

  function callParams(params: CallOptions): CallOptions {
    currentSignal = params.abortSignal ?? options.signal;
    currentSignal?.throwIfAborted();
    options.signal?.throwIfAborted();
    requestNumber++;
    return {
      ...params,
      temperature: current.temperature,
      maxOutputTokens: current.maxTokens,
      providerOptions: current.providerOptions,
    };
  }
  function target(): Model {
    if (typeof current.model === "string" || current.model.specificationVersion !== "v3")
      throw new Error("Model recovery requires a v3 language model");
    return current.model;
  }
  const model: Model = {
    specificationVersion: "v3",
    get provider() {
      return typeof current.model === "string" ? current.providerId : current.model.provider;
    },
    get modelId() {
      return current.modelId;
    },
    // Both providers receive downloaded data, avoiding primary-only URL support assumptions.
    supportedUrls: {},
    async doGenerate(params) {
      while (true) {
        try {
          return await target().doGenerate(callParams(params));
        } catch (error) {
          if (!(await recover(error, false, "model", params.abortSignal))) throw error;
        }
      }
    },
    async doStream(params) {
      const streamAbort = new AbortController();
      const streamSignal = AbortSignal.any([
        streamAbort.signal,
        ...[params.abortSignal, options.signal].filter((signal): signal is AbortSignal => !!signal),
      ]);
      const streamParams = { ...params, abortSignal: streamSignal };
      const open = async (): Promise<StreamResult> => {
        while (true) {
          try {
            return await target().doStream(callParams(streamParams));
          } catch (error) {
            if (!(await recover(error, false, "model", streamSignal))) throw error;
          }
        }
      };
      let result = await open();
      let streamSelection = current;
      let reader = result.stream.getReader();
      let exposed = false;
      let cancelled = false;
      const pending: StreamPart[] = [];
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          while (!cancelled) {
            try {
              const next = await reader.read();
              if (next.done) {
                for (const part of pending.splice(0)) controller.enqueue(part);
                controller.close();
                return;
              }
              if (next.value.type === "error") throw next.value.error;
              if (
                !exposed &&
                ["stream-start", "response-metadata", "raw"].includes(next.value.type)
              ) {
                // Do not retain raw provider chunks or unbounded metadata before commitment.
                if (next.value.type !== "raw" && pending.length < 4) pending.push(next.value);
                continue;
              }
              if (next.value.type === "finish") streamSelections.push(streamSelection);
              exposed = true;
              for (const part of pending.splice(0)) controller.enqueue(part);
              controller.enqueue(next.value);
              return;
            } catch (error) {
              await reader.cancel(error).catch(() => {});
              if (cancelled) return;
              let terminalError = error;
              try {
                if (await recover(error, exposed, "model", streamSignal)) {
                  if (cancelled) return;
                  pending.length = 0;
                  result = await open();
                  streamSelection = current;
                  reader = result.stream.getReader();
                  continue;
                }
              } catch (recoveryError) {
                terminalError = recoveryError;
              }
              if (cancelled) return;
              // Preserve the SDK's error-part path: erroring the ReadableStream skips
              // streamText.onError and can hide the original failure after partial output.
              for (const part of pending.splice(0)) controller.enqueue(part);
              controller.enqueue({ type: "error", error: terminalError });
              controller.close();
              return;
            }
          }
        },
        async cancel(reason) {
          cancelled = true;
          streamAbort.abort(reason);
          await reader.cancel(reason);
        },
      });
      return { ...result, stream };
    },
  };

  const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({
    toolCall,
    tools,
    messages,
    system,
    error,
  }) => {
    let failure: unknown = error;
    const definitions = Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        name,
        { description: tool.description, inputSchema: tool.inputSchema },
      ]),
    );
    while (await recover(failure, false, "tool_parameters", currentSignal)) {
      const result = await generateText({
        model,
        tools: definitions,
        toolChoice: "required",
        maxRetries: 0,
        abortSignal: currentSignal,
        system,
        messages: [
          ...messages,
          {
            role: "user",
            content: `Repair this invalid tool call using an available tool and valid arguments. Produce only one tool call. No tool will execute during repair.\n${JSON.stringify({ name: toolCall.toolName, input: toolCall.input.slice(0, 16_384), error: error.message.slice(0, 1000) })}`,
          },
        ],
      });
      repairUsages.push({ selection: current, usage: result.totalUsage });
      const repaired = result.toolCalls[0];
      if (
        repaired &&
        result.toolCalls.length === 1 &&
        !("invalid" in repaired && repaired.invalid)
      ) {
        return { ...toolCall, toolName: repaired.toolName, input: JSON.stringify(repaired.input) };
      }
      failure =
        repaired && "error" in repaired
          ? repaired.error
          : new Error("Tool repair must return one valid tool call");
    }
    return null;
  };
  return { model, repairToolCall, selection: () => current, streamSelections, repairUsages };
}
