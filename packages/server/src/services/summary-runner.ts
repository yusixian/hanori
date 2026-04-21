import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Database } from "@cos-tool-bot/database";
import { chatSummaries, conversationMessages, tokenUsage } from "@cos-tool-bot/database";
import type { AiConfigStored, SummaryMode, SummaryTrigger } from "@cos-tool-bot/shared";
import { generateText } from "ai";
import { and, asc, between, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { tryDecrypt } from "../utils/crypto.js";
import {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_ROLE_FILTER,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_TIMEZONE,
  DEFAULT_WINDOW_HOURS,
  MAX_COUNT,
  MAX_HOURS,
  MIN_MESSAGES_FOR_SUMMARY,
  formatMessages,
  wrapSummaryHtml,
} from "./summary-prompts.js";

export type RunError = "too_few_messages" | "llm_failed" | "disabled" | "no_provider";

export interface RunOptions {
  botId: string;
  chatId: number;
  mode: SummaryMode;
  trigger: SummaryTrigger;
  triggeredBy?: number;
  configOverrides?: {
    customPrompt?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    maxMessages?: number | null;
  };
}

export interface RunResult {
  ok: boolean;
  summaryId?: number;
  contentHtml?: string;
  contentRaw?: string;
  messageCount: number;
  error?: RunError;
  errorDetail?: string;
}

export class SummaryRunner {
  constructor(
    private db: Database,
    private logger: Logger,
    private encryptionKey: string,
    private getAiConfig: (botId: string) => Promise<AiConfigStored | null>,
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const cfg = await this.getAiConfig(opts.botId);
    if (!cfg || cfg.summaryConfig?.enabled === false) {
      return { ok: false, error: "disabled", messageCount: 0 };
    }

    const { windowStart, windowEnd, limit } = this.resolveWindow(opts, cfg);
    const roleFilter = cfg.summaryConfig?.roleFilter ?? [...DEFAULT_ROLE_FILTER];

    const provider = this.resolveProvider(cfg, opts.configOverrides?.providerId ?? null);
    const modelId = this.pickModelId(opts, cfg, provider?.defaultModel ?? "");

    const msgs = await this.fetchMessages(
      opts.botId,
      opts.chatId,
      windowStart,
      windowEnd,
      limit,
      roleFilter,
    );

    if (msgs.length < MIN_MESSAGES_FOR_SUMMARY) {
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId: modelId || "unknown",
        content: "",
        errorMessage: "too_few_messages",
        durationMs: 0,
      });
      return {
        ok: false,
        error: "too_few_messages",
        messageCount: msgs.length,
        summaryId: sumRow.id,
      };
    }

    if (!provider) {
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId: "unknown",
        content: "",
        errorMessage: "no_provider",
        durationMs: 0,
      });
      return { ok: false, error: "no_provider", messageCount: msgs.length, summaryId: sumRow.id };
    }
    const systemPrompt =
      opts.configOverrides?.customPrompt ??
      cfg.summaryConfig?.systemPrompt ??
      DEFAULT_SUMMARY_SYSTEM_PROMPT;

    const formatted = formatMessages(
      msgs.map((m) => ({ userName: m.userName, content: m.content, meta: m.meta })),
      opts.chatId,
    );

    const startedAt = Date.now();
    try {
      const modelFactory =
        provider.providerFormat === "gemini"
          ? createGoogleGenerativeAI({ baseURL: provider.baseURL, apiKey: provider.apiKey })
          : createOpenAICompatible({
              name: "custom",
              baseURL: provider.baseURL,
              apiKey: provider.apiKey,
            });
      const result = await generateText({
        model: modelFactory(modelId),
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: formatted },
        ],
      });
      const raw = result.text ?? "";
      const durationMs = Date.now() - startedAt;
      const usage = result.usage;

      if (!raw.trim()) {
        const sumRow = await this.writeHistory({
          opts,
          windowStart,
          windowEnd,
          messageCount: msgs.length,
          modelId,
          content: "",
          errorMessage: "empty_response",
          durationMs,
          promptTokens: usage?.inputTokens,
          completionTokens: usage?.outputTokens,
        });
        return {
          ok: false,
          error: "llm_failed",
          errorDetail: "empty_response",
          messageCount: msgs.length,
          summaryId: sumRow.id,
        };
      }

      const contentHtml = wrapSummaryHtml(raw);
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId,
        content: raw,
        durationMs,
        promptTokens: usage?.inputTokens,
        completionTokens: usage?.outputTokens,
      });
      await this.writeTokenUsage(opts, modelId, usage, durationMs);

      return {
        ok: true,
        summaryId: sumRow.id,
        contentHtml,
        contentRaw: raw,
        messageCount: msgs.length,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err, botId: opts.botId, chatId: opts.chatId }, "Summary LLM call failed");
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId,
        content: "",
        errorMessage: detail.slice(0, 500),
        durationMs,
      });
      return {
        ok: false,
        error: "llm_failed",
        errorDetail: detail,
        messageCount: msgs.length,
        summaryId: sumRow.id,
      };
    }
  }

  private pickModelId(opts: RunOptions, cfg: AiConfigStored, providerDefaultModel: string): string {
    const override = opts.configOverrides?.modelId;
    if (override) return override;
    // Per-chat providerId override: prefer that provider's defaultModel so model/provider stay paired.
    if (opts.configOverrides?.providerId) return providerDefaultModel;
    const summaryModel = cfg.summaryConfig?.modelId;
    if (summaryModel) return summaryModel;
    return providerDefaultModel || cfg.model;
  }

  private resolveProvider(
    cfg: AiConfigStored,
    overrideProviderId: string | null,
  ): {
    apiKey: string;
    baseURL: string;
    providerFormat: "openai" | "gemini";
    defaultModel: string;
  } | null {
    const picked = overrideProviderId
      ? cfg.providers?.find((p) => p.id === overrideProviderId)
      : undefined;
    // Fail closed on stale override id so the user notices instead of silently using main provider.
    if (overrideProviderId && !picked) return null;
    const active =
      picked ?? cfg.providers?.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers?.[0];
    if (!active?.encryptedApiKey) return null;
    const apiKey = tryDecrypt(active.encryptedApiKey, this.encryptionKey);
    if (!apiKey) return null;
    return {
      apiKey,
      baseURL: active.baseURL,
      providerFormat: active.providerFormat,
      defaultModel: active.defaultModel,
    };
  }

  private resolveWindow(
    opts: RunOptions,
    cfg: AiConfigStored,
  ): { windowStart: Date; windowEnd: Date; limit: number } {
    const limit = Math.min(
      opts.configOverrides?.maxMessages ??
        cfg.summaryConfig?.defaultMaxMessages ??
        DEFAULT_MAX_MESSAGES,
      MAX_COUNT,
    );
    const now = new Date();
    const defaultHours = cfg.summaryConfig?.defaultWindowHours ?? DEFAULT_WINDOW_HOURS;
    const tz = cfg.summaryConfig?.timezone ?? DEFAULT_TIMEZONE;

    switch (opts.mode.kind) {
      case "default":
        return {
          windowStart: new Date(now.getTime() - defaultHours * 3600_000),
          windowEnd: now,
          limit,
        };
      case "hours": {
        const h = Math.min(opts.mode.hours, MAX_HOURS);
        return {
          windowStart: new Date(now.getTime() - h * 3600_000),
          windowEnd: now,
          limit,
        };
      }
      case "recent":
        return {
          windowStart: new Date(now.getTime() - MAX_HOURS * 3600_000),
          windowEnd: now,
          limit: Math.min(opts.mode.count, limit),
        };
      case "date": {
        const target = opts.mode.day === "today" ? 0 : -1;
        const { start, end } = dayRangeInTz(now, target, tz);
        return { windowStart: start, windowEnd: end, limit };
      }
    }
  }

  private async fetchMessages(
    botId: string,
    chatId: number,
    windowStart: Date,
    windowEnd: Date,
    limit: number,
    roleFilter: readonly string[],
  ) {
    return this.db
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
        userName: conversationMessages.userName,
        meta: conversationMessages.meta,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.chatId, chatId),
          inArray(conversationMessages.role, [...roleFilter]),
          between(conversationMessages.createdAt, windowStart, windowEnd),
        ),
      )
      .orderBy(asc(conversationMessages.id))
      .limit(limit);
  }

  private async writeHistory(params: {
    opts: RunOptions;
    windowStart: Date;
    windowEnd: Date;
    messageCount: number;
    modelId: string;
    content: string;
    errorMessage?: string;
    durationMs: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
  }) {
    const [row] = await this.db
      .insert(chatSummaries)
      .values({
        botId: params.opts.botId,
        chatId: params.opts.chatId,
        trigger: params.opts.trigger,
        triggeredBy: params.opts.triggeredBy ?? null,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        messageCount: params.messageCount,
        modelId: params.modelId,
        content: params.content,
        errorMessage: params.errorMessage ?? null,
        durationMs: params.durationMs,
        promptTokens: params.promptTokens ?? null,
        completionTokens: params.completionTokens ?? null,
      })
      .returning({ id: chatSummaries.id });
    return row!;
  }

  private async writeTokenUsage(
    opts: RunOptions,
    modelId: string,
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
    durationMs: number,
  ) {
    if (!usage) return;
    await this.db.insert(tokenUsage).values({
      botId: opts.botId,
      chatId: opts.chatId,
      userId: opts.triggeredBy ?? null,
      model: modelId,
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      durationMs,
      trigger: "summary",
    });
  }
}

function dayRangeInTz(now: Date, offsetDays: number, tz: string): { start: Date; end: Date } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const local = new Date(now.getTime() + offsetDays * 86400_000);
  const parts = fmt.formatToParts(local);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const startIso = `${y}-${m}-${d}T00:00:00`;
  const endIso = `${y}-${m}-${d}T23:59:59.999`;
  return {
    start: zonedToUtc(startIso, tz),
    end: zonedToUtc(endIso, tz),
  };
}

function zonedToUtc(isoLocal: string, tz: string): Date {
  const naive = new Date(isoLocal + "Z");
  const probe = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = probe.formatToParts(naive).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asTz = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = asTz - naive.getTime();
  return new Date(naive.getTime() - offsetMs);
}
