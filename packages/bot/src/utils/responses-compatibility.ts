import { createOpenAI } from "@ai-sdk/openai";
import { APICallError } from "ai";
import { createUsageAwareOpenAICompatible } from "./openai-compatible.js";
import { createModelFetch } from "./model-fetch.js";

type Model = ReturnType<ReturnType<typeof createOpenAI>["responses"]>;
type CallOptions = Parameters<Model["doGenerate"]>[0];

function requiresResponses(error: unknown, options: CallOptions) {
  return (
    options.tools?.some((tool) => tool.type === "function") &&
    APICallError.isInstance(error) &&
    error.statusCode === 400 &&
    /\/chat\/completions(?:\?|$)/.test(error.url) &&
    /Function tools with reasoning_effort are not supported[\s\S]*\/v1\/chat\/completions[\s\S]*use \/v1\/responses/i.test(
      error.responseBody ?? error.message,
    )
  );
}
function responsesOptions(options: CallOptions): CallOptions {
  const custom = options.providerOptions?.custom;
  // Token budgets and vendor-specific thinking switches are not Responses effort levels.
  if (custom?.thinking !== undefined)
    throw new Error(
      "This endpoint requires Responses for reasoning with tools, but its explicit thinking setting cannot be mapped to Responses. Use the model's default thinking setting or a supported Responses reasoning effort.",
    );
  return {
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: {
        ...(typeof custom?.reasoningEffort === "string"
          ? { reasoningEffort: custom.reasoningEffort }
          : {}),
        ...options.providerOptions?.openai,
        store: false,
      },
    },
  };
}

/** Switch only a rejected model request, never the agent loop or completed tool calls. */
export function createReasoningCompatibleModelFactory(settings: {
  baseURL: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}) {
  const chat = createUsageAwareOpenAICompatible({ ...settings, name: "custom" });
  const responses = createOpenAI({ ...settings, fetch: createModelFetch(settings.fetch) });
  return (modelId: string): Model => {
    const primary = chat(modelId),
      alternate = responses.responses(modelId);
    let useResponses = false;
    return {
      specificationVersion: primary.specificationVersion,
      provider: primary.provider,
      modelId,
      supportedUrls: primary.supportedUrls,
      async doGenerate(options) {
        if (useResponses) return alternate.doGenerate(responsesOptions(options));
        try {
          return await primary.doGenerate(options);
        } catch (error) {
          if (!requiresResponses(error, options)) throw error;
          const next = responsesOptions(options);
          useResponses = true;
          return alternate.doGenerate(next);
        }
      },
      async doStream(options) {
        if (useResponses) return alternate.doStream(responsesOptions(options));
        try {
          return await primary.doStream(options);
        } catch (error) {
          if (!requiresResponses(error, options)) throw error;
          const next = responsesOptions(options);
          useResponses = true;
          return alternate.doStream(next);
        }
      },
    };
  };
}
