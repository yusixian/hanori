import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { extractCacheTokenUsage } from "./cache-usage.js";
import { createUsageAwareOpenAICompatible } from "./openai-compatible.js";

type UsageFixture = {
  completion_tokens: number;
  prompt_tokens: number;
  [key: string]: unknown;
};

type StreamFixtureOptions = {
  text?: string;
  toolCall?: { name: string };
};

function streamEvents(usage: UsageFixture, options: StreamFixtureOptions = {}) {
  const firstDelta = options.toolCall
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "fixture-call",
            function: { name: options.toolCall.name, arguments: "{}" },
          },
        ],
      }
    : { role: "assistant", content: options.text ?? "fixture response" };
  const finishReason = options.toolCall ? "tool_calls" : "stop";

  return [
    {
      id: "fixture-response",
      choices: [{ delta: firstDelta, finish_reason: null }],
    },
    {
      id: "fixture-response",
      choices: [{ delta: {}, finish_reason: finishReason }],
      usage,
    },
  ];
}

function toSse(events: unknown[]) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function fixtureProvider(responses: unknown[][]) {
  let responseIndex = 0;
  const requestBodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const events = responses[responseIndex++];
    if (events == null) throw new Error("fixture response exhausted");

    return new Response(toSse(events), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const provider = createUsageAwareOpenAICompatible({
    apiKey: "fixture-key",
    baseURL: "https://fixture.invalid/v1",
    fetch: fetchImpl,
    name: "fixture",
  });

  return { provider, requestBodies };
}

describe("cache usage with the AI SDK OpenAI-compatible adapter", () => {
  it("preserves cached_tokens from an injected streaming provider response", async () => {
    const { provider, requestBodies } = fixtureProvider([
      streamEvents({
        completion_tokens: 10,
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 60 },
      }),
    ]);
    const result = streamText({
      model: provider.chatModel("fixture-model"),
      prompt: "cached response",
    });

    expect(await result.text).toBe("fixture response");
    const [step] = await result.steps;
    expect(step?.usage.inputTokenDetails.cacheReadTokens).toBe(60);
    expect(extractCacheTokenUsage(step!.usage)).toEqual({ cacheReadTokens: 60 });
    expect(requestBodies[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("keeps a DeepSeek prompt_cache_hit_tokens field available for extraction", async () => {
    const { provider } = fixtureProvider([
      streamEvents({
        completion_tokens: 10,
        prompt_cache_hit_tokens: 80,
        prompt_tokens: 100,
      }),
    ]);
    const result = streamText({
      model: provider.chatModel("fixture-model"),
      prompt: "deepseek response",
    });

    expect(await result.text).toBe("fixture response");
    const [step] = await result.steps;
    expect(step?.usage.inputTokenDetails.cacheReadTokens).toBe(0);
    expect(extractCacheTokenUsage(step!.usage)).toEqual({ cacheReadTokens: 80 });
  });

  it("records unknown cache usage when the response omits cache fields", async () => {
    const { provider } = fixtureProvider([
      streamEvents({ completion_tokens: 10, prompt_tokens: 100 }),
    ]);
    const result = streamText({
      model: provider.chatModel("fixture-model"),
      prompt: "unknown cache response",
    });

    expect(await result.text).toBe("fixture response");
    const [step] = await result.steps;
    expect(step?.usage.inputTokenDetails.cacheReadTokens).toBe(0);
    expect(extractCacheTokenUsage(step!.usage)).toEqual({});
  });

  it("shows that the current adapter drops nested cache_write_tokens", async () => {
    const { provider } = fixtureProvider([
      streamEvents({
        completion_tokens: 10,
        prompt_tokens: 100,
        prompt_tokens_details: {
          cache_write_tokens: 20,
          cached_tokens: 50,
        },
      }),
    ]);
    const result = streamText({
      model: provider.chatModel("fixture-model"),
      prompt: "write cache response",
    });

    expect(await result.text).toBe("fixture response");
    const [step] = await result.steps;
    expect(step?.usage.inputTokenDetails.cacheReadTokens).toBe(50);
    expect(step?.usage.inputTokenDetails.cacheWriteTokens).toBeUndefined();
    expect(step?.usage.raw).toEqual({
      completion_tokens: 10,
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 50 },
    });
    expect(extractCacheTokenUsage(step!.usage)).toEqual({ cacheReadTokens: 50 });
  });

  it("sums total input and observed cache reads across two real SDK steps", async () => {
    const { provider } = fixtureProvider([
      streamEvents(
        {
          completion_tokens: 10,
          prompt_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 800 },
        },
        { toolCall: { name: "fixture_tool" } },
      ),
      streamEvents(
        {
          completion_tokens: 20,
          prompt_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
        { text: "final response" },
      ),
    ]);
    const result = streamText({
      model: provider.chatModel("fixture-model"),
      prompt: "two step response",
      stopWhen: stepCountIs(2),
      tools: {
        fixture_tool: tool({
          execute: async () => "tool result",
          inputSchema: z.object({}),
        }),
      },
    });

    expect(await result.text).toBe("final response");
    const steps = await result.steps;
    const totalUsage = await result.totalUsage;
    const lastStepUsage = await result.usage;
    expect(steps).toHaveLength(2);
    expect(totalUsage.inputTokens).toBe(2200);
    expect(totalUsage.outputTokens).toBe(30);
    expect(totalUsage.totalTokens).toBe(2230);
    expect(lastStepUsage.inputTokens).toBe(1200);
    expect(
      extractCacheTokenUsage(
        totalUsage,
        steps.map((step) => step.usage),
      ),
    ).toEqual({
      cacheReadTokens: 1800,
    });
  });

  it("keeps multi-step cache reads unknown when one SDK step omits the field", async () => {
    const { provider } = fixtureProvider([
      streamEvents(
        {
          completion_tokens: 10,
          prompt_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 800 },
        },
        { toolCall: { name: "fixture_tool" } },
      ),
      streamEvents(
        {
          completion_tokens: 20,
          prompt_tokens: 1200,
        },
        { text: "final response" },
      ),
    ]);
    const result = streamText({
      model: provider.chatModel("fixture-model"),
      prompt: "partial cache response",
      stopWhen: stepCountIs(2),
      tools: {
        fixture_tool: tool({
          execute: async () => "tool result",
          inputSchema: z.object({}),
        }),
      },
    });

    expect(await result.text).toBe("final response");
    const steps = await result.steps;
    const totalUsage = await result.totalUsage;
    expect(steps).toHaveLength(2);
    expect(totalUsage.inputTokens).toBe(2200);
    expect(
      extractCacheTokenUsage(
        totalUsage,
        steps.map((step) => step.usage),
      ),
    ).toEqual({});
  });
});
