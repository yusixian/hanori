import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { Api } from "grammy";
import type { AiReplyConfig } from "../handlers/ai-reply.js";
import { createReasoningCompatibleModelFactory } from "../utils/responses-compatibility.js";

const mocks = vi.hoisted(() => ({ send: vi.fn(), dispose: vi.fn() }));
vi.mock("../tools/turn-toolset.js", () => ({
  createTurnToolset: async () => ({ tools: {}, dispose: mocks.dispose }),
  resolveImageGenerationActor: vi.fn(),
}));
vi.mock("../utils/rich-message.js", () => ({ sendMarkdownWithFallback: mocks.send }));
import { executeScheduledTaskWithBotConfig } from "./scheduled-task-executor.js";

const incompatibility =
  "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          s.closeAllConnections();
          s.close((e) => (e ? reject(e) : resolve()));
        }),
    ),
  );
  vi.clearAllMocks();
});
async function endpoint(
  handler: (
    path: string,
    body: any,
    index: number,
  ) => { status?: number; body: unknown; contentType?: string },
) {
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const path = req.url!;
    requests.push({ path, body });
    const response = handler(path, body, requests.length);
    res.writeHead(response.status ?? 200, {
      "content-type": response.contentType ?? "application/json",
    });
    res.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing port");
  return { requests, baseURL: `http://127.0.0.1:${address.port}/v1` };
}
const reject = (message = incompatibility, status = 400) => ({
  status,
  body: { error: { message, type: "invalid_request_error" } },
});
const response = (output: unknown[]) => ({
  id: "resp_fixture",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-6.1-sol-1m",
  output,
  usage: {
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});
const textOutput = [
  {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Summary complete", annotations: [] }],
  },
];
describe("scheduled task protocol compatibility over real HTTP", () => {
  it("runs the actual task/model factory path with a bounded request switch and one tool/delivery", async () => {
    const http = await endpoint((path, _body, index) =>
      path.endsWith("/chat/completions")
        ? reject()
        : {
            body: response(
              index === 2
                ? [
                    {
                      type: "function_call",
                      id: "fc_fixture",
                      call_id: "call_fixture",
                      name: "read_task_history",
                      arguments: "{}",
                      status: "completed",
                    },
                  ]
                : textOutput,
            ),
          },
    );
    const readTaskHistory = vi.fn().mockResolvedValue({
      messages: [{ content: "Fixture update", createdAt: "2026-01-01T01:00:00Z", role: "user" }],
      complete: true,
    });
    mocks.send.mockResolvedValue({ message: { message_id: 42 } });
    const result = await executeScheduledTaskWithBotConfig({
      api: new Api("123:fixture"),
      chatId: -10,
      userId: 1,
      adminIds: [1],
      readTaskHistory,
      plan: {
        name: "Daily fixture",
        instructions: "Summarize approved history",
        dataScope: { kind: "chat" },
        destination: { chatId: -10 },
        schedule: {
          kind: "interval",
          startsAt: "2026-01-01T00:00:00Z",
          everySeconds: 86400,
          timezone: "Asia/Shanghai",
        },
        agent: { maxSteps: 4, modelId: "gpt-6.1-sol-1m" },
      },
      aiConfig: {
        botId: "fixture",
        systemPrompt: "",
        activeProviderId: "fixture",
        providers: [
          {
            id: "fixture",
            label: "Fixture",
            providerFormat: "openai",
            baseURL: http.baseURL,
            apiKey: "synthetic",
            defaultModel: "fallback-model",
            models: [
              { id: "fallback-model", thinking: "disabled", temperature: 0.2, maxTokens: 99 },
            ],
          },
        ],
      } as AiReplyConfig,
    });
    expect(http.requests.map((r) => r.path)).toEqual([
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/responses",
    ]);
    expect(readTaskHistory).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(result.messageIds).toEqual([42]);
    for (const r of http.requests.slice(1)) {
      expect(r.body.store).toBe(false);
      expect(r.body.reasoning?.effort).not.toBe("none");
      expect(r.body.model).toBe("gpt-6.1-sol-1m");
    }
    expect(http.requests[2]!.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call_output", call_id: "call_fixture" }),
      ]),
    );
  });
  it("does not replay an already completed tool when a later model request requires Responses", async () => {
    const http = await endpoint((path, _body, index) =>
      index === 1
        ? {
            body: {
              id: "chat_fixture",
              object: "chat.completion",
              created: 1,
              model: "gpt-6.1-sol",
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_one",
                        type: "function",
                        function: { name: "work", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          }
        : path.endsWith("/chat/completions")
          ? reject()
          : { body: response(textOutput) },
    );
    const execute = vi.fn().mockResolvedValue("done");
    await generateText({
      model: createReasoningCompatibleModelFactory({ baseURL: http.baseURL, apiKey: "synthetic" })(
        "gpt-6.1-sol",
      ),
      prompt: "Do work",
      tools: { work: tool({ inputSchema: z.object({}), execute }) },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
      providerOptions: { custom: { reasoningEffort: "high" } },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(http.requests.map((r) => r.path)).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/responses",
    ]);
    expect(http.requests[2]!.body.reasoning.effort).toBe("high");
  });
  it.each([
    ["permission denied", 401],
    ["rate limited", 429],
    ["server error", 500],
    ["different invalid input", 400],
  ] as const)("does not switch for %s", async (message, status) => {
    const http = await endpoint(() => reject(message, status));
    await expect(
      generateText({
        model: createReasoningCompatibleModelFactory({
          baseURL: http.baseURL,
          apiKey: "synthetic",
        })("gpt-6.1-sol"),
        prompt: "test",
        tools: { work: tool({ inputSchema: z.object({}), execute: async () => "done" }) },
        maxRetries: 0,
      }),
    ).rejects.toThrow(message);
    expect(http.requests.map((r) => r.path)).toEqual(["/v1/chat/completions"]);
  });
  it("does not silently discard explicit vendor thinking budgets", async () => {
    const http = await endpoint(() => reject());
    await expect(
      generateText({
        model: createReasoningCompatibleModelFactory({
          baseURL: http.baseURL,
          apiKey: "synthetic",
        })("gpt-6.1-sol"),
        prompt: "test",
        tools: { work: tool({ inputSchema: z.object({}), execute: async () => "done" }) },
        maxRetries: 0,
        providerOptions: { custom: { thinking: { type: "enabled", budget_tokens: 2048 } } },
      }),
    ).rejects.toThrow("cannot be mapped");
    expect(http.requests).toHaveLength(1);
  });
  it("switches the streaming HTTP request before output without changing the agent loop", async () => {
    const events = [
      {
        type: "response.created",
        response: { id: "resp_stream", created_at: 1, model: "gpt-6.1-sol" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_stream",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_stream",
        output_index: 0,
        content_index: 0,
        delta: "Done",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_stream",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done", annotations: [] }],
        },
      },
      { type: "response.completed", response: { ...response(textOutput), id: "resp_stream" } },
    ]
      .map((data) => `data: ${JSON.stringify(data)}\n\n`)
      .join("");
    const http = await endpoint((path) =>
      path.endsWith("/chat/completions")
        ? reject()
        : { body: events, contentType: "text/event-stream" },
    );
    const result = streamText({
      model: createReasoningCompatibleModelFactory({ baseURL: http.baseURL, apiKey: "synthetic" })(
        "gpt-6.1-sol",
      ),
      prompt: "test",
      tools: { work: tool({ inputSchema: z.object({}), execute: async () => "done" }) },
      maxRetries: 0,
    });
    expect(await result.text).toBe("Done");
    expect(http.requests.map((r) => r.path)).toEqual(["/v1/chat/completions", "/v1/responses"]);
  });
  it("does not switch after a network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      generateText({
        model: createReasoningCompatibleModelFactory({
          baseURL: "https://fixture.invalid/v1",
          apiKey: "synthetic",
          fetch,
        })("gpt-6.1-sol"),
        prompt: "test",
        tools: { work: tool({ inputSchema: z.object({}), execute: async () => "done" }) },
        maxRetries: 0,
      }),
    ).rejects.toThrow("network down");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("surfaces Responses rejection without another protocol retry", async () => {
    const http = await endpoint((path) =>
      path.endsWith("/chat/completions") ? reject() : reject("Responses unavailable", 400),
    );
    await expect(
      generateText({
        model: createReasoningCompatibleModelFactory({
          baseURL: http.baseURL,
          apiKey: "synthetic",
        })("gpt-6.1-sol"),
        prompt: "test",
        tools: { work: tool({ inputSchema: z.object({}), execute: async () => "done" }) },
        maxRetries: 0,
      }),
    ).rejects.toThrow("Responses unavailable");
    expect(http.requests).toHaveLength(2);
  });
});
