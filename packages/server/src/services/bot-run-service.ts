import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createModelFetch, createUsageAwareOpenAICompatible } from "@cos-tool-bot/bot";
import type { Database } from "@cos-tool-bot/database";
import { botRunEvents, botRuns, bots } from "@cos-tool-bot/database";
import type { ModelEntry } from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { JSONValue } from "ai";
import { streamText } from "ai";
import type { Logger } from "pino";
import { tryDecrypt } from "../utils/crypto.js";
import { getActiveProvider, migrateAiConfig } from "../utils/ai-config-migrate.js";
import { classifyProviderError, redactDiagnostic } from "./run-redaction.js";

export interface StartBotRunInput {
  text?: string;
  channelEvent?: Record<string, unknown>;
  channel?: string;
  replayOf?: string;
}

export type BotRunStatus = "running" | "succeeded" | "failed";

function buildProviderOptions(
  entry: ModelEntry | undefined,
  providerFormat: "openai" | "gemini",
): Record<string, Record<string, JSONValue>> | undefined {
  if (!entry?.thinking) return undefined;
  const enabled = entry.thinking === "enabled";
  if (providerFormat === "gemini") {
    return {
      google: {
        thinkingConfig: {
          thinkingBudget: enabled ? (entry.thinkingBudget ?? -1) : 0,
          includeThoughts: enabled,
        },
      },
    };
  }
  const thinking: Record<string, JSONValue> = { type: entry.thinking };
  if (entry.thinkingBudget != null) thinking["budget_tokens"] = entry.thinkingBudget;
  return { custom: { thinking } };
}

function isProviderOutputPart(type: unknown): boolean {
  return (
    typeof type === "string" &&
    [
      "text-start",
      "text-delta",
      "reasoning-start",
      "reasoning-delta",
      "source",
      "file",
      "tool-input-start",
      "tool-input-delta",
      "tool-call",
    ].includes(type)
  );
}

function textFromChannelEvent(event: Record<string, unknown>): string {
  const message = event["message"] as Record<string, unknown> | undefined;
  if (typeof message?.["text"] === "string") return message["text"];
  const eventBody = event["event"] as Record<string, unknown> | undefined;
  const larkMessage = eventBody?.["message"] as Record<string, unknown> | undefined;
  const content = larkMessage?.["content"];
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as { text?: unknown };
      if (typeof parsed.text === "string") return parsed.text;
    } catch {}
  }
  throw new Error("Channel event does not contain a supported text message");
}

export class BotRunService {
  private activeRuns = new Map<string, AbortController>();
  private initialization: Promise<void>;

  constructor(
    private db: Database,
    private encryptionKey: string,
    private stream: typeof streamText = streamText,
    private logger: Pick<Logger, "error"> = console,
  ) {
    this.initialization = this.reconcileInterruptedRuns();
    void this.initialization.catch(() => {});
  }

  async list(botId: string, limit = 50) {
    await this.initialization;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50;
    return this.db
      .select()
      .from(botRuns)
      .where(eq(botRuns.botId, botId))
      .orderBy(desc(botRuns.createdAt))
      .limit(safeLimit);
  }

  async get(botId: string, runId: string) {
    await this.initialization;
    const [run] = await this.db
      .select()
      .from(botRuns)
      .where(and(eq(botRuns.id, runId), eq(botRuns.botId, botId)));
    if (!run) return null;
    const events = await this.db
      .select()
      .from(botRunEvents)
      .where(eq(botRunEvents.runId, runId))
      .orderBy(asc(botRunEvents.sequence));
    return { ...run, events };
  }

  async getStatus(botId: string, runId: string): Promise<BotRunStatus | undefined> {
    await this.initialization;
    const [run] = await this.db
      .select({ status: botRuns.status })
      .from(botRuns)
      .where(and(eq(botRuns.id, runId), eq(botRuns.botId, botId)));
    return run?.status as BotRunStatus | undefined;
  }

  async eventsAfter(runId: string, sequence: number) {
    await this.initialization;
    return this.db
      .select()
      .from(botRunEvents)
      .where(and(eq(botRunEvents.runId, runId), gt(botRunEvents.sequence, sequence)))
      .orderBy(asc(botRunEvents.sequence));
  }

  async pin(botId: string, runId: string, pinned: boolean) {
    await this.initialization;
    const [run] = await this.db
      .update(botRuns)
      .set({ pinned })
      .where(and(eq(botRuns.id, runId), eq(botRuns.botId, botId)))
      .returning();
    return run ?? null;
  }

  async cancel(botId: string, runId: string) {
    const status = await this.getStatus(botId, runId);
    if (status !== "running") return false;
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort(new Error("Cancelled by operator"));
    } else {
      const [cancelled] = await this.db
        .update(botRuns)
        .set({ status: "failed", failureReason: "cancelled", completedAt: new Date() })
        .where(and(eq(botRuns.id, runId), eq(botRuns.botId, botId), eq(botRuns.status, "running")))
        .returning({ id: botRuns.id });
      return Boolean(cancelled);
    }
    return true;
  }

  async start(botId: string, input: StartBotRunInput) {
    await this.initialization;
    const [bot] = await this.db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error("Bot not found");
    const text =
      input.text?.trim() || (input.channelEvent ? textFromChannelEvent(input.channelEvent) : "");
    if (!text) throw new Error("A message or supported Channel event is required");
    const config = bot.aiConfig ? migrateAiConfig(bot.aiConfig) : null;
    const provider = config ? getActiveProvider(config) : null;
    const secrets: string[] = [];
    const apiKey = provider?.encryptedApiKey
      ? tryDecrypt(provider.encryptedApiKey, this.encryptionKey)
      : null;
    if (apiKey) secrets.push(apiKey);
    const channel = input.channel ?? bot.platform ?? "telegram";
    const safeInput = redactDiagnostic({ ...input, text }, secrets) as Record<string, unknown>;
    const snapshot = redactDiagnostic(
      config
        ? {
            activeProviderId: config.activeProviderId,
            model: provider?.defaultModel,
            baseURL: provider?.baseURL,
            providerFormat: provider?.providerFormat,
            systemPrompt: config.systemPrompt,
            behavioralPrompt: config.behavioralPrompt,
          }
        : {},
      secrets,
    ) as Record<string, unknown>;
    const [run] = await this.db
      .insert(botRuns)
      .values({
        botId,
        source: input.replayOf ? "replay" : input.channelEvent ? "channel-event" : "debugger",
        channel,
        mode: "dry-run",
        input: safeInput,
        configSnapshot: snapshot,
      })
      .returning();
    if (!run) throw new Error("Failed to create Bot Run");
    void this.execute(run.id, text, config, provider, apiKey, secrets).catch((error: unknown) => {
      try {
        this.logger.error(
          redactDiagnostic({ runId: run.id, error }, secrets),
          "Bot Run background execution failed",
        );
      } catch {
        // A diagnostic sink failure must not recreate an unhandled background rejection.
      }
    });
    return run;
  }

  private async execute(
    runId: string,
    text: string,
    config: ReturnType<typeof migrateAiConfig> | null,
    provider: ReturnType<typeof getActiveProvider> | null,
    apiKey: string | null,
    secrets: string[],
  ) {
    let sequence = 0;
    const startedAt = Date.now();
    let streamStarted = false;
    let streamFailureReason: ReturnType<typeof classifyProviderError> | null = null;
    const abortController = new AbortController();
    let abortSignal: AbortSignal = abortController.signal;
    this.activeRuns.set(runId, abortController);
    const emit = async (kind: string, data: unknown, level = "info") => {
      sequence += 1;
      await this.db.insert(botRunEvents).values({
        runId,
        sequence,
        kind,
        level,
        data: redactDiagnostic(data, secrets) as Record<string, unknown>,
      });
    };
    try {
      const timeoutSignal = AbortSignal.timeout(
        config?.timeoutConfig?.aiReplyMs ?? DEFAULT_TIMEOUT_CONFIG.aiReplyMs,
      );
      abortSignal = AbortSignal.any([abortController.signal, timeoutSignal]);
      await emit("run-started", { mode: "dry-run" });
      if (!config?.enabled || !provider || !apiKey) {
        throw new Error("Bot AI provider is not configured or enabled");
      }
      await emit("ai-request", {
        model: provider.defaultModel,
        providerFormat: provider.providerFormat,
        baseURL: provider.baseURL,
        messages: [
          { role: "system", content: this.systemPrompt(config) },
          { role: "user", content: text },
        ],
      });
      const factory =
        provider.providerFormat === "gemini"
          ? createGoogleGenerativeAI({
              baseURL: provider.baseURL,
              apiKey,
              fetch: createModelFetch(),
            })
          : createUsageAwareOpenAICompatible({
              name: "custom",
              baseURL: provider.baseURL,
              apiKey,
            });
      const modelEntry = (provider.models ?? config.models)?.find(
        (entry) => entry.id === provider.defaultModel,
      );
      const result = this.stream({
        model: factory(provider.defaultModel),
        messages: [
          { role: "system", content: this.systemPrompt(config) },
          { role: "user", content: text },
        ],
        abortSignal,
        temperature: modelEntry?.temperature,
        maxOutputTokens: modelEntry?.maxTokens,
        providerOptions: buildProviderOptions(modelEntry, provider.providerFormat),
      });
      for await (const part of result.fullStream) {
        const record = part as unknown as Record<string, unknown>;
        const type = record["type"];
        if (isProviderOutputPart(type)) streamStarted = true;
        if (type === "error") {
          streamFailureReason ??= classifyProviderError(
            record["error"] ?? new Error("Provider stream failed"),
            streamStarted,
          );
        } else if (type === "abort") {
          streamFailureReason ??= classifyProviderError(
            abortSignal.reason ?? new DOMException("Aborted", "AbortError"),
            streamStarted,
          );
        }
        await emit(
          `ai-${String(type ?? "event")}`,
          record,
          type === "error" || type === "abort" ? "error" : "debug",
        );
      }
      const output = (await result.text).trim();
      const finishReason = await result.finishReason;
      const usage = await result.usage;
      if (streamFailureReason) {
        await this.finish(runId, "failed", streamFailureReason, startedAt);
      } else if (!output) {
        await emit(
          "ai-error",
          { message: "Provider completed without output", finishReason },
          "error",
        );
        await this.finish(runId, "failed", "provider_empty_output", startedAt);
      } else {
        await emit("ai-response", { text: output, finishReason, usage });
        await this.finish(runId, "succeeded", null, startedAt);
      }
    } catch (error) {
      const reason = streamFailureReason ?? classifyProviderError(error, streamStarted);
      await emit("run-error", { error, failureReason: reason }, "error");
      await this.finish(runId, "failed", reason, startedAt);
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async finish(
    runId: string,
    status: string,
    failureReason: string | null,
    startedAt: number,
  ) {
    await this.db
      .update(botRuns)
      .set({
        status,
        failureReason,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
      })
      .where(eq(botRuns.id, runId));
  }

  private async reconcileInterruptedRuns() {
    await this.db
      .update(botRuns)
      .set({ status: "failed", failureReason: "interrupted", completedAt: new Date() })
      .where(eq(botRuns.status, "running"));
  }

  private systemPrompt(config: ReturnType<typeof migrateAiConfig>) {
    return [config.systemPrompt, config.behavioralPrompt].filter(Boolean).join("\n\n");
  }
}
