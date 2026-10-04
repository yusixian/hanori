import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import { createModelFetch } from "./model-fetch.js";

const UNSUPPORTED_USAGE_STATUSES = new Set([400, 422]);
const STREAMING_USAGE_FIELD_PATTERN = /stream_options|include_usage/i;

function withoutStreamingUsage(init: RequestInit | undefined): RequestInit | undefined {
  if (typeof init?.body !== "string") return undefined;

  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const streamOptions = body["stream_options"];
    if (
      typeof streamOptions !== "object" ||
      streamOptions === null ||
      Array.isArray(streamOptions)
    ) {
      return undefined;
    }

    const remainingOptions = { ...(streamOptions as Record<string, unknown>) };
    if (remainingOptions["include_usage"] !== true) return undefined;
    delete remainingOptions["include_usage"];

    if (Object.keys(remainingOptions).length > 0) body["stream_options"] = remainingOptions;
    else delete body["stream_options"];

    return { ...init, body: JSON.stringify(body) };
  } catch {
    return undefined;
  }
}

async function explicitlyRejectsStreamingUsage(response: Response): Promise<boolean> {
  if (!UNSUPPORTED_USAGE_STATUSES.has(response.status)) return false;
  try {
    return STREAMING_USAGE_FIELD_PATTERN.test(await response.clone().text());
  } catch {
    return false;
  }
}

/**
 * Requests streaming usage when supported and remembers endpoints that explicitly
 * reject the optional OpenAI `stream_options.include_usage` extension.
 */
export function createStreamingUsageCompatibleFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  let streamingUsageSupported = true;

  return async (input, init) => {
    const fallbackInit = withoutStreamingUsage(init);
    if (!fallbackInit) return fetchImpl(input, init);
    if (!streamingUsageSupported) return fetchImpl(input, fallbackInit);

    const response = await fetchImpl(input, init);
    if (!(await explicitlyRejectsStreamingUsage(response))) return response;

    streamingUsageSupported = false;
    return fetchImpl(input, fallbackInit);
  };
}

export function createUsageAwareOpenAICompatible(
  settings: Omit<OpenAICompatibleProviderSettings, "fetch" | "includeUsage"> & {
    fetch?: typeof globalThis.fetch;
  },
) {
  return createOpenAICompatible({
    ...settings,
    includeUsage: true,
    fetch: createStreamingUsageCompatibleFetch(createModelFetch(settings.fetch)),
  });
}
