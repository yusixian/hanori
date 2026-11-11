import type { ConversationCallbacks } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  assembleContext,
  buildContinueChatPromptBundle,
  type ContextAssemblyInput,
} from "./context-assembler.js";

const HISTORY = [
  { role: "user", content: "这个 hydration 的文章讲了啥", userName: "Alice", tgMessageId: 4820 },
  { role: "assistant", content: "我看看", userName: null, tgMessageId: 4821 },
  { role: "user", content: "帮我写个频道摘要", userName: "Bob", tgMessageId: 4822 },
  { role: "user", content: "压缩时丢了 id 的旧消息", userName: "Bob" },
];

function conversation(): ConversationCallbacks {
  return {
    getHistory: vi.fn().mockResolvedValue({ summary: null, messages: HISTORY }),
    getRecentUserMessagesAcrossChats: vi.fn().mockResolvedValue([]),
    addMessage: vi.fn(),
    addMessages: vi.fn(),
    upsertUserMessage: vi.fn(),
    ensureCompression: vi.fn(),
    triggerCompression: vi.fn(),
    clearHistory: vi.fn(),
  } as unknown as ConversationCallbacks;
}

function input(overrides: Partial<ContextAssemblyInput> = {}): ContextAssemblyInput {
  return {
    systemPrompt: "Base system",
    isPrivate: false,
    chatId: -1001,
    userName: "Bob",
    maxContextMessages: 20,
    conversation: conversation(),
    toolCapabilities: new Set(),
    ...overrides,
  };
}

function promptText(messages: Array<{ content: string }>): string {
  return messages.map((message) => message.content).join("\n");
}

describe("replyable message ids in the assembled prompt", () => {
  it("labels group history messages with their Telegram id and reports them", async () => {
    const bundle = await assembleContext(input({ historyFormat: "prompt" }));

    expect(promptText(bundle.messages)).toContain("[#4820 Alice]: 这个 hydration 的文章讲了啥");
    expect(promptText(bundle.messages)).toContain("[#4822 Bob]: 帮我写个频道摘要");
    expect(bundle.replyableMessageIds).toEqual([4820, 4821, 4822]);
  });

  it.each(["reply", "continue"])(
    "allows database history targets without a ring buffer in a %s turn",
    async (turn) => {
      const bundle =
        turn === "reply"
          ? await assembleContext(input())
          : await buildContinueChatPromptBundle({
              systemPrompt: "Base system",
              chatId: -1001,
              conversation: conversation(),
              moodState: new Map(),
              toolCapabilities: new Set(),
            });
      const instructions = bundle.messages[0]!.content;
      expect(instructions).toContain("包括对话历史和近期群聊消息");
      expect(instructions).not.toContain("其它位置的历史消息没有 ID");
      expect(promptText(bundle.messages)).toContain("[#4820 Alice]");
      expect(bundle.replyableMessageIds).toContain(4820);
    },
  );

  it("labels group history the same way in messages format", async () => {
    const bundle = await assembleContext(input({ historyFormat: "messages" }));

    expect(promptText(bundle.messages)).toContain("[#4820 Alice]: 这个 hydration 的文章讲了啥");
    expect(bundle.replyableMessageIds).toEqual([4820, 4821, 4822]);
  });

  it("labels bot messages for editing", async () => {
    const bundle = await assembleContext(input({ historyFormat: "prompt" }));

    expect(promptText(bundle.messages)).toContain("#4821");
    expect(bundle.replyableMessageIds).toContain(4821);
  });

  it("labels only bot messages in private chats", async () => {
    const bundle = await assembleContext(input({ isPrivate: true, chatId: 42 }));

    expect(promptText(bundle.messages)).not.toContain("#4820");
    expect(bundle.replyableMessageIds).toEqual([4821]);
  });

  it("keeps a message that lost its id out of the reply target set", async () => {
    const bundle = await assembleContext(input({ historyFormat: "prompt" }));

    expect(promptText(bundle.messages)).toContain("Bob: 压缩时丢了 id 的旧消息");
    expect(bundle.replyableMessageIds).toEqual([4820, 4821, 4822]);
  });
});

describe("cosinside relay context", () => {
  it.each(["prompt", "messages"] as const)(
    "attributes relay text without an assistant turn in %s format",
    async (historyFormat) => {
      const callbacks = conversation();
      vi.mocked(callbacks.getHistory).mockResolvedValue({
        summary: null,
        messages: [
          {
            role: "context",
            content: "明天再讨论",
            userName: "Alice",
            tgMessageId: 5000,
            relayOrigin: { source: "cosinside", initiatorTelegramId: 42, initiatorName: "Alice" },
          },
        ],
      });
      const bundle = await assembleContext(input({ historyFormat, conversation: callbacks }));
      const relayMessage = bundle.messages.find((message) =>
        message.content.includes("明天再讨论"),
      );
      expect(relayMessage?.role).toBe("user");
      expect(relayMessage?.content).toContain("cosinside 代发");
      expect(relayMessage?.content).toContain("Alice");
      expect(relayMessage?.content).toContain("Telegram ID: 42");
      expect(relayMessage?.content).toContain("非 AI 自主发言");
      expect(bundle.replyableMessageIds).not.toContain(5000);
    },
  );
});
