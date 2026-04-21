import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ImageOcrConfig, TokenUsageRecord } from "@cos-tool-bot/shared";
import {
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_OCR_COOLDOWN_SECONDS,
  DEFAULT_OCR_MAX_DESCRIPTION_LENGTH,
  DEFAULT_OCR_PROMPT,
  DEFAULT_OCR_TIMEOUT_MS,
} from "@cos-tool-bot/shared";
import { generateText } from "ai";
import type { AiProviderRuntime } from "../handlers/ai-reply.js";

export interface OcrLogger {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface OcrImageInput {
  buffer: Buffer;
  mimeType: string;
}

export type OcrSkipReason =
  | "disabled"
  | "cooldown"
  | "over_limit"
  | "no_provider"
  | "error"
  | "empty_response";

export interface OcrResult {
  description: string | null;
  skipReason?: OcrSkipReason;
  errorDetail?: string;
}

export interface DescribeImagesOptions {
  botId: string;
  chatId: number;
  userId?: number;
  images: OcrImageInput[];
  config: ImageOcrConfig;
  providers: AiProviderRuntime[] | undefined;
  activeProviderId: string | undefined;
  logger: OcrLogger;
  onTokenUsage?: (entry: TokenUsageRecord) => void | Promise<void>;
}

const cooldownMap = new Map<string, number>();
const COOLDOWN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let cooldownSweeperStarted = false;

function ensureCooldownSweeper() {
  if (cooldownSweeperStarted) return;
  cooldownSweeperStarted = true;
  const interval = setInterval(() => {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [key, ts] of cooldownMap) {
      if (ts < cutoff) cooldownMap.delete(key);
    }
  }, COOLDOWN_SWEEP_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();
}

function resolveProvider(
  providers: AiProviderRuntime[] | undefined,
  activeProviderId: string | undefined,
  overrideId: string | undefined,
): AiProviderRuntime | null {
  if (!providers || providers.length === 0) return null;
  if (overrideId) {
    const picked = providers.find((p) => p.id === overrideId);
    if (picked) return picked;
  }
  return providers.find((p) => p.id === activeProviderId) ?? providers[0] ?? null;
}

function truncateDescription(text: string, maxLen: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + "…";
}

// Extract diagnostic fields from ai SDK errors (AI_APICallError / AI_RetryError / AbortError).
// Returns a plain object safe for JSON logging.
function extractErrorDetail(err: unknown): Record<string, unknown> {
  if (err == null) return { raw: String(err) };
  if (typeof err !== "object") return { raw: String(err) };
  const anyErr = err as Record<string, unknown> & { cause?: unknown };
  const out: Record<string, unknown> = {};
  if (err instanceof Error) {
    out.name = err.name;
    out.message = err.message;
    if (err.stack) out.stack = err.stack.split("\n").slice(0, 5).join("\n");
  }
  // Common AI SDK fields
  for (const k of [
    "statusCode",
    "url",
    "responseBody",
    "responseHeaders",
    "data",
    "isRetryable",
    "reason",
  ]) {
    if (k in anyErr && anyErr[k] !== undefined) {
      const v = anyErr[k];
      // Truncate huge response bodies
      if (typeof v === "string" && v.length > 2000) {
        out[k] = v.slice(0, 2000) + `…(+${v.length - 2000} chars)`;
      } else {
        out[k] = v;
      }
    }
  }
  if (anyErr.cause) {
    out.cause = extractErrorDetail(anyErr.cause);
  }
  // Fallback: if nothing captured, dump JSON
  if (Object.keys(out).length === 0) {
    try {
      out.json = JSON.parse(JSON.stringify(err));
    } catch {
      out.raw = String(err);
    }
  }
  return out;
}

export async function describeImages(opts: DescribeImagesOptions): Promise<OcrResult[]> {
  const {
    botId,
    chatId,
    userId,
    images,
    config,
    providers,
    activeProviderId,
    logger,
    onTokenUsage,
  } = opts;
  if (!config.enabled || images.length === 0) {
    return images.map(() => ({ description: null, skipReason: "disabled" as const }));
  }

  ensureCooldownSweeper();

  const cooldownKey = `${botId}:${chatId}`;
  const cooldownSeconds = config.cooldownSeconds ?? DEFAULT_OCR_COOLDOWN_SECONDS;
  const now = Date.now();
  const lastTs = cooldownMap.get(cooldownKey) ?? 0;
  if (cooldownSeconds > 0 && now - lastTs < cooldownSeconds * 1000) {
    logger.info(
      { botId, chatId, cooldownSeconds, waitMs: cooldownSeconds * 1000 - (now - lastTs) },
      "Image OCR skipped by cooldown",
    );
    return images.map(() => ({ description: null, skipReason: "cooldown" as const }));
  }

  const provider = resolveProvider(providers, activeProviderId, config.providerId);
  if (!provider) {
    logger.warn(
      { botId, chatId, overrideProviderId: config.providerId ?? null },
      "Image OCR: no provider resolvable",
    );
    return images.map(() => ({ description: null, skipReason: "no_provider" as const }));
  }

  const modelId = config.modelId?.trim() || provider.defaultModel;
  const maxImages = config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE;
  const maxDescLen = config.maxDescriptionLength ?? DEFAULT_OCR_MAX_DESCRIPTION_LENGTH;
  const timeoutMs = config.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  const systemPrompt = config.systemPrompt?.trim() || DEFAULT_OCR_PROMPT;

  logger.debug(
    {
      botId,
      chatId,
      providerId: provider.id,
      providerFormat: provider.providerFormat,
      baseURL: provider.baseURL,
      configModelId: config.modelId ?? null,
      resolvedModelId: modelId,
      defaultModel: provider.defaultModel,
      imagesCount: images.length,
      maxImages,
      timeoutMs,
    },
    "Image OCR starting",
  );

  const modelFactory =
    provider.providerFormat === "gemini"
      ? createGoogleGenerativeAI({ baseURL: provider.baseURL, apiKey: provider.apiKey })
      : createOpenAICompatible({
          name: "custom",
          baseURL: provider.baseURL,
          apiKey: provider.apiKey,
        });

  const results: OcrResult[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    if (i >= maxImages) {
      results.push({ description: null, skipReason: "over_limit" });
      continue;
    }
    const startedAt = Date.now();
    try {
      const ret = await generateText({
        model: modelFactory(modelId),
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(timeoutMs),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: systemPrompt },
              { type: "image", image: img.buffer, mediaType: img.mimeType },
            ],
          },
        ],
      });
      const raw = (ret.text ?? "").trim();
      const durationMs = Date.now() - startedAt;
      if (onTokenUsage && ret.usage) {
        await onTokenUsage({
          chatId,
          userId,
          model: modelId,
          promptTokens: ret.usage.inputTokens ?? 0,
          completionTokens: ret.usage.outputTokens ?? 0,
          totalTokens: ret.usage.totalTokens ?? 0,
          durationMs,
          trigger: "image_ocr",
        });
      }
      if (!raw) {
        logger.debug({ chatId, index: i }, "Image OCR empty response");
        results.push({ description: null, skipReason: "empty_response" });
        continue;
      }
      results.push({ description: truncateDescription(raw, maxDescLen) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      logger.warn(
        {
          chatId,
          index: i,
          providerId: provider.id,
          providerFormat: provider.providerFormat,
          baseURL: provider.baseURL,
          modelId,
          mimeType: img.mimeType,
          imageBytes: img.buffer.length,
          durationMs,
          error: extractErrorDetail(err),
        },
        "Image OCR call failed",
      );
      results.push({ description: null, skipReason: "error", errorDetail: detail });
    }
  }

  cooldownMap.set(cooldownKey, Date.now());
  return results;
}
