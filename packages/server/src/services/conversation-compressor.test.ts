import { DEFAULT_CONVERSATION_CONFIG } from "@cos-tool-bot/shared";
import { generateText } from "ai";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationStore } from "./conversation-store.js";
import { compressConversation } from "./conversation-compressor.js";

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => "gemini-model")),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => vi.fn(() => "openai-model")),
}));
vi.mock("ai", () => ({ generateText: vi.fn() }));

const botId = "00000000-0000-4000-8000-000000000017";
const chatId = 42;

function createStore(overrides: Partial<ConversationStore> = {}) {
  return {
    getUncompactedMessageCount: vi.fn().mockResolvedValue(31),
    getCompactionCandidate: vi.fn().mockResolvedValue({
      activeSummaryId: 7,
      oldCursorId: 10,
      existingSummary: "Earlier summary",
      messages: [
        { id: 11, role: "user", content: "Keep this fact", userName: "Alice" },
        { id: 12, role: "tool_result", content: "Tool output", userName: null },
      ],
      sourceMessageIds: [11, 12],
      newCursorId: 12,
    }),
    commitCompaction: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as ConversationStore;
}

function createOptions(store: ConversationStore) {
  return {
    botId,
    chatId,
    store,
    conversationConfig: { ...DEFAULT_CONVERSATION_CONFIG, summarizeThreshold: 30 },
    apiKey: "test-key",
    baseURL: "https://example.invalid/v1",
    model: "test-model",
    logger: { warn: vi.fn() } as unknown as Logger,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateText).mockResolvedValue({ text: "Updated summary" } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("compressConversation", () => {
  it("does nothing when automatic summarization is disabled", async () => {
    const store = createStore();
    const options = createOptions(store);

    await compressConversation({
      ...options,
      conversationConfig: { ...options.conversationConfig, autoSummarize: false },
    });

    expect(store.getUncompactedMessageCount).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("uses only the uncompacted count for the threshold", async () => {
    const store = createStore({
      getUncompactedMessageCount: vi.fn().mockResolvedValue(30),
    } as Partial<ConversationStore>);

    await compressConversation(createOptions(store));

    expect(store.getCompactionCandidate).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("can force a budget-driven compaction below the message-count threshold", async () => {
    const store = createStore({
      getUncompactedMessageCount: vi.fn().mockResolvedValue(2),
    } as Partial<ConversationStore>);

    await compressConversation({
      ...createOptions(store),
      conversationConfig: {
        ...DEFAULT_CONVERSATION_CONFIG,
        autoSummarize: false,
        summarizeThreshold: 30,
      },
      force: true,
      keepRecent: 1,
    });

    expect(store.getCompactionCandidate).toHaveBeenCalledWith(botId, chatId, 1);
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("commits a cursor snapshot with message ids and roles in the prompt", async () => {
    const store = createStore();
    const controller = new AbortController();

    await compressConversation({ ...createOptions(store), abortSignal: controller.signal });

    const request = vi.mocked(generateText).mock.calls[0]![0];
    expect(request.maxOutputTokens).toBe(2_048);
    expect(request.abortSignal).toBe(controller.signal);
    expect(request.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining(
            '{"id":12,"role":"tool_result","userName":null,"content":"Tool output"}',
          ),
        }),
      ]),
    );
    expect(store.commitCompaction).toHaveBeenCalledWith({
      botId,
      chatId,
      expectedActiveSummaryId: 7,
      oldCursorId: 10,
      newCursorId: 12,
      summaryText: "Updated summary",
      messageCount: 2,
      sourceMessageIds: [11, 12],
    });
  });

  it("retains raw history and leaves the cursor unchanged when the LLM fails", async () => {
    const store = createStore();
    const options = createOptions(store);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(compressConversation(options)).resolves.toBeUndefined();

    expect(store.commitCompaction).not.toHaveBeenCalled();
    expect(options.logger.warn).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining("raw history retained"),
    );
  });

  it("backs off after a failed summary before allowing another attempt", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const options = createOptions(store);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("provider unavailable"));

    await compressConversation(options);
    await compressConversation(options);

    expect(generateText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await compressConversation(options);

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(store.commitCompaction).toHaveBeenCalledOnce();
  });

  it("retries immediately when the provider configuration changes", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const options = createOptions(store);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("invalid provider credentials"));

    await compressConversation(options);
    await compressConversation({ ...options, apiKey: "replacement-key" });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(store.commitCompaction).toHaveBeenCalledOnce();
  });

  it("does not move the cursor for an empty summary", async () => {
    const store = createStore();
    vi.mocked(generateText).mockResolvedValueOnce({ text: "  " } as never);

    await compressConversation(createOptions(store));

    expect(store.commitCompaction).not.toHaveBeenCalled();
  });

  it("backs off when the provider returns an empty summary", async () => {
    vi.useFakeTimers();
    const store = createStore();
    vi.mocked(generateText).mockResolvedValue({ text: "  " } as never);
    const options = createOptions(store);

    await compressConversation(options);
    await compressConversation(options);

    expect(generateText).toHaveBeenCalledOnce();
    expect(store.commitCompaction).not.toHaveBeenCalled();
  });

  it("reruns once when another trigger arrives during compression", async () => {
    let resolveGeneration!: (value: { text: string }) => void;
    vi.mocked(generateText).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGeneration = resolve;
      }) as never,
    );
    const store = createStore({
      getUncompactedMessageCount: vi.fn().mockResolvedValueOnce(31).mockResolvedValueOnce(30),
    } as Partial<ConversationStore>);
    const options = createOptions(store);

    const first = compressConversation(options);
    const second = compressConversation(options);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    resolveGeneration({ text: "Updated summary" });
    await Promise.all([first, second]);
    expect(store.getUncompactedMessageCount).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(store.commitCompaction).toHaveBeenCalledTimes(1);
  });

  it("still runs a pending trigger when the current check fails", async () => {
    let rejectCount!: (reason: Error) => void;
    const store = createStore({
      getUncompactedMessageCount: vi
        .fn()
        .mockReturnValueOnce(
          new Promise((_, reject) => {
            rejectCount = reject;
          }),
        )
        .mockResolvedValueOnce(30),
    } as Partial<ConversationStore>);
    const options = createOptions(store);

    const first = compressConversation(options);
    const second = compressConversation(options);
    rejectCount(new Error("temporary database failure"));

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(store.getUncompactedMessageCount).toHaveBeenCalledTimes(2);
  });
});
