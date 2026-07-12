import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Database } from "@cos-tool-bot/database";
import { botRunEvents, botRuns, bots } from "@cos-tool-bot/database";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { streamText } from "ai";
import { tryDecrypt } from "../utils/crypto.js";
import { getActiveProvider, migrateAiConfig } from "../utils/ai-config-migrate.js";
import { classifyProviderError, redactDiagnostic } from "./run-redaction.js";

export interface StartBotRunInput {
  text?: string;
  channelEvent?: Record<string, unknown>;
  channel?: string;
  replayOf?: string;
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
  constructor(
    private db: Database,
    private encryptionKey: string,
    private stream: typeof streamText = streamText,
  ) {}

  async list(botId: string, limit = 50) {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50;
    return this.db
      .select()
      .from(botRuns)
      .where(eq(botRuns.botId, botId))
      .orderBy(desc(botRuns.createdAt))
      .limit(safeLimit);
  }

  async get(botId: string, runId: string) {
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

  eventsAfter(runId: string, sequence: number) {
    return this.db
      .select()
      .from(botRunEvents)
      .where(and(eq(botRunEvents.runId, runId), gt(botRunEvents.sequence, sequence)))
      .orderBy(asc(botRunEvents.sequence));
  }

  async pin(botId: string, runId: string, pinned: boolean) {
    const [run] = await this.db
      .update(botRuns)
      .set({ pinned })
      .where(and(eq(botRuns.id, runId), eq(botRuns.botId, botId)))
      .returning();
    return run ?? null;
  }

  async cancel(botId: string, runId: string) {
    const run = await this.get(botId, runId);
    if (!run || run.status !== "running") return false;
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort(new Error("Cancelled by operator"));
    } else {
      await this.db
        .update(botRuns)
        .set({ status: "failed", failureReason: "cancelled", completedAt: new Date() })
        .where(and(eq(botRuns.id, runId), eq(botRuns.botId, botId)));
    }
    return true;
  }

  async start(botId: string, input: StartBotRunInput) {
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
        source: input.channelEvent ? "channel-event" : input.replayOf ? "replay" : "debugger",
        channel,
        mode: "dry-run",
        input: safeInput,
        configSnapshot: snapshot,
      })
      .returning();
    if (!run) throw new Error("Failed to create Bot Run");
    void this.execute(run.id, text, config, provider, apiKey, secrets);
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
    let streamError = false;
    const abortController = new AbortController();
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
          ? createGoogleGenerativeAI({ baseURL: provider.baseURL, apiKey })
          : createOpenAICompatible({ name: "debugger", baseURL: provider.baseURL, apiKey });
      const result = this.stream({
        model: factory(provider.defaultModel),
        messages: [
          { role: "system", content: this.systemPrompt(config) },
          { role: "user", content: text },
        ],
        abortSignal: abortController.signal,
      });
      for await (const part of result.fullStream) {
        streamStarted = true;
        const record = part as unknown as Record<string, unknown>;
        if (record["type"] === "error") streamError = true;
        await emit(
          `ai-${String(record["type"] ?? "event")}`,
          record,
          streamError ? "error" : "debug",
        );
      }
      const output = (await result.text).trim();
      const finishReason = await result.finishReason;
      const usage = await result.usage;
      if (streamError) {
        await this.finish(runId, "failed", "provider_stream_failed", startedAt);
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
      const reason = classifyProviderError(error, streamStarted);
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

  private systemPrompt(config: ReturnType<typeof migrateAiConfig>) {
    return [config.systemPrompt, config.behavioralPrompt].filter(Boolean).join("\n\n");
  }
}
