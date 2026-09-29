import type {
  AiTriggerConfig,
  BotLogEntry,
  EngagementPolicy,
  EngagementSample,
  UserPrivacyCallbacks,
  UserPrivacyMode,
} from "@cos-tool-bot/shared";
import type { MessageEntity } from "grammy/types";
import {
  createLocalEngagementErrorSample,
  createLocalEngagementSample,
  selectEngagementContext,
  type EngagementContextCandidate,
  type EvaluateEngagementInput,
} from "./engagement-evaluator.js";

export type TriggerResult =
  | "reply"
  | "mention"
  | "keyword"
  | "random"
  | "engagement_continue"
  | "engagement_addressed"
  | "engagement_join"
  | false;

export interface EngagementDecisionInput {
  chatId: number;
  messageId: number;
  userId: number;
  isPrivate: boolean;
  /** Legacy triggers still roll while /stop is active. */
  aiDisabled: boolean;
  /** "off" admits only explicit reply and mention triggers. */
  privacyMode: UserPrivacyMode;
  /** Text or caption exactly as sent; entity offsets index into it. */
  text: string;
  entities: readonly MessageEntity[];
  replyToUserId?: number;
  bot: { id: number; first_name: string; username?: string };
  triggerConfig: AiTriggerConfig;
  /** Absent for private chats. */
  policy?: EngagementPolicy;
  apiKey?: string;
  capturedAt: number;
  /** Unverifiable text never reaches JEV. */
  source: { privacyUserIds: number[]; verifiable: boolean };
  /** The topic buffer at ingress; its bot utterances open the continuation window. */
  bufferedContext: readonly EngagementContextCandidate[];
  replyContext?: EngagementContextCandidate;
}

export interface EngagementDecisionGate {
  /** Shared by privacy preparation and the JEV request so both fit the policy budget. */
  readonly deadlineAt: number;
  /** Resolves undefined when the gate stops or expires before the operation settles. */
  race<T>(operation: Promise<T>): Promise<T | undefined>;
  /** Whether /stop invalidated the gate after it opened. */
  isStopped(): boolean;
  finish(): void;
}

export interface EngagementCooldowns {
  lastRandomReplyAt(): number | undefined;
  /** Called as soon as a random roll wins, even when the gate later vetoes the reply. */
  startRandomReply(at: number): void;
  /** Read after JEV answers; the caller commits it once the reply is admitted. */
  lastEngagementAt(): number | undefined;
}

export interface EngagementDecisionDeps {
  evaluate(input: EvaluateEngagementInput): Promise<EngagementSample>;
  openGate(timeoutMs: number): EngagementDecisionGate;
  privacy?: Pick<UserPrivacyCallbacks, "getMode" | "getContextResetAt">;
  cooldowns: EngagementCooldowns;
  /** Captured when the decision starts; without it shadow mode skips privacy lookups and JEV. */
  onSample?: (sample: EngagementSample) => void | Promise<void>;
  onLog(entry: BotLogEntry): void;
  now(): number;
  random(): number;
}

export interface EngagementDecision {
  trigger: TriggerResult;
  /** Start the topic's proactive cooldown once this reply is admitted. */
  commitsCooldown: boolean;
  /** Logs and records the JEV sample, if one was taken, with the turn's actual outcome. */
  finalizeSample(actualTrigger: string | false, finalReasonCode?: string): void;
}

interface GateOutcome {
  trigger: TriggerResult;
  sample?: Promise<EngagementSample | undefined>;
  commitsCooldown?: boolean;
}

interface PreparedEvaluation {
  contextSnapshot: EngagementContextCandidate[];
  evaluationInput: EvaluateEngagementInput;
}

/**
 * Decides whether the bot speaks for one message. Callers hold the chat's ingress lock, so
 * decisions in one chat never interleave. Active mode awaits privacy preparation and JEV within
 * the policy timeout; shadow mode returns the legacy trigger while its sample is still pending.
 */
export async function decideEngagement(
  input: EngagementDecisionInput,
  deps: EngagementDecisionDeps,
): Promise<EngagementDecision> {
  const legacyTrigger = input.isPrivate ? "reply" : checkLegacyTrigger(input, deps);
  const { policy } = input;
  const outcome: GateOutcome =
    !input.isPrivate && !input.aiDisabled && policy && policy.mode !== "off"
      ? await runEngagementGate(input, policy, legacyTrigger, deps)
      : { trigger: legacyTrigger };
  const trigger =
    input.privacyMode === "off" && outcome.trigger !== "reply" && outcome.trigger !== "mention"
      ? false
      : outcome.trigger;
  return {
    trigger,
    commitsCooldown: outcome.commitsCooldown ?? false,
    finalizeSample: (actualTrigger, finalReasonCode) =>
      recordSample(outcome.sample, input, deps, actualTrigger, finalReasonCode),
  };
}

function checkLegacyTrigger(
  input: EngagementDecisionInput,
  deps: EngagementDecisionDeps,
): TriggerResult {
  const { text, triggerConfig, bot } = input;

  if (triggerConfig.replyToBot && input.replyToUserId === bot.id) {
    return "reply";
  }

  if (triggerConfig.mentionBot && bot.username) {
    if (text.toLowerCase().includes(`@${bot.username.toLowerCase()}`)) {
      return "mention";
    }
  }

  if (triggerConfig.triggerWords.length > 0) {
    const lowerText = text.toLowerCase();
    if (triggerConfig.triggerWords.some((w) => lowerText.includes(w.toLowerCase()))) {
      return "keyword";
    }
  }

  if (triggerConfig.randomReplyPercent > 0) {
    const now = deps.now();
    const lastTime = deps.cooldowns.lastRandomReplyAt() ?? 0;
    const cooldownMs = triggerConfig.randomReplyCooldown * 1000;
    if (now - lastTime >= cooldownMs) {
      if (deps.random() * 100 < triggerConfig.randomReplyPercent) {
        deps.cooldowns.startRandomReply(now);
        return "random";
      }
    }
  }

  return false;
}

function detectExplicitTrigger(input: EngagementDecisionInput): "reply" | "mention" | false {
  const { bot, text } = input;
  if (input.replyToUserId === bot.id) return "reply";
  for (const entity of input.entities) {
    if (entity.type === "text_mention" && entity.user.id === bot.id) return "mention";
    if (
      entity.type === "mention" &&
      bot.username &&
      text.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
        `@${bot.username.toLowerCase()}`
    ) {
      return "mention";
    }
  }
  return false;
}

async function runEngagementGate(
  input: EngagementDecisionInput,
  policy: EngagementPolicy,
  legacyTrigger: TriggerResult,
  deps: EngagementDecisionDeps,
): Promise<GateOutcome> {
  const explicitTrigger = detectExplicitTrigger(input);
  if (explicitTrigger) {
    return { trigger: policy.mode === "active" ? explicitTrigger : legacyTrigger };
  }
  if (input.privacyMode === "off") {
    return { trigger: policy.mode === "active" ? false : legacyTrigger };
  }
  if (policy.mode === "shadow" && !deps.onSample) return { trigger: legacyTrigger };

  const current: EngagementContextCandidate = {
    messageId: input.messageId,
    userId: input.userId,
    text: input.text.trim(),
    timestamp: input.capturedAt,
    privacyUserIds: input.source.privacyUserIds,
  };
  const isFilterCandidate = legacyTrigger === "keyword" || legacyTrigger === "random";
  const shouldEvaluate =
    !!current.text && input.source.verifiable && (policy.style !== "filter" || isFilterCandidate);

  if (policy.mode === "shadow") {
    return {
      trigger: legacyTrigger,
      ...(shouldEvaluate ? { sample: sampleInShadow(input, policy, current, deps) } : {}),
    };
  }
  if (!shouldEvaluate) return { trigger: false };

  const gate = deps.openGate(policy.timeoutMs);
  try {
    const prepared = await gate.race(prepareEvaluation(input, policy, current, gate, deps));
    if (prepared === null) return { trigger: false };
    if (prepared === undefined) {
      return gate.isStopped()
        ? { trigger: false }
        : {
            trigger: legacyTrigger,
            sample: Promise.resolve(preparationTimeoutSample(input, policy)),
          };
    }
    if (policy.keywordDirect && legacyTrigger === "keyword") {
      return {
        trigger: "keyword",
        sample: Promise.resolve(
          createLocalEngagementSample(prepared.evaluationInput, "join", "keyword_direct"),
        ),
      };
    }
    const sample = await deps.evaluate(prepared.evaluationInput);
    if (gate.isStopped()) return { trigger: false, sample: Promise.resolve(sample) };
    return admitSample(sample, prepared.contextSnapshot, policy, legacyTrigger, deps);
  } finally {
    gate.finish();
  }
}

async function sampleInShadow(
  input: EngagementDecisionInput,
  policy: EngagementPolicy,
  current: EngagementContextCandidate,
  deps: EngagementDecisionDeps,
): Promise<EngagementSample | undefined> {
  const gate = deps.openGate(policy.timeoutMs);
  try {
    const prepared = await gate.race(prepareEvaluation(input, policy, current, gate, deps));
    if (prepared) return deps.evaluate(prepared.evaluationInput);
    return prepared === undefined && !gate.isStopped()
      ? preparationTimeoutSample(input, policy)
      : undefined;
  } finally {
    gate.finish();
  }
}

function admitSample(
  sample: EngagementSample,
  contextSnapshot: readonly EngagementContextCandidate[],
  policy: EngagementPolicy,
  legacyTrigger: TriggerResult,
  deps: EngagementDecisionDeps,
): GateOutcome {
  if (sample.errorCategory) return { trigger: legacyTrigger, sample: Promise.resolve(sample) };
  if (sample.engagement !== "answer" || sample.choice === "silent") {
    return { trigger: false, sample: Promise.resolve(sample) };
  }
  const continuationWindowMs = Math.max(0, policy.continuationWindowSeconds) * 1_000;
  const recentBotUtterance =
    continuationWindowMs > 0 &&
    contextSnapshot.some(
      (message) => message.isBot && deps.now() - message.timestamp <= continuationWindowMs,
    );
  const skipsCooldown =
    sample.addressed === true || (sample.choice === "continue" && recentBotUtterance);
  const lastEngagement = deps.cooldowns.lastEngagementAt() ?? 0;
  const cooldownMs = Math.max(0, policy.cooldownSeconds) * 1000;
  if (!skipsCooldown && deps.now() - lastEngagement < cooldownMs) {
    return {
      trigger: false,
      sample: Promise.resolve({ ...sample, reasonCode: "engagement_cooldown" }),
    };
  }
  return {
    trigger: sample.addressed
      ? "engagement_addressed"
      : sample.choice === "continue"
        ? "engagement_continue"
        : "engagement_join",
    sample: Promise.resolve(sample),
    commitsCooldown: !skipsCooldown,
  };
}

function contributorIds(message: EngagementContextCandidate): number[] {
  return message.privacyUserIds ?? (!message.isBot ? [message.userId] : []);
}

async function prepareEvaluation(
  input: EngagementDecisionInput,
  policy: EngagementPolicy,
  current: EngagementContextCandidate,
  gate: EngagementDecisionGate,
  deps: EngagementDecisionDeps,
): Promise<PreparedEvaluation | null> {
  const privacyByUser = new Map<number, UserPrivacyMode>();
  const contextUserIds = [
    ...new Set(
      [current, ...input.bufferedContext, input.replyContext].flatMap((message) =>
        message ? contributorIds(message) : [],
      ),
    ),
  ];
  await Promise.all(
    contextUserIds.map(async (contextUserId) => {
      try {
        privacyByUser.set(contextUserId, (await deps.privacy?.getMode(contextUserId)) ?? "normal");
      } catch {
        privacyByUser.set(contextUserId, "off");
      }
    }),
  );
  const isPrivacySafe = (message: EngagementContextCandidate) =>
    contributorIds(message).every((contextUserId) => {
      const resetAt = deps.privacy?.getContextResetAt?.(contextUserId);
      return (
        privacyByUser.get(contextUserId) !== "off" &&
        (resetAt === undefined || (message.privacyCapturedAt ?? message.timestamp) > resetAt)
      );
    });
  if (!isPrivacySafe(current)) return null;
  const contextSnapshot = input.bufferedContext.filter(isPrivacySafe);
  const reply =
    input.replyContext && isPrivacySafe(input.replyContext) ? input.replyContext : undefined;
  return {
    contextSnapshot,
    evaluationInput: {
      apiKey: input.apiKey,
      assistantIdentity: {
        displayName: input.bot.first_name,
        username: input.bot.username,
        triggerWords: input.triggerConfig.triggerWords,
      },
      policy,
      context: selectEngagementContext({
        messages: contextSnapshot,
        current,
        reply,
        maxMessages: policy.contextMessages,
        now: deps.now(),
      }),
      chatId: input.chatId,
      messageId: input.messageId,
      currentMessageId: input.messageId,
      replyMessageId: reply?.messageId,
      deadlineAt: gate.deadlineAt,
    },
  };
}

function preparationTimeoutSample(
  input: EngagementDecisionInput,
  policy: EngagementPolicy,
): EngagementSample {
  return createLocalEngagementErrorSample(
    {
      policy,
      context: [],
      chatId: input.chatId,
      messageId: input.messageId,
      currentMessageId: input.messageId,
    },
    "timeout",
  );
}

function recordSample(
  sample: Promise<EngagementSample | undefined> | undefined,
  input: EngagementDecisionInput,
  deps: EngagementDecisionDeps,
  actualTrigger: string | false,
  finalReasonCode?: string,
): void {
  const { onSample } = deps;
  if (!sample || !onSample) return;
  void sample
    .then((recorded) => {
      if (!recorded) return;
      deps.onLog({
        level: recorded.errorCategory ? "warn" : "info",
        message: "JEV engagement decision",
        meta: {
          mode: recorded.mode,
          style: recorded.style,
          choice: recorded.choice,
          recommendation: recorded.engagement,
          addressed: recorded.addressed,
          actualTrigger: actualTrigger || null,
          confidence: recorded.confidence,
          probabilities: recorded.probabilities,
          reasonCode: finalReasonCode ?? recorded.reasonCode,
          errorCategory: recorded.errorCategory,
          model: recorded.model,
          configVersion: recorded.configVersion,
          latencyMs: recorded.latencyMs,
          inputTokens: recorded.inputTokens,
          estimatedCostUsd: recorded.estimatedCostUsd,
          contextMessages: recorded.context.length,
        },
      });
      return onSample({
        ...recorded,
        ...(finalReasonCode ? { reasonCode: finalReasonCode } : {}),
        actualTrigger: actualTrigger || null,
      });
    })
    .catch((error) => {
      deps.onLog({
        level: "warn",
        message: "Failed to record engagement sample",
        meta: {
          chatId: input.chatId,
          messageId: input.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
}
