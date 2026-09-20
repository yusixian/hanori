import {
  DEFAULT_ENGAGEMENT_POLICY,
  ENGAGEMENT_MODEL,
  type EngagementPolicy,
} from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { EngagementEvaluator, selectEngagementContext } from "./engagement-evaluator.js";

const policy: EngagementPolicy = {
  ...DEFAULT_ENGAGEMENT_POLICY,
  mode: "active",
  preferences: "Keep replies concise",
};

function evaluateInput(overrides: Partial<Parameters<EngagementEvaluator["evaluate"]>[0]> = {}) {
  return {
    apiKey: "secret-key",
    policy,
    context: [
      { messageId: 1, userId: 42, text: "hello", timestamp: 1_000 },
      { messageId: 2, userId: 7, text: "hi", timestamp: 2_000, isBot: true },
    ],
    chatId: -100,
    messageId: 2,
    currentMessageId: 2,
    ...overrides,
  };
}

function jevResponse(choice: "continue" | "join" | "silent" = "continue") {
  const probabilities = {
    continue: choice === "continue" ? 0.9 : 0.05,
    join: choice === "join" ? 0.9 : 0.05,
    silent: choice === "silent" ? 0.9 : 0.05,
  };
  return new Response(
    JSON.stringify({
      model: ENGAGEMENT_MODEL,
      answers: {
        engagement: {
          type: "choice",
          choice,
          confidence: 0.9,
          probabilities,
        },
      },
      usage: { input_tokens: 100 },
    }),
    { status: 200 },
  );
}

describe("selectEngagementContext", () => {
  it("keeps current and reply text while enforcing age, count, and character bounds", () => {
    const now = 1_000_000;
    const selected = selectEngagementContext({
      messages: [
        { messageId: 1, userId: 1, text: "stale", timestamp: now - 300_001 },
        ...Array.from({ length: 30 }, (_, index) => ({
          messageId: index + 10,
          userId: index,
          text: "x".repeat(400),
          timestamp: now - index,
        })),
      ],
      current: { messageId: 100, userId: 100, text: "c".repeat(4_000), timestamp: now },
      reply: { messageId: 101, userId: 101, text: "r".repeat(4_000), timestamp: now - 10_000 },
      maxMessages: 50,
      now,
    });

    expect(selected.length).toBeLessThanOrEqual(20);
    expect(selected.some((message) => message.messageId === 1)).toBe(false);
    expect(selected.some((message) => message.messageId === 100)).toBe(true);
    expect(selected.some((message) => message.messageId === 101)).toBe(true);
    expect(selected.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(
      6_000,
    );
  });

  it("omits stale replies and never exceeds the configured message count", () => {
    const now = 1_000_000;
    const current = { messageId: 100, userId: 100, text: "current", timestamp: now };
    const recentReply = { messageId: 101, userId: 101, text: "recent", timestamp: now - 1_000 };
    const staleReply = { messageId: 102, userId: 102, text: "stale", timestamp: now - 300_001 };

    expect(
      selectEngagementContext({ messages: [], current, reply: recentReply, maxMessages: 1, now }),
    ).toEqual([expect.objectContaining({ messageId: current.messageId })]);
    expect(
      selectEngagementContext({ messages: [], current, reply: staleReply, maxMessages: 20, now }),
    ).toEqual([expect.objectContaining({ messageId: current.messageId })]);
  });
});

describe("EngagementEvaluator", () => {
  it("sends the pinned Choice request and returns a sanitized, costed sample", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jevResponse());
    const evaluator = new EngagementEvaluator(fetchMock);

    const sample = await evaluator.evaluate(evaluateInput());

    expect(sample).toMatchObject({
      choice: "continue",
      engagement: "answer",
      model: ENGAGEMENT_MODEL,
      inputTokens: 100,
      actualTrigger: null,
      configSnapshot: policy,
    });
    expect(sample.estimatedCostUsd).toBeCloseTo(0.0000042);
    expect(sample.configVersion).toHaveLength(24);
    expect(sample.configSnapshot).not.toHaveProperty("apiKey");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret-key" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: ENGAGEMENT_MODEL });
    expect(body).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("42");
    expect(JSON.stringify(body)).toContain("participant_1");
    expect(JSON.stringify(body)).toContain("untrusted chat data");
  });

  it("rejects malformed probability distributions", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: ENGAGEMENT_MODEL,
          answers: {
            engagement: {
              type: "choice",
              choice: "continue",
              confidence: 0.9,
              probabilities: { continue: 0.9, join: 0.9, silent: 0.9 },
            },
          },
        }),
      ),
    );

    await expect(
      new EngagementEvaluator(fetchMock).evaluate(evaluateInput()),
    ).resolves.toMatchObject({ errorCategory: "invalid_response", choice: null });
  });

  it("rejects a choice that is not a highest-probability option", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: ENGAGEMENT_MODEL,
          answers: {
            engagement: {
              type: "choice",
              choice: "silent",
              confidence: 0.9,
              probabilities: { continue: 0.05, join: 0.9, silent: 0.05 },
            },
          },
          usage: { input_tokens: 100 },
        }),
      ),
    );

    await expect(
      new EngagementEvaluator(fetchMock).evaluate(evaluateInput()),
    ).resolves.toMatchObject({ errorCategory: "invalid_response", choice: null });
  });

  it("cancels an unread error response body", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("rate limited"));
          },
          cancel,
        }),
        { status: 429 },
      ),
    );

    await expect(
      new EngagementEvaluator(fetchMock).evaluate(evaluateInput()),
    ).resolves.toMatchObject({ errorCategory: "http_429", choice: null });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("sends distinct decision criteria for all three engagement styles", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jevResponse("silent"));
    const evaluator = new EngagementEvaluator(fetchMock);
    for (const style of ["natural", "assistant", "filter"] as const) {
      await evaluator.evaluate(evaluateInput({ policy: { ...policy, style } }));
    }

    const criteria = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: { engagement: { criteria: unknown } };
      };
      return body.questions.engagement.criteria;
    });
    expect(new Set(criteria.map((value) => JSON.stringify(value))).size).toBe(3);
  });

  it("returns on timeout, suppresses the late result, and keeps the in-flight slot bounded", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(jevResponse());
    const evaluator = new EngagementEvaluator(fetchMock, 1);

    await expect(
      evaluator.evaluate(evaluateInput({ policy: { ...policy, timeoutMs: 5 } })),
    ).resolves.toMatchObject({ errorCategory: "timeout" });
    await expect(evaluator.evaluate(evaluateInput())).resolves.toMatchObject({
      errorCategory: "overloaded",
    });

    release(jevResponse("join"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(evaluator.evaluate(evaluateInput())).resolves.toMatchObject({
      choice: "continue",
    });
  });
});
