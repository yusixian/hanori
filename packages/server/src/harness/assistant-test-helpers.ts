/** Scripted language model and request builders for the topic assistant tests. */
import { MockLanguageModelV3 } from "ai/test";
import { TEST_CHAT_ID, TEST_OWNER, createTestService } from "./test-fakes.js";

export type CallOptions = MockLanguageModelV3["doGenerateCalls"][number];
type Content = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>["content"][number];

export type Step = Array<
  { type: "text"; text: string } | { type: "tool-call"; toolName: string; input: object }
>;

/** Each generate call answers with the next step; the last step repeats. */
export function scriptedModel(steps: Step[]): {
  model: MockLanguageModelV3;
  calls: CallOptions[];
  promptOf: (index: number) => string;
} {
  const calls: CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      const content: Content[] = step.map((part, index) =>
        part.type === "text"
          ? part
          : {
              type: "tool-call",
              toolCallId: `call-${calls.length}-${index}`,
              toolName: part.toolName,
              input: JSON.stringify(part.input),
            },
      );
      const toolCall = step.some((part) => part.type === "tool-call");
      return {
        content,
        finishReason: { unified: toolCall ? "tool-calls" : "stop", raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  const promptOf = (index: number) => JSON.stringify(calls[index]?.prompt ?? null);
  return { model, calls, promptOf };
}

export type AssistantCtx = Awaited<ReturnType<typeof createTestService>>;

export function say(
  ctx: AssistantCtx,
  model: MockLanguageModelV3,
  text: string,
  options: { threadId?: number; messageId?: number; userId?: number } = {},
) {
  return ctx.port.handleTopicMessage(
    {
      chatId: TEST_CHAT_ID,
      threadId: "threadId" in options ? options.threadId : 501,
      userId: options.userId ?? TEST_OWNER,
      messageId: options.messageId ?? 1000,
      text,
    },
    { model },
  );
}

export function tap(
  ctx: AssistantCtx,
  messageId: number,
  options: { threadId?: number; userId?: number; data?: string } = {},
) {
  return ctx.port.handleCallback({
    data: options.data ?? "hx:t:0",
    chatId: TEST_CHAT_ID,
    threadId: "threadId" in options ? options.threadId : 501,
    messageId,
    userId: options.userId ?? TEST_OWNER,
  });
}
