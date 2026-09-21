import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { BotLogEntry, MemoryCallbacks } from "@cos-tool-bot/shared";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { composeTurnTools } from "../utils/tool-pipeline.js";
import { createAiTurnLogger } from "../utils/ai-turn-log.js";
import { createProfileAvatarTools } from "./profile-avatar.js";
import { createRequestCache } from "./utils.js";

const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const base64 = Buffer.from(bytes).toString("base64");
function memory() {
  return {
    getProfileAvatar: vi.fn().mockResolvedValue({
      status: "available",
      telegramId: 7,
      avatarVersion: "v1",
      data: bytes,
      mediaType: "image/png",
    }),
  } as unknown as MemoryCallbacks;
}
function resultMessage(toolCallId: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "get_profile_avatar",
        toolCallId,
        output: { type: "json", value: { status: "available" } },
      },
    ],
  };
}

async function execute(
  runtime: ReturnType<typeof createProfileAvatarTools>,
  id = "call-1",
  userId = 7,
) {
  return runtime.tools.get_profile_avatar!.execute!(
    { telegram_id: userId },
    {
      toolCallId: id,
      messages: [],
    },
  );
}

describe("profile avatar request images", () => {
  it("does not persist Google avatar request bytes in provider failure diagnostics", async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(async () => {
      requestCount++;
      return new Response(
        JSON.stringify(
          requestCount === 1
            ? {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        { functionCall: { name: "get_profile_avatar", args: { telegram_id: 7 } } },
                      ],
                    },
                    finishReason: "STOP",
                    index: 0,
                  },
                ],
              }
            : {
                error: { code: 400, message: "fixture rejected image", status: "INVALID_ARGUMENT" },
              },
        ),
        { status: requestCount === 1 ? 200 : 400, headers: { "content-type": "application/json" } },
      );
    });
    const runtime = createProfileAvatarTools(memory(), 42);
    const logs: BotLogEntry[] = [];
    const log = createAiTurnLogger(
      (entry) => {
        logs.push(entry);
      },
      { chatId: 42 },
    );
    let providerError: unknown;
    try {
      await generateText({
        model: createGoogleGenerativeAI({ apiKey: "fixture-key", fetch: fetchMock })(
          "gemini-2.5-flash",
        ),
        prompt: "Analyze the avatar of Telegram user 7.",
        tools: runtime.tools,
        prepareStep: runtime.prepareStep,
        stopWhen: stepCountIs(2),
        maxRetries: 0,
      });
    } catch (error) {
      providerError = error;
      log({ level: "error", message: "AI provider failed", meta: { error } });
    }
    expect(requestCount).toBe(2);
    expect(providerError).toMatchObject({ statusCode: 400 });
    const persisted = JSON.stringify(logs);
    expect(persisted).toContain("fixture rejected image");
    expect(persisted).toContain("binary inline data");
    expect(persisted).not.toContain(base64);
  });

  it("requires a configured reader and a real requester", () => {
    expect(createProfileAvatarTools(undefined, 42).tools).toEqual({});
    expect(createProfileAvatarTools(memory(), undefined).tools).toEqual({});
    expect(createProfileAvatarTools(memory(), -1).tools).toEqual({});
  });

  it("keeps bytes out of results/logs, binds image to its tool call, and isolates turns", async () => {
    const callbacks = memory();
    const runtime = createProfileAvatarTools(callbacks, 42);
    const logs: BotLogEntry[] = [];
    const onEffect = vi.fn();
    const wrapped = composeTurnTools(runtime.tools, {
      requestCache: createRequestCache(),
      onLog: (entry) => {
        logs.push(entry);
      },
      getStep: () => 1,
      onEffect,
    });
    const output = await wrapped.get_profile_avatar!.execute!(
      { telegram_id: 7 },
      {
        toolCallId: "call-1",
        messages: [],
      },
    );
    expect(callbacks.getProfileAvatar).toHaveBeenCalledWith(7, 42);
    expect(output).toMatchObject({ status: "available", telegramId: 7 });
    expect(JSON.stringify({ output, logs })).not.toContain(base64);
    expect(JSON.stringify({ output, logs })).not.toContain('"data"');
    expect(onEffect).not.toHaveBeenCalled();
    const messages = [resultMessage("unrelated"), resultMessage("call-1")];
    const prepared = runtime.prepareStep({ messages });
    expect(prepared.messages).toHaveLength(3);
    expect(prepared.messages[2]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining("7") },
        { type: "image", image: bytes, mediaType: "image/png" },
      ],
    });
    expect(messages).toHaveLength(2);
    expect(runtime.prepareStep({ messages })).toEqual(prepared);
    expect(createProfileAvatarTools(callbacks, 42).prepareStep({ messages }).messages).toEqual(
      messages,
    );
  });

  it.each(["forbidden", "not_found", "no_avatar", "cache_unavailable", "unavailable"])(
    "does not attach an image for %s",
    async (status) => {
      const callbacks = memory();
      vi.mocked(callbacks.getProfileAvatar!).mockResolvedValue({ status } as never);
      const runtime = createProfileAvatarTools(callbacks, 42);
      expect(await execute(runtime)).toMatchObject({ status });
      const messages = [resultMessage("call-1")];
      expect(runtime.prepareStep({ messages }).messages).toEqual(messages);
    },
  );

  it("bounds calls, validates IDs at runtime, and masks reader errors", async () => {
    const callbacks = memory();
    const runtime = createProfileAvatarTools(callbacks, 42);
    expect(await execute(runtime, "invalid", 0)).toMatchObject({ status: "invalid_input" });
    expect(callbacks.getProfileAvatar).not.toHaveBeenCalled();
    vi.mocked(callbacks.getProfileAvatar!).mockRejectedValueOnce(new Error("/secret/avatar.jpg"));
    expect(await execute(runtime)).toEqual({
      status: "unavailable",
      message: "暂时无法读取头像，请稍后重试",
    });
    await execute(runtime, "call-2");
    await execute(runtime, "call-3");
    expect(await execute(runtime, "call-4")).toMatchObject({ status: "limit_reached" });
    expect(callbacks.getProfileAvatar).toHaveBeenCalledTimes(3);
  });

  it.each(["openai", "google"] as const)(
    "sends actual image content through the %s adapter",
    async (provider) => {
      const requests: any[] = [];
      const fetchMock = vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const first = requests.length === 1;
        const response =
          provider === "openai"
            ? {
                id: "completion",
                object: "chat.completion",
                created: 1,
                model: "fixture-model",
                choices: [
                  {
                    index: 0,
                    finish_reason: first ? "tool_calls" : "stop",
                    message: first
                      ? {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              id: "avatar-call",
                              type: "function",
                              function: {
                                name: "get_profile_avatar",
                                arguments: '{"telegram_id":7}',
                              },
                            },
                          ],
                        }
                      : { role: "assistant", content: "The avatar is visible." },
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }
            : {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: first
                        ? [
                            {
                              functionCall: {
                                name: "get_profile_avatar",
                                args: { telegram_id: 7 },
                              },
                            },
                          ]
                        : [{ text: "The avatar is visible." }],
                    },
                    finishReason: "STOP",
                    index: 0,
                  },
                ],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
              };
        return new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
        });
      });
      const model =
        provider === "openai"
          ? createOpenAICompatible({
              name: "fixture",
              apiKey: "fixture-key",
              baseURL: "https://fixture.invalid/v1",
              fetch: fetchMock,
            })("fixture-model")
          : createGoogleGenerativeAI({ apiKey: "fixture-key", fetch: fetchMock })(
              "gemini-2.5-flash",
            );
      const runtime = createProfileAvatarTools(memory(), 42);
      const result = await generateText({
        model,
        prompt: "Analyze the avatar of Telegram user 7.",
        tools: runtime.tools,
        prepareStep: runtime.prepareStep,
        stopWhen: stepCountIs(2),
      });
      expect(result.text).toBe("The avatar is visible.");
      expect(requests).toHaveLength(2);
      if (provider === "openai") {
        expect(requests[1].messages).toContainEqual(
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
            ]),
          }),
        );
        expect(
          requests[1].messages.find((message: any) => message.role === "tool").content,
        ).not.toContain(base64);
      } else {
        expect(requests[1].contents).toContainEqual(
          expect.objectContaining({
            role: "user",
            parts: expect.arrayContaining([
              { inlineData: { mimeType: "image/png", data: base64 } },
            ]),
          }),
        );
      }
      expect(JSON.stringify(result.steps.flatMap((step) => step.toolResults))).not.toContain(
        base64,
      );
    },
  );
});
