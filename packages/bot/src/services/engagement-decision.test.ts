import {
  DEFAULT_ENGAGEMENT_POLICY,
  ENGAGEMENT_MODEL,
  type AiTriggerConfig,
  type EngagementPolicy,
  type EngagementSample,
  type UserPrivacyMode,
} from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import {
  decideEngagement,
  type EngagementDecisionDeps,
  type EngagementDecisionInput,
  type TriggerResult,
} from "./engagement-decision.js";
import { selectEngagementContext } from "./engagement-evaluator.js";

vi.mock("./engagement-evaluator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engagement-evaluator.js")>();
  return { ...actual, selectEngagementContext: vi.fn(actual.selectEngagementContext) };
});

const NOW = 1_700_000_000_000;
const BOT = { id: 99, first_name: "Ai", username: "sample_bot" };
const WAKE = { text: "wake up", triggerConfig: { triggerWords: ["wake"] } };
const MENTIONED = {
  text: "  @sample_bot",
  entities: [{ type: "mention" as const, offset: 2, length: 11 }],
};
const TEXT_MENTION = {
  entities: [
    { type: "text_mention" as const, offset: 0, length: 2, user: { ...BOT, is_bot: true } },
  ],
};
const RANDOM = { triggerConfig: { randomReplyPercent: 50, randomReplyCooldown: 60 } };
const REPLY = { replyToUserId: BOT.id };
const SHADOW = { policy: { mode: "shadow" as const } };
const OFF = { policy: { mode: "off" as const } };
const DIRECT = { policy: { keywordDirect: true } };

const VERDICTS = {
  silent: { choice: "silent", engagement: "silent", reasonCode: "jev_silent" },
  below: { choice: "join", engagement: "silent", reasonCode: "below_threshold" },
  join: { choice: "join", engagement: "answer", reasonCode: "jev_answer" },
  continue: { choice: "continue", engagement: "answer", reasonCode: "jev_answer" },
  addressed: { choice: "join", addressed: true, engagement: "answer", reasonCode: "jev_answer" },
  error: { choice: null, engagement: "silent", reasonCode: "network", errorCategory: "network" },
} satisfies Record<string, Partial<EngagementSample>>;
type Verdict = keyof typeof VERDICTS;

interface Scenario extends Partial<Omit<EngagementDecisionInput, "policy" | "triggerConfig">> {
  /** Null models a private chat, which has no engagement policy. */
  policy?: Partial<EngagementPolicy> | null;
  triggerConfig?: Partial<AiTriggerConfig>;
}

interface HarnessOptions {
  verdict?: Verdict;
  evaluate?: EngagementDecisionDeps["evaluate"];
  gate?: "timeout" | "stopped";
  stopDuringEvaluation?: boolean;
  privacy?: Record<number, UserPrivacyMode | Error>;
  resetAt?: Record<number, number | Error>;
  lastRandomReplyAt?: number;
  lastEngagementAt?: number;
  roll?: number;
  onSample?: false | ((sample: EngagementSample) => Promise<void>);
}

function input({ policy, triggerConfig, ...overrides }: Scenario = {}): EngagementDecisionInput {
  return {
    chatId: -100,
    messageId: 1,
    userId: 42,
    isPrivate: false,
    aiDisabled: false,
    privacyMode: "normal",
    text: "group message",
    entities: [],
    bot: BOT,
    triggerConfig: {
      replyToBot: false,
      mentionBot: false,
      triggerWords: [],
      randomReplyPercent: 0,
      randomReplyCooldown: 60,
      ...triggerConfig,
    },
    policy:
      policy === null ? undefined : { ...DEFAULT_ENGAGEMENT_POLICY, mode: "active", ...policy },
    apiKey: "jev-key",
    capturedAt: NOW,
    source: { privacyUserIds: [42], verifiable: true },
    bufferedContext: [],
    ...overrides,
  };
}

function jevSample(verdict: Verdict): EngagementSample {
  return {
    chatId: -100,
    messageId: 1,
    mode: "active",
    style: "natural",
    confidence: 0.9,
    probabilities: null,
    actualTrigger: null,
    model: ENGAGEMENT_MODEL,
    configVersion: "test",
    configSnapshot: DEFAULT_ENGAGEMENT_POLICY,
    latencyMs: 5,
    inputTokens: 10,
    estimatedCostUsd: 0,
    context: [],
    ...VERDICTS[verdict],
  };
}

function botUtterance(ageMs: number) {
  return { messageId: 7, userId: BOT.id, text: "bot reply", timestamp: NOW - ageMs, isBot: true };
}

function harness(options: HarnessOptions = {}) {
  let stopped = false;
  const gate = {
    deadlineAt: NOW + 1_000,
    race: async <T>(operation: Promise<T>) => {
      if (options.gate === "stopped") stopped = true;
      return options.gate ? undefined : operation;
    },
    isStopped: () => stopped,
    finish: vi.fn(),
  };
  const onSample = vi.fn<(sample: EngagementSample) => Promise<void>>(
    options.onSample || (async () => {}),
  );
  const deps = {
    evaluate: vi.fn<EngagementDecisionDeps["evaluate"]>(
      options.evaluate ??
        (async () => {
          if (options.stopDuringEvaluation) stopped = true;
          return jevSample(options.verdict ?? "join");
        }),
    ),
    openGate: vi.fn<EngagementDecisionDeps["openGate"]>(() => gate),
    privacy: {
      getMode: vi.fn(async (userId: number): Promise<UserPrivacyMode> => {
        const mode = options.privacy?.[userId] ?? "normal";
        if (mode instanceof Error) throw mode;
        return mode;
      }),
      getContextResetAt: (userId: number) => {
        const resetAt = options.resetAt?.[userId];
        if (resetAt instanceof Error) throw resetAt;
        return resetAt;
      },
    },
    cooldowns: {
      lastRandomReplyAt: () => options.lastRandomReplyAt,
      startRandomReply: vi.fn(),
      lastEngagementAt: vi.fn(() => options.lastEngagementAt),
    },
    onSample: options.onSample === false ? undefined : onSample,
    onLog: vi.fn(),
    now: () => NOW,
    random: vi.fn(() => options.roll ?? 0.5),
  } satisfies EngagementDecisionDeps;
  return { deps, gate, onSample };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function run(scenario: Scenario = {}, options: HarnessOptions = {}) {
  const tools = harness(options);
  const decision = await decideEngagement(input(scenario), tools.deps);
  decision.finalizeSample(decision.trigger);
  await flush();
  return { ...tools, decision, recorded: tools.onSample.mock.calls[0]?.[0] };
}

describe("decideEngagement", () => {
  it.each<[string, Scenario, HarnessOptions, TriggerResult]>([
    ["private chats always reply", { isPrivate: true, policy: null, ...RANDOM }, {}, "reply"],
    ["off mode keeps the legacy keyword", { ...WAKE, ...OFF }, {}, "keyword"],
    ["a stopped bot still reports legacy triggers", { ...WAKE, aiDisabled: true }, {}, "keyword"],
    ["active mode answers an entity mention", MENTIONED, {}, "mention"],
    ["active mode answers a text mention", TEXT_MENTION, {}, "mention"],
    ["active mode answers a reply to the bot", REPLY, {}, "reply"],
    ["shadow mode keeps legacy rules for a mention", { ...MENTIONED, ...SHADOW }, {}, false],
    ["active privacy off stays silent", { ...WAKE, privacyMode: "off" }, {}, false],
    ["shadow privacy off drops the keyword", { ...WAKE, ...SHADOW, privacyMode: "off" }, {}, false],
    ["privacy off still answers a mention", { ...MENTIONED, privacyMode: "off" }, {}, "mention"],
    ["shadow mode without a sink skips", { ...WAKE, ...SHADOW }, { onSample: false }, "keyword"],
    ["filter style needs a legacy candidate", { policy: { style: "filter" } }, {}, false],
    ["whitespace-only text stays silent", { text: "   " }, {}, false],
    ["unverifiable text", { source: { privacyUserIds: [], verifiable: false } }, {}, false],
  ])("%s without asking JEV", async (_name, scenario, options, trigger) => {
    const { decision, deps, onSample } = await run(scenario, options);

    expect(decision).toMatchObject({ trigger, commitsCooldown: false });
    expect(deps.openGate).not.toHaveBeenCalled();
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(deps.random).not.toHaveBeenCalled();
    expect(onSample).not.toHaveBeenCalled();
  });

  it.each<[string, Scenario, TriggerResult]>([
    ["a reply to the bot", { ...REPLY, triggerConfig: { replyToBot: true } }, "reply"],
    ["no reply with replyToBot off", REPLY, false],
    ["any-case usernames", { text: "@Sample_Bot", triggerConfig: { mentionBot: true } }, "mention"],
    ["any-case keywords", { text: "WAKE", triggerConfig: { triggerWords: ["Wake"] } }, "keyword"],
  ])("legacy rules detect %s", async (_name, scenario, trigger) => {
    const { decision } = await run({ ...scenario, ...OFF });

    expect(decision.trigger).toBe(trigger);
  });

  it.each<[string, number, number | undefined, TriggerResult]>([
    ["wins below the configured percentage", 0.49, undefined, "random"],
    ["loses at the configured percentage", 0.5, undefined, false],
    ["waits out its cooldown", 0, 59_999, false],
    ["rolls again once the cooldown ends", 0, 60_000, "random"],
  ])("a legacy random roll %s", async (_name, roll, rolledAgoMs, trigger) => {
    const lastRandomReplyAt = rolledAgoMs === undefined ? undefined : NOW - rolledAgoMs;
    const { decision, deps } = await run({ ...RANDOM, ...OFF }, { roll, lastRandomReplyAt });

    expect(decision.trigger).toBe(trigger);
    expect(deps.cooldowns.startRandomReply.mock.calls).toEqual(trigger ? [[NOW]] : []);
  });

  it.each<[Verdict, TriggerResult, boolean, string]>([
    ["silent", false, false, "jev_silent"],
    ["below", false, false, "below_threshold"],
    ["join", "engagement_join", true, "jev_answer"],
    ["continue", "engagement_continue", true, "jev_answer"],
    ["addressed", "engagement_addressed", false, "jev_answer"],
    ["error", false, false, "network"],
  ])("routes a %s verdict outside cooldown to %s", async (verdict, trigger, commits, reason) => {
    const { decision, deps, gate, recorded } = await run({}, { verdict });

    expect(decision).toMatchObject({ trigger, commitsCooldown: commits });
    expect(deps.evaluate).toHaveBeenCalledOnce();
    expect(gate.finish).toHaveBeenCalledOnce();
    expect(recorded).toMatchObject({ reasonCode: reason, actualTrigger: trigger || null });
  });

  it.each<[string, Verdict, number, number | undefined, number, TriggerResult, boolean]>([
    ["a join as cooldown ends", "join", 60_000, undefined, 120, "engagement_join", true],
    ["a join in cooldown", "join", 59_999, undefined, 120, false, false],
    ["a continuation at the edge", "continue", 1_000, 120_000, 120, "engagement_continue", false],
    ["a continuation past the window", "continue", 1_000, 120_001, 120, false, false],
    ["a continuation with window off", "continue", 1_000, 0, 0, false, false],
    ["an address in cooldown", "addressed", 1_000, undefined, 120, "engagement_addressed", false],
  ])(
    "applies the cooldown to %s",
    async (_name, verdict, engagedAgoMs, botAgoMs, windowSeconds, trigger, commits) => {
      const { decision, recorded } = await run(
        {
          policy: { continuationWindowSeconds: windowSeconds },
          bufferedContext: botAgoMs === undefined ? [] : [botUtterance(botAgoMs)],
        },
        { verdict, lastEngagementAt: NOW - engagedAgoMs },
      );

      expect(decision).toMatchObject({ trigger, commitsCooldown: commits });
      expect(recorded).toMatchObject({
        reasonCode: trigger ? "jev_answer" : "engagement_cooldown",
        actualTrigger: trigger || null,
      });
    },
  );

  it.each<[Verdict, TriggerResult]>([
    ["error", "random"],
    ["silent", false],
  ])("starts a won random roll's cooldown before JEV answers %s", async (verdict, trigger) => {
    const { deps } = harness({ verdict, roll: 0 });

    const pending = decideEngagement(input(RANDOM), deps);

    expect(deps.cooldowns.startRandomReply).toHaveBeenCalledWith(NOW);
    expect(deps.cooldowns.startRandomReply.mock.invocationCallOrder[0]).toBeLessThan(
      deps.openGate.mock.invocationCallOrder[0]!,
    );
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect((await pending).trigger).toBe(trigger);
    expect(deps.random).toHaveBeenCalledOnce();
  });

  it("reads the engagement cooldown only after JEV answers", async () => {
    let release!: (sample: EngagementSample) => void;
    const { deps } = harness({
      lastEngagementAt: NOW - 1_000,
      evaluate: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const pending = decideEngagement(input(), deps);
    await vi.waitFor(() => expect(deps.evaluate).toHaveBeenCalledOnce());

    expect(deps.cooldowns.lastEngagementAt).not.toHaveBeenCalled();
    release(jevSample("join"));
    expect((await pending).trigger).toBe(false);
    expect(deps.cooldowns.lastEngagementAt).toHaveBeenCalledOnce();
    expect(deps.cooldowns.lastEngagementAt.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.evaluate.mock.invocationCallOrder[0]!,
    );
  });

  it.each<[string, Scenario, number, string | undefined]>([
    ["a keywordDirect keyword", { ...WAKE, ...DIRECT }, 0, "keyword_direct"],
    ["a keywordDirect random roll", { ...RANDOM, ...DIRECT }, 1, "jev_silent"],
    ["a filter-style trigger word", { ...WAKE, policy: { style: "filter" } }, 1, "jev_silent"],
  ])("asks JEV about %s only when required", async (_name, scenario, evaluations, reasonCode) => {
    const { deps, recorded } = await run(scenario, { verdict: "silent", roll: 0 });

    expect(deps.evaluate).toHaveBeenCalledTimes(evaluations);
    expect(recorded?.reasonCode).toBe(reasonCode);
  });

  it("returns the legacy trigger in shadow mode while its sample is pending", async () => {
    let release!: (sample: EngagementSample) => void;
    const { deps, gate, onSample } = harness({
      evaluate: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const decision = await decideEngagement(input({ ...WAKE, policy: { mode: "shadow" } }), deps);
    decision.finalizeSample("keyword");
    await vi.waitFor(() => expect(deps.evaluate).toHaveBeenCalledOnce());

    expect(decision).toMatchObject({ trigger: "keyword", commitsCooldown: false });
    expect(gate.finish).toHaveBeenCalledOnce();
    expect(onSample).not.toHaveBeenCalled();
    release(jevSample("join"));
    await vi.waitFor(() => expect(onSample).toHaveBeenCalledOnce());
    const [sample] = onSample.mock.calls[0]!;
    expect(sample).toMatchObject({ reasonCode: "jev_answer", actualTrigger: "keyword" });
  });

  it.each(["active", "shadow"] as const)("%s timeouts keep the legacy trigger", async (mode) => {
    const { decision, deps, recorded } = await run(
      { ...WAKE, policy: { mode } },
      { gate: "timeout" },
    );

    expect(decision.trigger).toBe("keyword");
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(recorded).toMatchObject({
      errorCategory: "timeout",
      context: [],
      actualTrigger: "keyword",
    });
  });

  it.each(["active", "shadow"] as const)(
    "stays silent without a sample when /stop ends %s preparation",
    async (mode) => {
      const { decision, deps, gate, onSample } = await run(
        { policy: { mode } },
        { gate: "stopped" },
      );

      expect(decision.trigger).toBe(false);
      expect(deps.evaluate).not.toHaveBeenCalled();
      expect(gate.finish).toHaveBeenCalledOnce();
      expect(onSample).not.toHaveBeenCalled();
    },
  );

  it("records the verdict but stays silent when /stop lands during evaluation", async () => {
    const { decision, recorded } = await run({}, { stopDuringEvaluation: true });

    expect(decision).toMatchObject({ trigger: false, commitsCooldown: false });
    expect(recorded).toMatchObject({ reasonCode: "jev_answer", actualTrigger: null });
  });

  it("stays silent when the current author opted out after ingress", async () => {
    const { decision, deps } = await run({}, { privacy: { 42: "off" } });

    expect(decision.trigger).toBe(false);
    expect(deps.evaluate).not.toHaveBeenCalled();
  });

  it("sends JEV only context whose authors still allow it", async () => {
    const { deps } = await run(
      {
        triggerConfig: { triggerWords: ["助手"] },
        bufferedContext: [
          { messageId: 2, userId: 43, text: "opted out", timestamp: NOW - 1_000 },
          { messageId: 3, userId: 44, text: "forgotten", timestamp: NOW - 2_000 },
          { messageId: 4, userId: 46, text: "lookup failed", timestamp: NOW - 2_500 },
          { messageId: 5, userId: 47, text: "kept", timestamp: NOW - 3_000 },
          botUtterance(4_000),
        ],
        replyContext: { messageId: 6, userId: 45, text: "opted-out reply", timestamp: NOW - 500 },
      },
      {
        verdict: "silent",
        privacy: { 43: "off", 45: "off", 46: new Error("privacy store down") },
        resetAt: { 44: NOW - 2_000 },
      },
    );

    expect(deps.openGate).toHaveBeenCalledWith(DEFAULT_ENGAGEMENT_POLICY.timeoutMs);
    expect(deps.evaluate).toHaveBeenCalledWith({
      apiKey: "jev-key",
      assistantIdentity: { displayName: "Ai", username: "sample_bot", triggerWords: ["助手"] },
      policy: expect.objectContaining({ mode: "active" }),
      context: [
        expect.objectContaining({ messageId: 7, isBot: true }),
        expect.objectContaining({ messageId: 5, text: "kept" }),
        expect.objectContaining({ messageId: 1, text: "group message", privacyUserIds: [42] }),
      ],
      chatId: -100,
      messageId: 1,
      currentMessageId: 1,
      replyMessageId: undefined,
      deadlineAt: NOW + 1_000,
    });
  });

  it("propagates a synchronous context-reset lookup failure in active mode", async () => {
    const { deps, gate } = harness({ resetAt: { 42: new Error("reset lookup failed") } });

    await expect(decideEngagement(input(), deps)).rejects.toThrow("reset lookup failed");
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(gate.finish).toHaveBeenCalledOnce();
  });

  it("propagates a context selection failure in active mode", async () => {
    vi.mocked(selectEngagementContext).mockImplementationOnce(() => {
      throw new Error("context selection failed");
    });
    const { deps, gate } = harness();

    await expect(decideEngagement(input(), deps)).rejects.toThrow("context selection failed");
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(gate.finish).toHaveBeenCalledOnce();
  });

  it("logs and records the sample with the turn's final outcome", async () => {
    const { deps, onSample } = harness();
    const decision = await decideEngagement(input(), deps);

    decision.finalizeSample(false, "usage_denied");
    await flush();

    expect(deps.onLog).toHaveBeenCalledWith({
      level: "info",
      message: "JEV engagement decision",
      meta: {
        mode: "active",
        style: "natural",
        choice: "join",
        recommendation: "answer",
        addressed: undefined,
        actualTrigger: null,
        confidence: 0.9,
        probabilities: null,
        reasonCode: "usage_denied",
        errorCategory: undefined,
        model: ENGAGEMENT_MODEL,
        configVersion: "test",
        latencyMs: 5,
        inputTokens: 10,
        estimatedCostUsd: 0,
        contextMessages: 0,
      },
    });
    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "usage_denied", actualTrigger: null }),
    );
  });

  it("warns when the sample sink rejects", async () => {
    const onSample = () => Promise.reject(new Error("sample store down"));
    const { deps } = await run({}, { onSample });

    expect(deps.onLog).toHaveBeenCalledWith({
      level: "warn",
      message: "Failed to record engagement sample",
      meta: { chatId: -100, messageId: 1, error: "sample store down" },
    });
  });

  it("neither logs nor records a sample without a sink", async () => {
    const { decision, deps } = await run({}, { onSample: false });

    expect(decision.trigger).toBe("engagement_join");
    expect(deps.onLog).not.toHaveBeenCalled();
  });
});
