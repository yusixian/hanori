import type {
  BotLogEntry,
  ConversationCallbacks,
  UserPrivacyCallbacks,
} from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../context.js";
import { createAiReplyHandler, type AiReplyConfig } from "./ai-reply.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: streamTextMock,
}));

interface ReproStep {
  toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>;
  toolResults: Array<{ toolName: string; toolCallId: string; output: unknown }>;
}

interface StreamTextOptions {
  tools: Record<string, { execute?: (...args: unknown[]) => PromiseLike<unknown> }>;
  onStepFinish: (step: ReproStep) => void;
}

function sentMessage(messageId: number, text: string): Message.TextMessage {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: 42, type: "private" },
    text,
  } as Message.TextMessage;
}

function createConversation() {
  return {
    getHistory: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
    getRecentUserMessagesAcrossChats: vi.fn().mockResolvedValue([]),
    addMessage: vi.fn(),
    addMessages: vi.fn<ConversationCallbacks["addMessages"]>(),
    upsertUserMessage: vi.fn(),
    ensureCompression: vi.fn(),
    triggerCompression: vi.fn(),
    clearHistory: vi.fn(),
  } satisfies ConversationCallbacks;
}

function createPrivacy() {
  return {
    getMode: vi.fn().mockResolvedValue("normal"),
    runExclusive: vi.fn(async (_userId, operation) => operation()),
    setMode: vi.fn(),
    forget: vi.fn(),
  } satisfies UserPrivacyCallbacks;
}

describe("AI reply multi_message delivery", () => {
  it("falls back to uncovered final text when a follow-up batch fails", async () => {
    const logs: BotLogEntry[] = [];
    const conversation = createConversation();
    let nextMessageId = 20;
    let sendAttempt = 0;
    const sendMessage = vi.fn().mockImplementation(async (_chatId: number, text: string) => {
      sendAttempt++;
      if (sendAttempt === 3) throw new Error("temporary Telegram failure");
      return sentMessage(nextMessageId++, text);
    });
    const api = {
      sendMessage,
      sendChatAction: vi.fn().mockResolvedValue(true),
    } as unknown as Api;
    const firstInput = { messages: [{ text: "ack one" }, { text: "ack two" }] };
    const followUpInput = { messages: [{ text: "result one" }, { text: "result two" }] };
    const trailing = "result one\nresult two";
    const deliveredContent = "ack one\nack two\nresult one\nresult two";
    const steps: ReproStep[] = [];

    streamTextMock.mockImplementation((rawOptions: unknown) => {
      const options = rawOptions as StreamTextOptions;
      const multiMessageTool = options.tools.multi_message;
      if (!multiMessageTool?.execute) throw new Error("Expected multi_message tool");
      const executeMultiMessage = multiMessageTool.execute;

      async function* textStream() {
        const firstOutput = await executeMultiMessage(firstInput);
        const firstStep: ReproStep = {
          toolCalls: [{ toolName: "multi_message", toolCallId: "first", input: firstInput }],
          toolResults: [{ toolName: "multi_message", toolCallId: "first", output: firstOutput }],
        };
        steps.push(firstStep);
        options.onStepFinish(firstStep);

        const followUpOutput = await executeMultiMessage(followUpInput);
        const followUpStep: ReproStep = {
          toolCalls: [{ toolName: "multi_message", toolCallId: "follow-up", input: followUpInput }],
          toolResults: [
            {
              toolName: "multi_message",
              toolCallId: "follow-up",
              output: followUpOutput,
            },
          ],
        };
        steps.push(followUpStep);
        options.onStepFinish(followUpStep);

        const duplicateOutput = await executeMultiMessage(followUpInput);
        const duplicateStep: ReproStep = {
          toolCalls: [{ toolName: "multi_message", toolCallId: "duplicate", input: followUpInput }],
          toolResults: [
            {
              toolName: "multi_message",
              toolCallId: "duplicate",
              output: duplicateOutput,
            },
          ],
        };
        steps.push(duplicateStep);
        options.onStepFinish(duplicateStep);
        yield trailing;
      }

      return {
        textStream: textStream(),
        text: Promise.resolve(trailing),
        steps: Promise.resolve(steps),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        finishReason: Promise.resolve("stop"),
      };
    });

    const config: AiReplyConfig = {
      botId: "bot-1",
      apiKey: "key",
      baseURL: "https://example.com/v1",
      model: "model",
      systemPrompt: "system",
      triggerConfig: {
        replyToBot: true,
        mentionBot: true,
        triggerWords: [],
        randomReplyPercent: 0,
        randomReplyCooldown: 60,
      },
      groupOverrides: {},
      adminChatIds: [],
      privateChatWhitelist: [42],
      conversation,
      privacy: createPrivacy(),
      messageConfig: {
        replyMode: "segment",
        richMessageEnabled: false,
        autoSplitThreshold: 0,
        splitDelayMs: 0,
      },
      token: "token",
      onLog: (entry) => {
        logs.push(entry);
      },
    };
    const ctx = {
      update: { update_id: 1 },
      message: { message_id: 7, text: "hello", entities: [] },
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Tester" },
      me: { id: 99, is_bot: true, first_name: "Ai", username: "sample_bot" },
      api,
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      deleteWaiting: vi.fn(),
      resolveWait: vi.fn().mockResolvedValue(10),
      directlyReply: vi.fn(),
    } as unknown as BotContext;
    const runtime = createAiReplyHandler(config);

    await runtime.handler(ctx, vi.fn());

    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      "ack one",
      "ack two",
      "result one",
    ]);
    expect(ctx.resolveWait).toHaveBeenCalledWith(trailing, "HTML");
    expect(steps[1]?.toolResults[0]?.output).toEqual({
      sent: 0,
      error: "Error: temporary Telegram failure",
    });
    expect(steps[2]?.toolResults[0]?.output).toEqual(expect.objectContaining({ blocked: true }));
    const savedBatch = conversation.addMessages.mock.calls[0]?.[0] ?? [];
    expect(savedBatch.find((message) => message.role === "assistant")?.content).toBe(
      deliveredContent,
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "AI reply sent",
        meta: expect.objectContaining({
          textLength: deliveredContent.length,
          responseTextLength: trailing.length,
          multiMessageSentCount: 2,
        }),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: "AI tool call",
        meta: expect.objectContaining({
          toolName: "multi_message",
          argsLength: expect.any(Number),
        }),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: "AI tool result",
        meta: expect.objectContaining({
          toolName: "multi_message",
          resultLength: expect.any(Number),
        }),
      }),
    );
    expect(JSON.stringify(logs)).not.toContain("ack one");
    expect(JSON.stringify(logs)).not.toContain(trailing);
    runtime.destroy();
  });
});
