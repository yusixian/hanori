import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Database } from "@cos-tool-bot/database";
import { chatSummaries, conversationMessages, tokenUsage } from "@cos-tool-bot/database";
import type { AiConfigStored, SummaryMode, SummaryTrigger } from "@cos-tool-bot/shared";
import { generateText } from "ai";
import { and, between, desc, eq, inArray } from "drizzle-orm";
import { countTokens } from "gpt-tokenizer";
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

export const SUMMARY_INPUT_TOKEN_BUDGET = 24_000;
const SUMMARY_CHUNK_OUTPUT_TOKENS = 2_048;
const SUMMARY_MERGE_OUTPUT_TOKENS = 4_096;

type SummarySourceMessage = {
  userName: string | null;
  content: string;
  meta: unknown;
};

function truncateSummaryInput(content: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return "";
  if (countTokens(content) <= tokenBudget) return content;

  let low = 0;
  let high = content.length;
  let best = "";
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = `${content.slice(0, midpoint)}…`;
    if (countTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function chunkSummaryMessages(
  messages: SummarySourceMessage[],
  chatId: number,
  tokenBudget = SUMMARY_INPUT_TOKEN_BUDGET,
): string[] {
  const chunks: string[] = [];
  const separator = "\n";
  const separatorTokens = countTokens(separator);
  let current: string[] = [];
  let currentTokens = 0;
  for (const message of messages) {
    const formatted = truncateSummaryInput(formatMessages([message], chatId), tokenBudget);
    const messageTokens = countTokens(formatted);
    const candidateTokens =
      currentTokens + (current.length > 0 ? separatorTokens : 0) + messageTokens;
    if (current.length > 0 && candidateTokens > tokenBudget) {
      chunks.push(current.join(separator));
      current = [];
      currentTokens = 0;
    }
    if (current.length > 0) currentTokens += separatorTokens;
    current.push(formatted);
    currentTokens += messageTokens;
  }
  if (current.length > 0) chunks.push(current.join(separator));
  return chunks;
}

export function newestRowsToChronological<T>(rows: T[]): T[] {
  return [...rows].reverse();
}

function chunkSummaryFragments(
  fragments: string[],
  tokenBudget = SUMMARY_INPUT_TOKEN_BUDGET,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const fragment of fragments) {
    const candidate = [...current, fragment];
    const content = candidate.map((item, index) => `[分块 ${index + 1}]\n${item}`).join("\n\n");
    if (current.length > 0 && countTokens(content) > tokenBudget) {
      chunks.push(current);
      current = [fragment];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function summarizeBoundedChunks(
  chunks: string[],
  systemPrompt: string,
  callModel: (systemPrompt: string, content: string, maxOutputTokens: number) => Promise<string>,
): Promise<string> {
  if (chunks.length === 1) {
    return callModel(systemPrompt, chunks[0]!, SUMMARY_MERGE_OUTPUT_TOKENS);
  }

  let summaries: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    summaries.push(
      await callModel(
        [
          systemPrompt,
          "",
          `这是完整时间窗口的第 ${index + 1}/${chunks.length} 个连续分块。请完整提取该分块的主题、决定、待办、未解决事项与必要链接，供后续归并；不要假装已经看过其他分块。`,
        ].join("\n"),
        chunk,
        SUMMARY_CHUNK_OUTPUT_TOKENS,
      ),
    );
  }

  let mergeLevel = 0;
  while (summaries.length > 1) {
    mergeLevel++;
    const groups = chunkSummaryFragments(summaries);
    const next: string[] = [];
    for (const group of groups) {
      const content = group
        .map((fragment, index) => `[分块摘要 ${index + 1}]\n${fragment}`)
        .join("\n\n");
      next.push(
        await callModel(
          [
            systemPrompt,
            "",
            `请归并这些分块摘要（归并层级 ${mergeLevel}），去重但不要遗漏主题、决定、待办、未解决事项和链接。只根据给定摘要作答。`,
          ].join("\n"),
          content,
          SUMMARY_MERGE_OUTPUT_TOKENS,
        ),
      );
    }
    summaries = next;
  }
  return summaries[0]!;
}

export type ProviderResolutionFailure =
  | "no_providers_configured"
  | "override_not_found"
  | "no_api_key"
  | "decrypt_failed";

interface ResolvedProvider {
  id: string;
  label: string;
  apiKey: string;
  baseURL: string;
  providerFormat: "openai" | "gemini";
  defaultModel: string;
}

export type ResolveProviderResult =
  | { ok: true; provider: ResolvedProvider }
  | { ok: false; reason: ProviderResolutionFailure; providerId?: string };

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
      this.logger.info(
        {
          botId: opts.botId,
          chatId: opts.chatId,
          reason: !cfg ? "ai_config_missing" : "summary_disabled",
        },
        "Summary run rejected: disabled",
      );
      return { ok: false, error: "disabled", messageCount: 0 };
    }

    const { windowStart, windowEnd, limit } = this.resolveWindow(opts, cfg);
    const roleFilter = cfg.summaryConfig?.roleFilter ?? [...DEFAULT_ROLE_FILTER];

    const providerResolution = this.resolveProvider(cfg, opts.configOverrides?.providerId ?? null);
    const provider = providerResolution.ok ? providerResolution.provider : null;
    const modelId = this.pickModelId(opts, cfg, provider?.defaultModel ?? "");

    this.logger.info(
      {
        botId: opts.botId,
        chatId: opts.chatId,
        trigger: opts.trigger,
        mode: opts.mode,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        limit,
        roleFilter,
        overrideProviderId: opts.configOverrides?.providerId ?? null,
        overrideModelId: opts.configOverrides?.modelId ?? null,
        resolvedProviderId: provider?.id ?? null,
        resolvedProviderLabel: provider?.label ?? null,
        resolvedModelId: modelId || null,
        providerResolution: providerResolution.ok
          ? { ok: true }
          : {
              ok: false,
              reason: providerResolution.reason,
              providerId: providerResolution.providerId ?? null,
            },
      },
      "Summary run starting",
    );

    if (!providerResolution.ok) {
      this.logger.warn(
        {
          botId: opts.botId,
          chatId: opts.chatId,
          reason: providerResolution.reason,
          providerId: providerResolution.providerId ?? null,
          knownProviderIds: cfg.providers?.map((p) => p.id) ?? [],
          activeProviderId: cfg.activeProviderId ?? null,
        },
        "Summary provider resolution failed",
      );
    }

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
      const reasonDetail = providerResolution.ok ? "unknown" : providerResolution.reason;
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId: "unknown",
        content: "",
        errorMessage: `no_provider:${reasonDetail}`,
        durationMs: 0,
      });
      return { ok: false, error: "no_provider", messageCount: msgs.length, summaryId: sumRow.id };
    }
    const systemPrompt =
      opts.configOverrides?.customPrompt ??
      cfg.summaryConfig?.systemPrompt ??
      DEFAULT_SUMMARY_SYSTEM_PROMPT;

    const chunks = chunkSummaryMessages(
      msgs.map((message) => ({
        userName: message.userName,
        content: message.content,
        meta: message.meta,
      })),
      opts.chatId,
    );
    const startedAt = Date.now();
    const aggregateUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    try {
      const modelFactory =
        provider.providerFormat === "gemini"
          ? createGoogleGenerativeAI({ baseURL: provider.baseURL, apiKey: provider.apiKey })
          : createOpenAICompatible({
              name: "custom",
              baseURL: provider.baseURL,
              apiKey: provider.apiKey,
            });

      const callModel = async (
        callSystemPrompt: string,
        content: string,
        maxOutputTokens: number,
      ) => {
        const result = await generateText({
          model: modelFactory(modelId),
          temperature: 0.4,
          maxOutputTokens,
          messages: [
            { role: "system", content: callSystemPrompt },
            { role: "user", content },
          ],
        });
        aggregateUsage.inputTokens += result.usage?.inputTokens ?? 0;
        aggregateUsage.outputTokens += result.usage?.outputTokens ?? 0;
        aggregateUsage.totalTokens +=
          result.usage?.totalTokens ??
          (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
        const text = result.text?.trim() ?? "";
        if (!text) throw new Error("empty_response");
        return text;
      };

      const raw = await summarizeBoundedChunks(chunks, systemPrompt, callModel);

      const durationMs = Date.now() - startedAt;

      const contentHtml = wrapSummaryHtml(raw);
      const sumRow = await this.writeHistory({
        opts,
        windowStart,
        windowEnd,
        messageCount: msgs.length,
        modelId,
        content: raw,
        durationMs,
        promptTokens: aggregateUsage.inputTokens,
        completionTokens: aggregateUsage.outputTokens,
      });
      await this.writeTokenUsage(opts, modelId, aggregateUsage, durationMs);

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
        promptTokens: aggregateUsage.inputTokens,
        completionTokens: aggregateUsage.outputTokens,
      });
      if (aggregateUsage.totalTokens > 0) {
        await this.writeTokenUsage(opts, modelId, aggregateUsage, durationMs);
      }
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
  ): ResolveProviderResult {
    if (!cfg.providers || cfg.providers.length === 0) {
      return { ok: false, reason: "no_providers_configured" };
    }
    const picked = overrideProviderId
      ? cfg.providers.find((p) => p.id === overrideProviderId)
      : undefined;
    // Fail closed on stale override id so the user notices instead of silently using main provider.
    if (overrideProviderId && !picked) {
      return { ok: false, reason: "override_not_found", providerId: overrideProviderId };
    }
    const active =
      picked ?? cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? cfg.providers[0]!;
    if (!active.encryptedApiKey) {
      return { ok: false, reason: "no_api_key", providerId: active.id };
    }
    const apiKey = tryDecrypt(active.encryptedApiKey, this.encryptionKey);
    if (!apiKey) {
      return { ok: false, reason: "decrypt_failed", providerId: active.id };
    }
    return {
      ok: true,
      provider: {
        id: active.id,
        label: active.label,
        apiKey,
        baseURL: active.baseURL,
        providerFormat: active.providerFormat,
        defaultModel: active.defaultModel,
      },
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
    const rows = await this.db
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
      .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
      .limit(limit);
    return newestRowsToChronological(rows);
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
